import type { FastifyInstance } from 'fastify';
import { ABILITIES, RULESETS, type Abilities, type Character, type CharacterBuild, type Ruleset } from '@dungeonmind/shared';
import { requireUser } from '../auth/index.js';
import { newId } from '../crypto.js';
import { db, json } from '../db.js';
import { rollAbilityScores } from '../game/dice.js';
import { buildCharacter, buildOf, derive, STANDARD_ARRAY, subclassLevel, validateBuild } from '../game/character.js';
import { outputJson, runCanvas, withRetry } from '../hivemind.js';
import { background } from '../jobs.js';
import { findIn, isRuleset, rules, slug } from '../rules/index.js';

export function loadCharacter(id: string): Character | undefined {
  const r = db.prepare('SELECT data FROM characters WHERE id = ?').get(id) as { data: string } | undefined;
  return r ? json<Character>(r.data, undefined as unknown as Character) : undefined;
}

export function saveCharacter(c: Character) {
  c.updatedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO characters (id, owner_id, ruleset, name, data) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = datetime('now')`,
  ).run(c.id, c.ownerId, c.ruleset, c.name, JSON.stringify(c));
}

export const rolledValues = (rollId: string | undefined, userId: string) =>
  rollId ? json<number[] | undefined>((db.prepare('SELECT vals FROM ability_rolls WHERE id = ? AND user_id = ?').get(rollId, userId) as { vals: string } | undefined)?.vals, undefined) : undefined;

/** Turns loose input (AI output, an imported sheet) into a build: names → ids, scores → a method. */
export function normalizeBuild(ruleset: Ruleset, raw: Record<string, any>, level: number): CharacterBuild {
  const d = rules(ruleset);
  const abil = (raw.baseAbilities ?? raw.abilities ?? raw.stats ?? {}) as Record<string, unknown>;
  const base = Object.fromEntries(
    ABILITIES.map((a) => {
      const v = abil[a] ?? abil[a.toUpperCase()] ?? Object.entries(abil).find(([k]) => k.toLowerCase().startsWith(a))?.[1];
      return [a, Math.round(Number(v) || 10)];
    }),
  ) as Abilities;
  const sorted = Object.values(base).sort((x, y) => y - x).join();
  const pointCost: Record<number, number> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
  const pb = Object.values(base).every((v) => v >= 8 && v <= 15) && Object.values(base).reduce((s, v) => s + pointCost[v], 0) <= 27;
  const cls = findIn(d.classes, raw.class ?? raw.className);
  const sp = findIn(d.species, raw.species ?? raw.race);
  const sub = sp?.subspecies.find((s) => slug(s.name) === slug(String(raw.subspecies ?? raw.subrace ?? '')) || s.id === raw.subspecies);
  const ids = (list: unknown, pool: { id: string; name: string }[]) =>
    (Array.isArray(list) ? list : []).map((x) => findIn(pool, String(typeof x === 'object' && x ? ((x as { name?: string }).name ?? '') : x))?.id).filter((x): x is string => !!x);
  const skills = (Array.isArray(raw.skills) ? raw.skills : []).map((s: unknown) => slug(String(s).replace(/^skill-/i, '')));
  const sc = cls?.subclasses.find((s) => slug(s.name) === slug(String(raw.subclass ?? '')) || s.id === raw.subclass);
  const lvl = Number(raw.level) || level;
  return {
    ruleset,
    name: String(raw.name ?? 'Nameless').slice(0, 60),
    species: sp?.id ?? String(raw.species ?? raw.race ?? ''),
    subspecies: sub?.id,
    class: cls?.id ?? String(raw.class ?? ''),
    subclass: sc?.id ?? (cls && lvl >= subclassLevel(ruleset, cls.id) ? cls.subclasses[0]?.id : undefined),
    background: findIn(d.backgrounds, raw.background)?.id ?? d.backgrounds[0].id,
    level: lvl,
    abilityMethod: sorted === STANDARD_ARRAY.join() ? 'standard' : pb ? 'pointbuy' : 'manual',
    baseAbilities: base,
    bonusChoices: raw.bonusChoices ?? raw.backgroundBonus ?? undefined,
    asi: raw.asi,
    skills,
    cantrips: ids(raw.cantrips, d.spells),
    spells: ids(raw.spells, d.spells),
    equipment: (Array.isArray(raw.equipment) ? raw.equipment : Array.isArray(raw.inventory) ? raw.inventory : []).map((e: unknown) =>
      typeof e === 'object' && e ? `${(e as { qty?: number }).qty && (e as { qty: number }).qty > 1 ? `${(e as { qty: number }).qty}× ` : ''}${(e as { name: string }).name}` : String(e),
    ),
    alignment: raw.alignment,
    appearance: raw.appearance,
    personality: raw.personality,
    backstory: raw.backstory,
  };
}

/** The allowed options the AI may pick from (dnd-sheet's {{vars.options}}). */
function sheetOptions(ruleset: Ruleset): string {
  const d = rules(ruleset);
  return JSON.stringify({
    classes: d.classes.map((c) => ({ id: c.id, subclasses: c.subclasses.map((s) => s.id), skillChoices: c.skillChoices, spellcasting: !!c.spellAbility })),
    species: d.species.map((s) => ({ id: s.id, subspecies: s.subspecies.map((x) => x.id) })),
    backgrounds: d.backgrounds.map((b) => ({ id: b.id, skills: b.skills, abilityOptions: b.abilityOptions })),
    note: 'Spells: SRD spell ids like "magic-missile". Equipment: plain item names, gold as "15 gp".',
  });
}

/** Runs dnd-sheet, validates the result, and gives the AI one chance to fix what's illegal. */
export async function aiSheet(userId: string, ruleset: Ruleset, level: number, description: string): Promise<{ build: CharacterBuild; errors: string[] }> {
  const d = rules(ruleset);
  let question = description;
  let build!: CharacterBuild;
  let errors: string[] = [];
  for (let round = 0; round < 2; round++) {
    const r = await withRetry(() => runCanvas('dnd-sheet', question, { vars: { ruleset, level: String(level), options: sheetOptions(ruleset), userId } }));
    build = normalizeBuild(ruleset, outputJson<Record<string, unknown>>(r, 'sheet'), level);
    build.level = level;
    errors = validateBuild(d, build);
    if (!errors.length) break;
    question = `${description}\n\nYour last sheet broke these rules, fix them:\n- ${errors.join('\n- ')}\nLast sheet: ${JSON.stringify(build)}`;
  }
  return { build, errors };
}

const summary = (c: Character) => ({
  id: c.id,
  name: c.name,
  ruleset: c.ruleset,
  class: c.class,
  subclass: c.subclass,
  species: c.species,
  level: c.level,
  portrait: c.portrait,
  updatedAt: c.updatedAt,
});

export function characterRoutes(app: FastifyInstance) {
  app.get('/api/characters', { preHandler: requireUser }, async (req) =>
    (db.prepare('SELECT data FROM characters WHERE owner_id = ? ORDER BY updated_at DESC').all(req.user!.id) as { data: string }[]).map((r) => summary(JSON.parse(r.data))),
  );

  app.get('/api/characters/:id', { preHandler: requireUser }, async (req, reply) => {
    const c = loadCharacter((req.params as { id: string }).id);
    if (!c || c.ownerId !== req.user!.id) return reply.code(404).send({ error: 'Not found' });
    return { character: c, derived: derive(rules(c.ruleset), c), build: buildOf(c) };
  });

  app.post('/api/characters/roll-abilities', { preHandler: requireUser }, async (req) => {
    const id = newId();
    const values = rollAbilityScores();
    db.prepare('INSERT INTO ability_rolls (id, user_id, vals) VALUES (?, ?, ?)').run(id, req.user!.id, JSON.stringify(values));
    return { rollId: id, values };
  });

  /** Live legality check for the builder: errors + a preview of the derived numbers. */
  app.post('/api/characters/validate', { preHandler: requireUser }, async (req, reply) => {
    const b = req.body as CharacterBuild;
    if (!isRuleset(b?.ruleset)) return reply.code(400).send({ error: 'Pick a ruleset' });
    const d = rules(b.ruleset);
    const errors = validateBuild(d, b, { rolled: rolledValues(b.rollId, req.user!.id) });
    if (errors.length) return { errors };
    const c = buildCharacter(d, b, { id: 'preview', ownerId: req.user!.id });
    return { errors, character: c, derived: derive(d, c) };
  });

  app.post('/api/characters', { preHandler: requireUser }, async (req, reply) => {
    const b = req.body as CharacterBuild;
    if (!isRuleset(b?.ruleset)) return reply.code(400).send({ error: 'Pick a ruleset' });
    const count = (db.prepare('SELECT COUNT(*) AS n FROM characters WHERE owner_id = ?').get(req.user!.id) as { n: number }).n;
    if (count >= 200) return reply.code(400).send({ error: 'Your library is full (200 characters)' });
    const d = rules(b.ruleset);
    const errors = validateBuild(d, b, { rolled: rolledValues(b.rollId, req.user!.id) });
    if (errors.length) return reply.code(400).send({ error: errors[0], errors });
    const c = buildCharacter(d, b, { id: newId(), ownerId: req.user!.id });
    saveCharacter(c);
    return c;
  });

  /** Rebuild from changed choices; HP lost, spent resources, inventory and portrait carry over. */
  app.put('/api/characters/:id', { preHandler: requireUser }, async (req, reply) => {
    const prev = loadCharacter((req.params as { id: string }).id);
    if (!prev || prev.ownerId !== req.user!.id) return reply.code(404).send({ error: 'Not found' });
    const b = { ...(req.body as CharacterBuild), ruleset: prev.ruleset };
    const d = rules(prev.ruleset);
    const errors = validateBuild(d, b, { rolled: rolledValues(b.rollId, req.user!.id) });
    if (errors.length) return reply.code(400).send({ error: errors[0], errors });
    const c = buildCharacter(d, b, { id: prev.id, ownerId: prev.ownerId, prev });
    saveCharacter(c);
    return c;
  });

  /** Things that aren't rules choices: story fields, notes, inventory, portrait. */
  app.patch('/api/characters/:id', { preHandler: requireUser }, async (req, reply) => {
    const c = loadCharacter((req.params as { id: string }).id);
    if (!c || c.ownerId !== req.user!.id) return reply.code(404).send({ error: 'Not found' });
    const p = (req.body ?? {}) as Partial<Character>;
    for (const k of ['appearance', 'personality', 'backstory', 'notes', 'alignment'] as const) if (typeof p[k] === 'string') c[k] = p[k]!.slice(0, 8000);
    if (Array.isArray(p.inventory))
      c.inventory = p.inventory
        .filter((i) => i && typeof i.name === 'string')
        .slice(0, 200)
        .map((i) => ({ name: i.name.slice(0, 120), qty: Math.max(0, Math.min(9999, Math.floor(Number(i.qty) || 1))), equipped: !!i.equipped }));
    saveCharacter(c);
    return c;
  });

  app.delete('/api/characters/:id', { preHandler: requireUser }, async (req) => {
    db.prepare('DELETE FROM characters WHERE id = ? AND owner_id = ?').run((req.params as { id: string }).id, req.user!.id);
    return { ok: true };
  });

  app.get('/api/characters/:id/export', { preHandler: requireUser }, async (req, reply) => {
    const c = loadCharacter((req.params as { id: string }).id);
    if (!c || c.ownerId !== req.user!.id) return reply.code(404).send({ error: 'Not found' });
    reply.header('content-disposition', `attachment; filename="${slug(c.name) || 'character'}.dungeonmind.json"`);
    return { format: 'dungeonmind-character', version: 1, build: buildOf(c), sheet: c };
  });

  /** The AI builds a sheet from a description; the result opens in the builder (not saved yet). */
  app.post('/api/characters/ai', { preHandler: requireUser }, async (req, reply) => {
    const { ruleset, level, description } = (req.body ?? {}) as { ruleset?: string; level?: number; description?: string };
    if (!isRuleset(ruleset)) return reply.code(400).send({ error: 'Pick a ruleset' });
    if (!description?.trim() || description.length > 4000) return reply.code(400).send({ error: 'Describe the character (max 4000 characters)' });
    return background(req, reply, () => aiSheet(req.user!.id, ruleset, Math.max(1, Math.min(20, Number(level) || 1)), description.trim()));
  });

  /** Import: our own export, any JSON sheet with common field names, or pasted text (read by the AI). */
  app.post('/api/characters/import', { preHandler: requireUser }, async (req, reply) => {
    const { ruleset, text, level } = (req.body ?? {}) as { ruleset?: string; text?: string; level?: number };
    if (!isRuleset(ruleset)) return reply.code(400).send({ error: 'Pick a ruleset' });
    if (!text?.trim() || text.length > 200_000) return reply.code(400).send({ error: 'Paste a sheet (JSON or text)' });
    let parsed: Record<string, any> | undefined;
    try {
      parsed = JSON.parse(text);
    } catch {}
    if (parsed && typeof parsed === 'object') {
      const raw = parsed.format === 'dungeonmind-character' ? { ...parsed.build } : (parsed.build ?? parsed.character ?? parsed);
      const build = parsed.format === 'dungeonmind-character' ? ({ ...raw, ruleset } as CharacterBuild) : normalizeBuild(ruleset, raw, Number(level) || 1);
      return { build, errors: validateBuild(rules(ruleset), build, { rolled: rolledValues(build.rollId, req.user!.id) }) };
    }
    return background(req, reply, () =>
      aiSheet(req.user!.id, ruleset, Math.max(1, Math.min(20, Number(level) || 1)), `Convert this existing character sheet as faithfully as the rules allow:\n\n${text.slice(0, 12000)}`),
    );
  });
}

export const RULESET_LIST = RULESETS;
