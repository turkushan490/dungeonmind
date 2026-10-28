import type { FastifyInstance } from 'fastify';
import { XP_TABLE, type Abilities, type CharacterBuild, type Condition } from '@dungeonmind/shared';
import { requireUser } from '../auth/index.js';
import { tx } from '../db.js';
import { applyHeal, levelCheck, rest } from '../game/bookkeeper.js';
import { buildCharacter, buildOf, subclassLevel, validateBuild } from '../game/character.js';
import { rollDie } from '../game/dice.js';
import { playerRoll } from '../game/engine.js';
import { addLog, hideLogFrom } from '../game/log.js';
import { tally, voters } from '../game/rerolls.js';
import { broadcast, gameCharacters, loadGame, saveGame, saveGameCharacter } from '../game/store.js';
import { loadSnapshot, resolveLater } from '../game/turn.js';
import { rules } from '../rules/index.js';
import { gameFor } from './games.js';

export function bookkeepingRoutes(app: FastifyInstance) {
  // ---- Dice: 🎲 server rolls, or "I roll myself" with the real die values ----
  app.post('/api/games/:id/rolls/:rid', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'member');
    if (!r) return;
    const { mode, values } = (req.body ?? {}) as { mode?: 'server' | 'manual'; values?: number[] };
    const res = playerRoll(r.g, (req.params as { rid: string }).rid, req.user!.id, r.role === 'host', mode === 'manual' ? (values ?? []) : undefined);
    if (res.error) return reply.code(400).send({ error: res.error });
    if (res.done) resolveLater(r.g.id);
    return res;
  });

  /** Host: go on without waiting (e.g. everyone is down and only death saves are left). */
  app.post('/api/games/:id/continue', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'host');
    if (!r) return;
    if (r.g.status !== 'playing' || r.g.state.phase !== 'collect') return reply.code(400).send({ error: 'Only while waiting for actions' });
    addLog(r.g.id, r.g.state.turn, 'system', 'The host moves the story on.');
    resolveLater(r.g.id);
    return { ok: true };
  });

  // ---- Rerolls: a majority vote re-tells the last narration; the dice stay fixed ----
  app.post('/api/games/:id/reroll', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'member');
    if (!r) return;
    const { g } = r;
    if (!['collect', 'approval'].includes(g.state.phase) || g.state.turn < 2) return reply.code(400).send({ error: 'You can reroll the last narration while the DM waits for actions' });
    if (g.state.rerollsLeft <= 0) return reply.code(400).send({ error: 'No rerolls left' });
    if (g.state.rerollVote) return reply.code(409).send({ error: 'A vote is already running' });
    g.state.rerollVote = { by: req.user!.username, votes: { [req.user!.id]: true }, turn: g.state.turn };
    saveGame(g);
    addLog(g.id, g.state.turn, 'system', `${req.user!.username} asks for a reroll of the last narration (${g.state.rerollsLeft} left). Vote!`);
    return settleVote(g.id) ?? { ok: true };
  });

  app.post('/api/games/:id/reroll/vote', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'member');
    if (!r) return;
    if (!r.g.state.rerollVote) return reply.code(400).send({ error: 'No vote running' });
    if (!voters(gameCharacters(r.g.id)).includes(req.user!.id)) return reply.code(403).send({ error: 'Only players with a character at the table vote' });
    r.g.state.rerollVote.votes[req.user!.id] = !!(req.body as { yes?: boolean })?.yes;
    saveGame(r.g);
    return settleVote(r.g.id) ?? { ok: true };
  });

  // ---- Host approvals for big or odd changes ----
  app.post('/api/games/:id/approvals/:aid', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'host');
    if (!r) return;
    const { g } = r;
    const a = g.state.approvals.find((x) => x.id === (req.params as { aid: string }).aid);
    if (!a) return reply.code(404).send({ error: 'No such approval' });
    const approve = !!(req.body as { approve?: boolean })?.approve;
    tx(() => {
      const chars = gameCharacters(g.id);
      const c = chars.find((x) => x.id === a.characterId);
      if (approve && c) {
        if (a.kind === 'xp') c.xp += a.amount;
        if (a.kind === 'gold') c.gold += a.amount;
        if (a.kind === 'delta') {
          if (a.amount > 0) applyHeal(c, a.amount);
          else c.hp = Math.max(0, c.hp + a.amount);
        }
        for (const line of levelCheck([c], g.settings.endLevel)) addLog(g.id, g.state.turn, 'levelup', line);
        saveGameCharacter(g.id, c);
      }
      addLog(g.id, g.state.turn, 'change', `Host ${approve ? 'approved' : 'rejected'}: ${a.name} ${a.reason}`);
      g.state.approvals = g.state.approvals.filter((x) => x !== a);
      if (!g.state.approvals.length && g.state.phase === 'approval') g.state.phase = 'collect';
      saveGame(g);
    });
    broadcast(g);
    return { ok: true };
  });

  // ---- Rests ----
  app.post('/api/games/:id/rest', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'host');
    if (!r) return;
    const { g } = r;
    const { kind, hitDice } = (req.body ?? {}) as { kind?: string; hitDice?: Record<string, number> };
    if (kind !== 'short' && kind !== 'long') return reply.code(400).send({ error: 'A short or a long rest' });
    if (g.state.phase !== 'collect') return reply.code(400).send({ error: 'Rest between turns' });
    if (g.state.combat) return reply.code(400).send({ error: "You can't rest in the middle of a fight" });
    tx(() => {
      const chars = gameCharacters(g.id);
      const lines = rest(chars, kind, g.ruleset, hitDice);
      for (const c of chars) saveGameCharacter(g.id, c);
      addLog(g.id, g.state.turn, 'change', `${kind === 'long' ? 'Long' : 'Short'} rest. ${lines.join(' · ') || 'Nothing to recover.'}`);
    });
    broadcast(g);
    return { ok: true };
  });

  // ---- Levels ----
  /** Milestone games: the host levels the party up. */
  app.post('/api/games/:id/milestone', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'host');
    if (!r) return;
    const { g } = r;
    tx(() => {
      for (const c of gameCharacters(g.id)) {
        if (c.level >= g.settings.endLevel || c.conditions.some((x) => x.name === 'dead')) continue;
        c.xp = Math.max(c.xp, XP_TABLE[c.level + 1]);
        c.levelUpPending = true;
        saveGameCharacter(g.id, c);
      }
      addLog(g.id, g.state.turn, 'levelup', 'Milestone reached: everyone can level up.');
    });
    broadcast(g);
    return { ok: true };
  });

  /** The level-up step: HP (fixed or rolled), new choices; checked like the builder, capped at the end level. */
  app.post('/api/games/:id/characters/:cid/level-up', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'member');
    if (!r) return;
    const { g } = r;
    const c = gameCharacters(g.id).find((x) => x.id === (req.params as { cid: string }).cid);
    if (!c || c.userId !== req.user!.id) return reply.code(404).send({ error: 'Not your character' });
    if (!c.levelUpPending) return reply.code(400).send({ error: `${c.name} doesn't have the XP for the next level yet` });
    if (c.level >= g.settings.endLevel) return reply.code(400).send({ error: `This game ends at level ${g.settings.endLevel}` });
    const body = (req.body ?? {}) as { hp?: 'fixed' | 'roll' | number; asi?: Partial<Abilities>; subclass?: string; cantrips?: string[]; spells?: string[]; skills?: string[] };
    const hpGain =
      typeof body.hp === 'number' ? body.hp : body.hp === 'roll' ? rollDie(c.hitDie) : c.hitDie / 2 + 1;
    if (!Number.isInteger(hpGain) || hpGain < 1 || hpGain > c.hitDie) return reply.code(400).send({ error: `A d${c.hitDie} shows 1-${c.hitDie}` });
    const prevBuild = buildOf(c);
    const next: CharacterBuild = {
      ...prevBuild,
      level: c.level + 1,
      hpRolls: [...(prevBuild.hpRolls ?? Array(c.level - 1).fill(c.hitDie / 2 + 1)), hpGain],
      asi: body.asi ?? prevBuild.asi,
      subclass: body.subclass ?? prevBuild.subclass,
      cantrips: body.cantrips ?? prevBuild.cantrips,
      spells: body.spells ?? prevBuild.spells,
    };
    const d = rules(g.ruleset);
    const errors = validateBuild(d, next, { maxLevel: g.settings.endLevel, rolled: undefined }).filter((e) => !/server roll/.test(e));
    if (errors.length) return reply.code(400).send({ error: errors[0], errors, needsSubclass: !next.subclass && next.level >= subclassLevel(g.ruleset, c.class) });
    const built = buildCharacter(d, next, { id: c.id, ownerId: c.ownerId, prev: c });
    const leveled = { ...c, ...built, userId: c.userId, seated: c.seated, absent: c.absent, xp: c.xp };
    leveled.levelUpPending = leveled.level < Math.min(20, g.settings.endLevel) && leveled.xp >= XP_TABLE[leveled.level + 1] ? true : undefined;
    saveGameCharacter(g.id, leveled);
    addLog(g.id, g.state.turn, 'levelup', `${c.name} is now level ${leveled.level} (+${leveled.maxHp - c.maxHp} max HP${typeof body.hp === 'number' ? ', rolled by the player' : body.hp === 'roll' ? `, rolled ${hpGain}` : ''}).`);
    broadcast(g);
    return leveled;
  });

  /** The host's override: set numbers directly (logged for everyone). */
  app.patch('/api/games/:id/characters/:cid/override', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'host');
    if (!r) return;
    const { g } = r;
    const c = gameCharacters(g.id).find((x) => x.id === (req.params as { cid: string }).cid);
    if (!c) return reply.code(404).send({ error: 'No such character' });
    const p = (req.body ?? {}) as { hp?: number; tempHp?: number; xp?: number; gold?: number; exhaustion?: number; counters?: Record<string, number>; conditions?: Condition[] };
    const lines: string[] = [];
    const n = (v: unknown, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v))));
    if (p.hp !== undefined) lines.push(`HP ${c.hp} → ${(c.hp = n(p.hp, 0, c.maxHp))}`);
    if (p.tempHp !== undefined) lines.push(`temp HP → ${(c.tempHp = n(p.tempHp, 0, 999))}`);
    if (p.xp !== undefined) lines.push(`XP ${c.xp} → ${(c.xp = n(p.xp, 0, 1_000_000))}`);
    if (p.gold !== undefined) lines.push(`gold ${c.gold} → ${(c.gold = n(p.gold, 0, 10_000_000))}`);
    if (p.exhaustion !== undefined) lines.push(`exhaustion → ${(c.exhaustion = n(p.exhaustion, 0, 6))}`);
    for (const [name, v] of Object.entries(p.counters ?? {})) {
      const k = c.counters.find((x) => x.name === name);
      if (k) lines.push(`${k.name} → ${(k.current = n(v, 0, k.max))}/${k.max}`);
    }
    if (Array.isArray(p.conditions)) {
      c.conditions = p.conditions.filter((x) => x && typeof x.name === 'string').slice(0, 20).map((x) => ({ name: x.name.toLowerCase().slice(0, 30), rounds: x.rounds }));
      lines.push(`conditions: ${c.conditions.map((x) => x.name).join(', ') || 'none'}`);
    }
    for (const line of levelCheck([c], g.settings.endLevel)) addLog(g.id, g.state.turn, 'levelup', line);
    saveGameCharacter(g.id, c);
    if (lines.length) addLog(g.id, g.state.turn, 'change', `Host override for ${c.name}: ${lines.join(', ')}`);
    broadcast(g);
    return c;
  });
}

/** Counts the reroll vote; on a pass, the last turn is rolled back to just before narration and told again. */
function settleVote(gameId: string): { result: 'pass' | 'fail' } | undefined {
  const g = loadGame(gameId)!;
  const vote = g.state.rerollVote!;
  const outcome = tally(vote.votes, voters(gameCharacters(g.id)));
  if (outcome === 'open') {
    saveGame(g);
    broadcast(g);
    return;
  }
  if (outcome === 'fail') {
    g.state.rerollVote = undefined;
    saveGame(g);
    addLog(g.id, g.state.turn, 'system', 'The table keeps the story as told.');
    broadcast(g);
    return { result: 'fail' };
  }
  const snap = loadSnapshot(g.id, g.state.turn - 1);
  if (!snap) {
    g.state.rerollVote = undefined;
    saveGame(g);
    broadcast(g);
    return { result: 'fail' };
  }
  tx(() => {
    const left = g.state.rerollsLeft - 1;
    for (const c of snap.characters) saveGameCharacter(g.id, c);
    g.state = { ...snap.state, phase: 'narrating', rerollsLeft: left, rerollVote: undefined, approvals: [] };
    saveGame(g);
    hideLogFrom(g.id, snap.logFrom, ['narration', 'change', 'note', 'levelup', 'image']);
    addLog(g.id, g.state.turn, 'system', `Reroll! The DM tells it again with the same dice (${left} reroll${left === 1 ? '' : 's'} left).`);
  });
  broadcast(g);
  resolveLater(g.id);
  return { result: 'pass' };
}
