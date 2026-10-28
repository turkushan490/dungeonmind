import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RULESETS, type RulesData, type Ruleset } from '@dungeonmind/shared';
import { config } from '../config.js';

const cache = new Map<Ruleset, RulesData>();
type Extender = (ruleset: Ruleset, base: RulesData) => RulesData;
let extend: Extender = (_r, base) => base;

/** Homebrew (M10) merges its entries in here. */
export function setRulesExtender(fn: Extender) {
  extend = fn;
  invalidateRules();
}
export function invalidateRules() {
  cache.clear();
  index.clear();
}

const base = new Map<Ruleset, RulesData>();
function loadBase(ruleset: Ruleset): RulesData {
  let d = base.get(ruleset);
  if (!d) {
    d = JSON.parse(readFileSync(join(config.rulesDir, ruleset, 'rules.json'), 'utf8')) as RulesData;
    base.set(ruleset, d);
  }
  return d;
}

export const isRuleset = (r: unknown): r is Ruleset => RULESETS.includes(r as Ruleset);

export function rules(ruleset: Ruleset): RulesData {
  let d = cache.get(ruleset);
  if (!d) {
    d = extend(ruleset, loadBase(ruleset));
    cache.set(ruleset, d);
  }
  return d;
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Finds by id or by (case-insensitive) name. */
export function findIn<T extends { id: string; name: string }>(list: T[], idOrName: string | undefined): T | undefined {
  if (!idOrName) return;
  const s = slug(idOrName);
  return list.find((x) => x.id === idOrName || x.id === s || slug(x.name) === s);
}

// ---- Search (the local rules page, and a fallback when HiveMind memory search is missing) ----
const tokenize = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

export interface RulesHit {
  kind: string;
  id: string;
  name: string;
  text: string;
  score: number;
}

/** Small BM25 over every entry of a ruleset. */
const index = new Map<Ruleset, { docs: ReturnType<typeof memoryEntries>; toks: string[][]; avg: number }>();

export function searchRules(ruleset: Ruleset, query: string, limit = 10): RulesHit[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length) return [];
  let idx = index.get(ruleset);
  if (!idx) {
    const docs = memoryEntries(ruleset);
    const toks = docs.map((d) => tokenize(d.text));
    idx = { docs, toks, avg: toks.reduce((a, t) => a + t.length, 0) / Math.max(1, toks.length) };
    index.set(ruleset, idx);
  }
  const { docs, toks, avg } = idx;
  const df = new Map<string, number>();
  for (const t of toks) for (const w of new Set(t)) if (q.includes(w)) df.set(w, (df.get(w) ?? 0) + 1);
  const N = docs.length;
  const hits = docs.map((d, i) => {
    const tf = new Map<string, number>();
    for (const w of toks[i]) if (q.includes(w)) tf.set(w, (tf.get(w) ?? 0) + 1);
    let score = 0;
    for (const w of q) {
      const f = tf.get(w) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
      score += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (toks[i].length / avg)));
    }
    // A name match is what people mean most of the time.
    if (tokenize(d.name).every((w) => q.includes(w))) score += 5;
    return { ...d, score };
  });
  return hits.filter((h) => h.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Every rule, spell, condition, feature, item and monster as one markdown entry (HiveMind memory `rules:<ruleset>`). */
export function memoryEntries(ruleset: Ruleset): { kind: string; id: string; name: string; text: string }[] {
  const d = rules(ruleset);
  const out: { kind: string; id: string; name: string; text: string }[] = [];
  const add = (kind: string, id: string, name: string, body: string) => out.push({ kind, id, name, text: `## ${kind}: ${name}\n${body}`.trim() });
  for (const r of d.rules) add('Rule', r.id, r.name, r.desc.replace(/^#+ .*\n/, ''));
  for (const c of d.conditions) add('Condition', c.id, c.name, c.desc);
  for (const s of d.spells)
    add(
      'Spell',
      s.id,
      s.name,
      `${s.level ? `Level ${s.level}` : 'Cantrip'} ${s.school}${s.ritual ? ' (ritual)' : ''}. Casting time ${s.castingTime}, range ${s.range}, components ${s.components}, duration ${s.concentration ? 'Concentration, ' : ''}${s.duration}. Classes: ${s.classes.join(', ')}.\n${s.desc}${s.higher ? `\nAt higher levels: ${s.higher}` : ''}`,
    );
  for (const c of d.classes)
    add(
      'Class',
      c.id,
      c.name,
      `Hit die d${c.hitDie}. Saving throws: ${c.saves.join(', ').toUpperCase()}. Skills: choose ${c.skillChoices.choose} from ${c.skillChoices.from.join(', ')}. Proficiencies: ${c.proficiencies.join(', ')}.${c.spellAbility ? ` Spellcasting ability: ${c.spellAbility.toUpperCase()}.` : ''} Subclasses: ${c.subclasses.map((s) => s.name).join(', ')}.\n${c.levels.map((l) => `Level ${l.level}: ${l.features.join(', ') || '-'}`).join('\n')}`,
    );
  for (const f of d.features) add('Feature', f.id, f.name, `${f.owner ? `${f.owner}${f.level ? ` level ${f.level}` : ''}. ` : ''}${f.desc}`);
  for (const s of d.species) add('Species', s.id, s.name, `Speed ${s.speed}, size ${s.size}. Traits: ${s.traits.join(', ')}.${s.subspecies.length ? ` Subspecies: ${s.subspecies.map((x) => x.name).join(', ')}.` : ''}`);
  for (const t of d.traits) add('Trait', t.id, t.name, t.desc);
  for (const b of d.backgrounds) add('Background', b.id, b.name, `Skills: ${b.skills.join(', ')}.${b.abilityOptions ? ` Ability scores: ${b.abilityOptions.join(', ')}.` : ''}${b.feat ? ` Feat: ${b.feat}.` : ''}${b.feature ? ` ${b.feature}` : ''}`);
  for (const f of d.feats) add('Feat', f.id, f.name, f.desc);
  for (const i of d.items)
    add(
      i.magic ? 'Magic item' : 'Item',
      i.id,
      i.name,
      [
        i.category,
        i.rarity,
        i.cost && `cost ${i.cost}`,
        i.damage && `damage ${i.damage} ${i.damageType ?? ''}${i.damage2 ? ` (two-handed ${i.damage2})` : ''}`,
        i.armor && `AC ${i.armor.base}${i.armor.dexBonus ? ` + Dex${i.armor.maxBonus ? ` (max ${i.armor.maxBonus})` : ''}` : ''}`,
        i.properties?.length && `properties ${i.properties.join(', ')}`,
      ]
        .filter(Boolean)
        .join('; ') + (i.desc ? `\n${i.desc}` : ''),
    );
  for (const m of d.monsters)
    add(
      'Monster',
      m.id,
      m.name,
      `${m.size} ${m.type}, AC ${m.ac}, HP ${m.hp} (${m.hitDice}), speed ${m.speed}, CR ${m.cr} (${m.xp} XP). STR ${m.abilities.str} DEX ${m.abilities.dex} CON ${m.abilities.con} INT ${m.abilities.int} WIS ${m.abilities.wis} CHA ${m.abilities.cha}.${m.senses ? ` Senses: ${m.senses}.` : ''}\n${[...m.traits, ...m.actions].join('\n')}`,
    );
  return out;
}
