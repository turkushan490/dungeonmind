import type { Ability, GameCharacter, RulesData, RulesSpell, SpellEffect } from '@dungeonmind/shared';
import { findIn, slug } from '../rules/index.js';
import { derive } from './character.js';
import { classesOf } from './classes.js';
import { parseDice, type DiceTerm } from './dice.js';

/** Cantrip tier at character level 5, 11 and 17. */
export const cantripTier = (level: number) => (level >= 17 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1);

/** The spell, when this character has it as a cantrip or spell. */
export function knownSpell(rules: RulesData, c: GameCharacter | undefined, name: string | undefined): RulesSpell | undefined {
  const s = c && name ? findIn(rules.spells, name) : undefined;
  return s && [...(c!.spells ?? []), ...(c!.cantrips ?? [])].some((x) => x === s.id || slug(x) === s.id) ? s : undefined;
}

/**
 * The caster's spellcasting modifier for a spell: the best one of the classes that have it on their list (a Cleric/Wizard
 * casts Fireball with INT); else the first class that casts; without one (a racial spell), the best mental one.
 */
export function spellMod(rules: RulesData, c: GameCharacter, spell?: RulesSpell): number {
  const d = derive(rules, c);
  const own = spell ? classesOf(rules, c).flatMap((e) => (e.cls.spellAbility && spell.classes.includes(e.cls.id) ? [d.mods[e.cls.spellAbility]] : [])) : [];
  if (own.length) return Math.max(...own);
  return d.spellAbility ? d.mods[d.spellAbility] : Math.max(d.mods.int, d.mods.wis, d.mods.cha);
}

/** The ability that supplies spellMod, including multiclass and racial spell fallbacks. */
export function spellAbility(rules: RulesData, c: GameCharacter, spell?: RulesSpell): Ability {
  const d = derive(rules, c);
  const own = spell ? classesOf(rules, c).flatMap((e) => (e.cls.spellAbility && spell.classes.includes(e.cls.id) ? [e.cls.spellAbility] : [])) : [];
  const candidates: Ability[] = own.length ? own : d.spellAbility ? [d.spellAbility] : ['int', 'wis', 'cha'];
  return candidates.reduce((best, a) => d.mods[a] > d.mods[best] ? a : best);
}

/** The spell save DC for a spell; undefined for a caster without any spellcasting class (the AI's number stands). */
export function spellSaveDc(rules: RulesData, c: GameCharacter, spell?: RulesSpell): number | undefined {
  const d = derive(rules, c);
  const own = !!spell && classesOf(rules, c).some((e) => e.cls.spellAbility && spell.classes.includes(e.cls.id));
  return own || d.spellAbility ? 8 + d.profBonus + spellMod(rules, c, spell) : undefined;
}

/** Darts, rays or beams at this slot (cantrips: at this character level). */
export function spellCount(e: SpellEffect, spellLevel: number, slot: number, charLevel: number): number {
  const n = e.count ?? 1;
  if (e.scales === 'count') return n * cantripTier(charLevel);
  return n + (e.countUpcast ?? 0) * Math.max(0, slot - spellLevel);
}

const add = (terms: DiceTerm[], t: DiceTerm, times: number) => {
  const same = terms.find((x) => x.sides === t.sides && x.sign === t.sign && !x.keep);
  if (same) same.count += t.count * times;
  else terms.push({ ...t, count: t.count * times });
};

/**
 * The dice one target takes or regains: "mod" filled in, cantrip dice grown with the character level,
 * `upcast` once per slot level above the spell's level, and everything times `times` (several darts in one roll).
 */
export function spellDice(expr: string, o: { mod: number; tier?: number; upcast?: string; above?: number; times?: number }): string {
  const p = parseDice(expr.replace(/\s+/g, '').replace(/[+-]?mod/, ''));
  const terms: DiceTerm[] = [];
  for (const t of p.terms) add(terms, t, o.tier ?? 1);
  let flat = p.flat + (/mod/.test(expr) ? (/-mod/.test(expr) ? -o.mod : o.mod) : 0);
  if (o.upcast && o.above) {
    const u = parseDice(o.upcast);
    for (const t of u.terms) add(terms, t, o.above);
    flat += u.flat * o.above;
  }
  const times = o.times ?? 1;
  flat *= times;
  const dice = terms.map((t, i) => `${t.sign < 0 ? '-' : i ? '+' : ''}${t.count * times}d${t.sides}`).join('');
  return dice + (flat ? `${flat > 0 && dice ? '+' : ''}${flat}` : '') || '0';
}

/** One line per spell for the AI: what the server will roll. */
export function spellSummary(s: RulesSpell, charLevel: number): string {
  const e = s.effect;
  if (!e) return s.name;
  const tier = s.level === 0 && e.scales === 'dice' ? cantripTier(charLevel) : 1;
  const parts: string[] = [];
  if (e.attack) parts.push(`${e.attack} spell attack`);
  if (e.save) parts.push(`${e.save.toUpperCase()} save${e.half ? ' (half on a success)' : ''}`);
  if (e.autoHit) parts.push('always hits');
  if (e.rider) parts.push('extra damage on a hit');
  if (e.area) parts.push(e.area);
  const count = spellCount(e, s.level, s.level, charLevel);
  if (count > 1) parts.push(`${count}×`);
  for (const d of e.damage ?? []) parts.push(`${spellDice(d.dice.replace(/\+mod/, ''), { mod: 0, tier })}${/mod/.test(d.dice) ? '+mod' : ''} ${d.type.replace(/\|/g, '/')}${d.upcast ? ` (+${d.upcast} per slot above ${s.level})` : ''}`);
  if (e.heal) parts.push(`heals ${e.heal}`);
  if (e.tempHp) parts.push(`${e.tempHp} temp HP`);
  if (e.upcast) parts.push(`+${e.upcast} per ${e.upcastEvery ? `${e.upcastEvery} slot levels` : 'slot'} above ${s.level}`);
  if (e.conditions?.length) parts.push(e.conditions.map((c) => c.name).join(', '));
  return `${s.name} (${s.level ? `L${s.level}` : 'cantrip'}${parts.length ? `: ${parts.join(', ')}` : ''})`;
}
