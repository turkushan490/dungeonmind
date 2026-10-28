import type { FastifyInstance } from 'fastify';
import { ABILITIES, type CharacterBuild, type GameCharacter, type GameSettings, type Npc, type Ruleset } from '@dungeonmind/shared';
import { requireUser } from '../auth/index.js';
import { db, json } from '../db.js';
import { applyDamage, applyDeltas, applyHeal, applySpend, applyXp, checkResources, damageNpc, healNpc, levelCheck, rest, type BookResult } from '../game/bookkeeper.js';
import { buildCharacter, derive, validateBuild } from '../game/character.js';
import { readLog } from '../game/log.js';
import { buildRolls, ready, resolveRoll, rollEffects, type Adjudication } from '../game/rolls.js';
import { DEFAULT_SETTINGS, loadGame, roleIn } from '../game/store.js';
import { sameName } from '../game/text.js';
import { mergeNpcs, type StateJson } from '../game/turn.js';
import { isRuleset, rules } from '../rules/index.js';

/**
 * The Bookkeeper as a service (M13): HiveMind's Lab sends a party and what its AI DM produced, and gets back
 * the server's verdict and the party after the turn. Stateless: nothing is stored.
 * Contract: docs/LAB_API.md.
 */

export type ErrorType = 'refused-resource' | 'unbacked-hp' | 'hp-mismatch' | 'unknown-character' | 'unknown-resource' | 'overspend' | 'gold' | 'missing-item' | 'invented-bonus' | 'bad-dice' | 'condition';

const NOTE_TYPES: [RegExp, ErrorType][] = [
  [/held back .* HP/, 'unbacked-hp'],
  [/corrected .* HP/, 'hp-mismatch'],
  [/unknown character/, 'unknown-character'],
  [/no such resource/, 'unknown-resource'],
  [/rejected .* spending \d+ [^g]/, 'overspend'],
  [/rejected .* gp|would gain .* gp/, 'gold'],
  [/not in the inventory/, 'missing-item'],
  [/not an SRD condition/, 'condition'],
];

/** A party member from the Lab: a full DungeonMind character, or a minimal {name, hp, maxHp, counters…}. */
export function normalizeMember(raw: Record<string, any>, i: number): GameCharacter {
  const abilities = Object.fromEntries(ABILITIES.map((a) => [a, Number(raw.abilities?.[a] ?? 10)]));
  return {
    ruleset: raw.ruleset ?? 'srd51',
    name: String(raw.name ?? `PC${i + 1}`),
    species: raw.species ?? 'human',
    class: raw.class ?? 'fighter',
    subclass: raw.subclass,
    background: raw.background ?? 'acolyte',
    level: Number(raw.level ?? 1),
    abilityMethod: raw.abilityMethod ?? 'manual',
    baseAbilities: raw.baseAbilities ?? abilities,
    skills: Array.isArray(raw.skills) ? raw.skills : [],
    cantrips: raw.cantrips ?? [],
    spells: raw.spells ?? [],
    id: String(raw.id ?? `lab-${i}`),
    ownerId: 'lab',
    userId: 'lab',
    seated: raw.seated !== false,
    absent: !!raw.absent,
    xp: Number(raw.xp ?? 0),
    abilities: abilities as GameCharacter['abilities'],
    hp: Number(raw.hp ?? raw.maxHp ?? 10),
    maxHp: Number(raw.maxHp ?? raw.hp ?? 10),
    tempHp: Number(raw.tempHp ?? 0),
    hitDie: Number(raw.hitDie ?? 8),
    saves: Array.isArray(raw.saves) ? raw.saves : [],
    counters: (Array.isArray(raw.counters) ? raw.counters : []).map((k: any) => ({ name: String(k.name), current: Number(k.current ?? k.max ?? 0), max: Number(k.max ?? k.current ?? 0), recharge: k.recharge ?? 'long', source: k.source })),
    conditions: (Array.isArray(raw.conditions) ? raw.conditions : []).map((c: any) => (typeof c === 'string' ? { name: c } : c)),
    concentration: raw.concentration,
    inventory: (Array.isArray(raw.inventory) ? raw.inventory : []).map((x: any) => (typeof x === 'string' ? { name: x, qty: 1 } : { name: String(x.name), qty: Number(x.qty ?? 1), equipped: !!x.equipped })),
    gold: Number(raw.gold ?? 0),
    deathSaves: raw.deathSaves ?? { success: 0, fail: 0 },
    exhaustion: Number(raw.exhaustion ?? 0),
  } as GameCharacter;
}

function typed(r: BookResult) {
  return r.notes.map((message) => ({ type: NOTE_TYPES.find(([re]) => re.test(message))?.[1] ?? ('condition' as ErrorType), message }));
}

export interface CheckInput {
  ruleset: Ruleset;
  party: Record<string, any>[];
  npcs?: Npc[];
  settings?: Partial<GameSettings>;
  adjudication?: Adjudication;
  state?: StateJson;
}

/** Runs one turn through the real Bookkeeper. */
export function bookkeeperCheck(input: CheckInput) {
  const r = rules(input.ruleset);
  const party = input.party.map(normalizeMember);
  let npcs: Npc[] = (input.npcs ?? []).map((n) => ({ ...n }));
  const settings: GameSettings = { ...DEFAULT_SETTINGS, endLevel: 20, ...(input.settings ?? {}) };
  const errors: { type: ErrorType; message: string; pc?: string }[] = [];
  const changes: string[] = [];
  let rolls: ReturnType<typeof buildRolls> = [];

  if (input.adjudication) {
    const adj = input.adjudication;
    const check = checkResources(party, adj.resources ?? []);
    for (const x of check.refused) errors.push({ type: 'refused-resource', message: x.reason, pc: party.find((c) => c.id === x.characterId)?.name });
    // The AI must never hand player characters a bonus: the sheet decides. A different number is an invented one.
    rolls = buildRolls(r, party, npcs, adj);
    for (const [i, raw] of (adj.rolls ?? []).entries()) {
      const built = rolls[i];
      if (built?.characterId && typeof raw?.bonus === 'number' && raw.bonus !== built.bonus && built.kind !== 'damage' && built.kind !== 'heal')
        errors.push({ type: 'invented-bonus', message: `${built.label}: the DM gave +${raw.bonus}, the sheet says ${built.bonus >= 0 ? '+' : ''}${built.bonus}`, pc: built.actor });
      if ((raw?.kind === 'damage' || raw?.kind === 'heal') && raw.dice && built?.dice !== raw.dice && !built?.characterId) errors.push({ type: 'bad-dice', message: `${built?.label ?? 'roll'}: "${raw.dice}" is not valid dice` });
    }
    changes.push(...applySpend(party, check.spend));
    for (let i = 0; i < 60; i++) {
      const next = rolls.find((x) => ready(x, rolls));
      if (!next) break;
      resolveRoll(next, rolls);
    }
  }
  if (input.state) {
    const s = input.state;
    if (Array.isArray(s.npcs)) npcs = mergeNpcs(npcs, s.npcs, new Set(rolls.filter((x) => (x.kind === 'damage' || x.kind === 'heal') && x.result && !x.result.skipped && x.target).map((x) => x.target!)));
  }
  const fx = rollEffects(rolls, party, npcs);
  const backed = new Map<string, number>();
  for (const [id, e] of fx.pcs) {
    const c = party.find((x) => x.id === id)!;
    if (e.damage) changes.push(...applyDamage(c, e.damage, { crit: e.crit, ruleset: input.ruleset }));
    if (e.heal) changes.push(...applyHeal(c, e.heal));
    backed.set(id, e.heal - e.damage);
  }
  for (const [name, e] of fx.foes) {
    const n = npcs.find((x) => x.name === name)!;
    if (e.damage) changes.push(damageNpc(n, e.damage));
    if (e.heal) changes.push(healNpc(n, e.heal));
  }
  let approvals: BookResult['approvals'] = [];
  if (input.state) {
    const d = applyDeltas(party, input.state.deltas ?? [], { backed, settings });
    const x = applyXp(party, input.state.xp ?? [], settings);
    changes.push(...d.changes, ...x.changes);
    errors.push(...typed(d), ...typed(x));
    approvals = [...d.approvals, ...x.approvals];
    // Choices for PCs that aren't at the table are a sign the DM lost track of the party.
    for (const k of Object.keys(input.state.choices ?? {})) if (!party.some((c) => sameName(c.name, k))) errors.push({ type: 'unknown-character', message: `Choices for "${k}", who is not in the party` });
  }
  const levelUps = levelCheck(party, settings.endLevel);
  return {
    ok: errors.length === 0,
    errors,
    errorTypes: [...new Set(errors.map((e) => e.type))],
    changes,
    approvals,
    levelUps,
    rolls: rolls.map((x) => ({ id: x.id, actor: x.actor, kind: x.kind, label: x.label, bonus: x.bonus, dc: x.dc, targetAc: x.targetAc, result: x.result })),
    party,
    npcs,
    derived: Object.fromEntries(party.map((c) => [c.name, derive(r, c)])),
  };
}

export function labRoutes(app: FastifyInstance) {
  app.get('/api/lab/bookkeeper', async () => ({
    ok: true,
    endpoints: ['POST /api/lab/bookkeeper/check', 'POST /api/lab/bookkeeper/rest', 'POST /api/lab/bookkeeper/character', 'GET /api/lab/games', 'GET /api/lab/games/:id/turns.jsonl'],
    errorTypes: ['refused-resource', 'unbacked-hp', 'hp-mismatch', 'unknown-character', 'unknown-resource', 'overspend', 'gold', 'missing-item', 'invented-bonus', 'bad-dice', 'condition'],
    docs: 'docs/LAB_API.md',
  }));

  app.post('/api/lab/bookkeeper/check', { preHandler: requireUser }, async (req, reply) => {
    const b = (req.body ?? {}) as CheckInput;
    if (!isRuleset(b.ruleset)) return reply.code(400).send({ error: 'ruleset is srd51 or srd52' });
    if (!Array.isArray(b.party) || !b.party.length || b.party.length > 12) return reply.code(400).send({ error: 'party is a list of 1-12 characters' });
    return bookkeeperCheck(b);
  });

  app.post('/api/lab/bookkeeper/rest', { preHandler: requireUser }, async (req, reply) => {
    const b = (req.body ?? {}) as { ruleset?: string; party?: Record<string, any>[]; kind?: string; hitDice?: Record<string, number> };
    if (!isRuleset(b.ruleset) || !Array.isArray(b.party) || (b.kind !== 'short' && b.kind !== 'long')) return reply.code(400).send({ error: 'Send ruleset, party and kind (short|long)' });
    const party = b.party.map(normalizeMember);
    const changes = rest(party, b.kind, b.ruleset, b.hitDice);
    return { changes, party };
  });

  /** A real, legal sheet for a fake player (the Lab's simulated party). */
  app.post('/api/lab/bookkeeper/character', { preHandler: requireUser }, async (req, reply) => {
    const b = req.body as CharacterBuild;
    if (!isRuleset(b?.ruleset)) return reply.code(400).send({ error: 'ruleset is srd51 or srd52' });
    const errors = validateBuild(rules(b.ruleset), b).filter((e) => !/server roll/.test(e));
    if (errors.length) return reply.code(400).send({ error: errors[0], errors });
    const c = buildCharacter(rules(b.ruleset), b, { id: `lab-${b.name}`, ownerId: 'lab' });
    return { character: c, derived: derive(rules(b.ruleset), c) };
  });

  // ---- Opt-in export of real games ----
  /** Games of yours (host) whose host opted in to the Lab. */
  app.get('/api/lab/games', { preHandler: requireUser }, async (req) =>
    (db.prepare("SELECT g.id, g.name, g.ruleset, g.settings, (SELECT COUNT(*) FROM lab_records r WHERE r.game_id = g.id) AS records FROM games g WHERE g.host_id = ?").all(req.user!.id) as Record<string, any>[])
      .filter((g) => json<GameSettings>(g.settings, DEFAULT_SETTINGS).labExport)
      .map((g) => ({ id: g.id, name: g.name, ruleset: g.ruleset, records: g.records })),
  );

  /**
   * One JSON line per DM call: {"messages":[system,user,assistant], "meta":{…, bookkeeper notes}} (chat SFT format).
   * The Bookkeeper's notes for that turn say what the DM got wrong.
   */
  app.get('/api/lab/games/:id/turns.jsonl', { preHandler: requireUser }, async (req, reply) => {
    const g = loadGame((req.params as { id: string }).id);
    if (!g || roleIn(g, req.user!) !== 'host') return reply.code(404).send({ error: 'Game not found' });
    if (!g.settings.labExport) return reply.code(403).send({ error: 'The host has not opted this game in to the Lab' });
    const notes = readLog(g.id, { limit: 1_000_000, kinds: ['note', 'refused'] });
    const rows = db.prepare('SELECT * FROM lab_records WHERE game_id = ? ORDER BY id').all(g.id) as Record<string, any>[];
    reply.header('content-type', 'application/x-ndjson; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="dungeonmind-${g.id}.jsonl"`);
    return rows
      .map((r) => {
        const vars = json<Record<string, string>>(r.vars, {});
        const outputs = json<Record<string, string>>(r.outputs, {});
        const turnNotes = notes.filter((n) => n.turn === r.turn).map((n) => n.text);
        return JSON.stringify({
          messages: [
            { role: 'system', content: `DungeonMind canvas ${r.canvas} (${g.ruleset}). Mode: ${vars.mode ?? '-'}.` },
            { role: 'user', content: `${r.question}\n\n${Object.entries(vars).filter(([k]) => k !== 'tableId').map(([k, v]) => `## ${k}\n${v}`).join('\n\n')}` },
            { role: 'assistant', content: Object.entries(outputs).map(([k, v]) => (Object.keys(outputs).length > 1 ? `## ${k}\n${v}` : v)).join('\n\n') },
          ],
          meta: { gameId: g.id, turn: r.turn, canvas: r.canvas, at: r.at, bookkeeper: turnNotes, ok: turnNotes.length === 0 },
        });
      })
      .join('\n');
  });
}
