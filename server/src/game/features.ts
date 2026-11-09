import { ABILITIES, mod, profBonus, type Abilities, type Ability, type Counter, type FeatureEffect, type GameCharacter, type LevelValue, type RulesClass, type RulesData, type RulesEntry, type RulesItem } from '@dungeonmind/shared';
import { slug } from '../rules/index.js';
import { classesOf } from './classes.js';
import { parseDice } from './dice.js';

/** What a feature's numbers are worked out with: class level, proficiency bonus, ability modifiers, the class table's numbers. */
export type Vars = Record<string, number>;

export function featureVars(cls: RulesClass, classLevel: number, abilities: Abilities, charLevel = classLevel): Vars {
  const vars: Vars = { level: classLevel, pb: profBonus(charLevel) };
  for (const a of ABILITIES) vars[a] = mod(abilities[a]);
  for (const [k, v] of Object.entries(cls.levels.find((l) => l.level === classLevel)?.classSpecific ?? {})) if (typeof v === 'number') vars[k] = v;
  return vars;
}

/** "max(1, cha)", "5 * level", "rage_count": + − * / (rounded down), min, max and brackets. */
export function evalFormula(expr: string, vars: Vars): number {
  const toks = expr.match(/\d+|[a-z_]+|[-+*/(),]/gi) ?? [];
  if (toks.join('') !== expr.replace(/\s+/g, '')) throw new Error(`Not a formula: "${expr}"`);
  let i = 0;
  const expect = (t: string) => {
    if (toks[i++] !== t) throw new Error(`Expected "${t}" in "${expr}"`);
  };
  const atom = (): number => {
    const t = toks[i++];
    if (t === '(') {
      const v = sum();
      expect(')');
      return v;
    }
    if (t === '-') return -atom();
    if (t !== undefined && /^\d+$/.test(t)) return Number(t);
    if (t === 'min' || t === 'max') {
      expect('(');
      const args = [sum()];
      while (toks[i] === ',') i++, args.push(sum());
      expect(')');
      return Math[t](...args);
    }
    if (t !== undefined && t in vars) return vars[t];
    throw new Error(`Unknown "${t ?? 'end'}" in "${expr}"`);
  };
  const product = () => {
    let v = atom();
    while (toks[i] === '*' || toks[i] === '/') v = toks[i++] === '*' ? v * atom() : Math.floor(v / atom());
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (toks[i] === '+' || toks[i] === '-') v = toks[i++] === '+' ? v + product() : v - product();
    return v;
  };
  const v = sum();
  if (i !== toks.length) throw new Error(`Not a formula: "${expr}"`);
  return v;
}

/** The step of a by-level table for this class level. */
export function step<T>(table: Record<string, T>, level: number): T | undefined {
  const at = Object.keys(table)
    .map(Number)
    .filter((l) => l <= level)
    .sort((a, b) => b - a)[0];
  return at === undefined ? undefined : table[at];
}

export function levelValue(v: LevelValue, vars: Vars): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return evalFormula(v, vars);
  return step(v, vars.level) ?? 0;
}

/** Dice with numbers filled in: "1d10+level" → "1d10+5". */
export const fillDice = (expr: string, vars: Vars) =>
  expr
    .replace(/\s+/g, '')
    .replace(/\b[a-z_]+\b/g, (name) => {
      if (!(name in vars)) throw new Error(`Unknown "${name}" in "${expr}"`);
      return String(vars[name]);
    })
    .replace(/\+-/g, '-');

/** Dice with numbers filled in, or a formula's number: "1d10+level", "3 * level", "rage_damage_bonus". */
export const amount = (expr: string, vars: Vars) => (/\d*d\d+/.test(expr) ? fillDice(expr, vars) : String(evalFormula(expr, vars)));

/** One class's features with numbers that a character of this class level and subclass has, lowest level first. */
export function classFeatures(rules: RulesData, classId: string, classLevel: number, subclass?: string): RulesEntry[] {
  return rules.features.filter((f) => f.effect && f.owner === classId && (f.level ?? 1) <= classLevel && (!f.effect.subclass || f.effect.subclass === subclass)).sort((a, b) => (a.level ?? 1) - (b.level ?? 1));
}

export interface ActiveFeature {
  feature: RulesEntry;
  effect: FeatureEffect;
  vars: Vars;
}

/** Every feature with numbers a character has, with what its numbers are worked out from. */
export function characterFeatures(rules: RulesData, c: Pick<GameCharacter, 'class' | 'subclass' | 'level' | 'multiclass' | 'abilities'>): ActiveFeature[] {
  // Each class at its own level: a Fighter 5 / Rogue 3 has Sneak Attack 2d6.
  return classesOf(rules, c).flatMap((e) => {
    const vars = featureVars(e.cls, e.level, c.abilities, c.level);
    return classFeatures(rules, e.cls.id, e.level, e.subclass).map((feature) => ({ feature, effect: feature.effect!, vars }));
  });
}

/** The features whose triggers work right now (Rage's only while raging). */
export function activeFeatures(rules: RulesData, c: GameCharacter): ActiveFeature[] {
  return characterFeatures(rules, c).filter((f) => !f.effect.while || c.conditions.some((x) => x.name === f.effect.while));
}

// ---- Counters ----

/** The counters a class gives at this class level; later features change earlier ones with the same name. Unlimited (the table's 9999) shows as 99. */
export function featureCounters(rules: RulesData, cls: RulesClass, classLevel: number, subclass: string | undefined, abilities: Abilities, charLevel = classLevel): Counter[] {
  const vars = featureVars(cls, classLevel, abilities, charLevel);
  const out: Counter[] = [];
  for (const f of classFeatures(rules, cls.id, classLevel, subclass)) {
    const k = f.effect!.counter;
    if (!k) continue;
    const name = k.name ?? f.name;
    let c = out.find((x) => x.name === name);
    if (!c) out.push((c = { name, current: 0, max: 0, recharge: 'long', source: cls.name }));
    if (k.uses !== undefined) {
      const n = levelValue(k.uses, vars);
      c.max = n >= 1000 ? 99 : Math.max(0, n);
    }
    if (k.recharge) c.recharge = k.recharge;
    if (k.regain !== undefined) c.regain = k.regain || undefined;
  }
  return out.filter((c) => c.max > 0).map((c) => ({ ...c, current: c.max, ...(c.regain ? {} : { regain: undefined }) })).map(({ regain, ...c }) => (regain ? { ...c, regain } : c));
}

/** Spending a feature's counter puts its condition on the character (Rage: raging). */
export function grantConditions(rules: RulesData, chars: GameCharacter[], spend: { characterId: string; name: string; item?: boolean }[]): string[] {
  const out: string[] = [];
  for (const s of spend) {
    const c = chars.find((x) => x.id === s.characterId);
    if (!c || s.item) continue;
    for (const { feature, effect } of characterFeatures(rules, c)) {
      if (!effect.grants || (effect.counter?.name ?? feature.name) !== s.name) continue;
      const prev = c.conditions.find((x) => x.name === effect.grants!.name);
      if (prev) prev.rounds = effect.grants.rounds;
      else c.conditions.push({ name: effect.grants.name, ...(effect.grants.rounds ? { rounds: effect.grants.rounds } : {}), source: feature.name });
      out.push(`${c.name} is ${effect.grants.name}`);
    }
  }
  return out;
}

// ---- Triggers ----

export function featureAdv(rules: RulesData, c: GameCharacter | undefined, kind: string, ability?: Ability, spell = false): boolean {
  return !!c && activeFeatures(rules, c).some((f) => f.effect.advantage?.some((a) => a.kind === kind && (!a.ability || a.ability === ability) && (!a.spell || spell)));
}

/** The lowest natural roll that crits with a weapon (20 without a feature). */
export function critOn(rules: RulesData, c: GameCharacter): number {
  return Math.min(20, ...activeFeatures(rules, c).map((f) => f.effect.critOn ?? 20));
}

export function resistances(rules: RulesData, c: GameCharacter): string[] {
  return [...new Set(activeFeatures(rules, c).flatMap((f) => f.effect.resist ?? []))];
}

/** Does a name the adjudicator gave mean this feature? "Colossus Slayer" finds "Hunter's Prey: Colossus Slayer". */
export const featureName = (f: RulesEntry) => f.effect?.damage?.name ?? f.effect?.counter?.name ?? f.name.replace(/\s*\(.*\)$/, '');
export const namesFeature = (said: string[] | undefined, f: RulesEntry) => {
  const k = slug(featureName(f));
  return (said ?? []).some((n) => {
    const s = slug(String(n));
    return s.length > 3 && (k === s || k.startsWith(`${s}-`) || k.endsWith(`-${s}`) || slug(f.name).includes(s));
  });
};

/** One NdM term's count ("5d8" → 5). */
const diceCount = (expr: string) => parseDice(expr).terms[0]?.count ?? 0;

/** A feature's damage dice at this class level, and for a slot. */
export function featureDamage(e: NonNullable<FeatureEffect['damage']>, vars: Vars, slot = 1): string | undefined {
  const raw = typeof e.dice === 'string' ? e.dice : step(e.dice, vars.level);
  if (!raw) return;
  let dice = amount(raw, vars);
  if (e.slot && slot > 1) {
    const base = parseDice(dice).terms[0];
    const up = parseDice(e.slot.upcast).terms[0];
    const n = Math.min(diceCount(e.slot.max), base.count + up.count * (slot - 1));
    dice = dice.replace(/^\d+d/, `${n}d`);
  }
  return dice;
}

export interface Rider {
  dice: string;
  type?: string;
  from: string;
}

// SRD 5.1's imported categories omit melee/ranged. Ammunition identifies its other
// ranged weapons, but Dart and Net are ranged thrown weapons without that property.
// Do not use Thrown alone: daggers, javelins, etc. are melee weapons. In 5.2 Net is gear.
const SRD51_THROWN_RANGED = new Set(['dart', 'net']);
export const isRanged = (rules: RulesData, w?: RulesItem) => /ranged/i.test(w?.category ?? '')
  || !!w?.properties?.some((p) => /ammunition/i.test(p))
  || (rules.ruleset === 'srd51' && !!w && SRD51_THROWN_RANGED.has(w.id));

/**
 * The extra damage a PC's weapon hit gets from features: automatic ones (Rage, Divine Strike), and the ones the
 * adjudicator named (Sneak Attack, Divine Smite). Once-per-turn features remember in `used`; slots come out of `slots`.
 */
export function damageRiders(
  rules: RulesData,
  c: GameCharacter,
  hit: { weapon?: RulesItem; str: boolean; named?: string[]; type?: string; used: Set<string>; slots: number[] },
): { riders: Rider[]; notes: string[] } {
  const riders: Rider[] = [];
  const notes: string[] = [];
  const w = hit.weapon;
  const ranged = isRanged(rules, w);
  const finesse = !!w?.properties?.some((p) => /finesse/i.test(p));
  for (const { feature: f, effect, vars } of activeFeatures(rules, c)) {
    const e = effect.damage;
    if (!e) continue;
    const fits = e.on === 'weapon' ? !!w : e.on === 'melee-weapon' ? !!w && !ranged : e.on === 'melee' ? !ranged : e.on === 'str-melee' ? !ranged && hit.str : (finesse || ranged) && !!w;
    if (!fits || (e.ask && !namesFeature(hit.named, f))) continue;
    const key = `${c.id}:${f.id}`;
    if (e.once && hit.used.has(key)) continue;
    let slot = 1;
    if (e.slot) {
      if (!hit.slots.length) {
        notes.push(`${f.name} needs a spell slot`);
        continue;
      }
      slot = hit.slots.shift()!;
    }
    const dice = featureDamage(e, vars, slot);
    if (!dice) continue;
    if (e.once) hit.used.add(key);
    riders.push({ dice, type: e.type === 'weapon' ? undefined : (e.type.split('|').find((t) => t === hit.type) ?? e.type.split('|')[0]), from: featureName(f) });
  }
  return { riders, notes };
}

/** The healing a heal roll that names a feature rolls (Second Wind). */
export function featureHeal(rules: RulesData, c: GameCharacter, named: string[] | undefined): { dice: string; from: string } | undefined {
  const f = characterFeatures(rules, c).find((x) => x.effect.heal && namesFeature(named, x.feature));
  return f && { dice: amount(f.effect.heal!, f.vars), from: featureName(f.feature) };
}

// ---- For the AI ----

const ON: Record<NonNullable<FeatureEffect['damage']>['on'], string> = {
  weapon: 'weapon hits',
  melee: 'melee hits',
  'melee-weapon': 'melee weapon hits',
  'str-melee': 'Strength melee hits',
  'finesse-or-ranged': 'finesse or ranged weapon hits',
};

/** One line per feature that does something in numbers or that the story has to know (counters are listed apart). */
export function featureLines(rules: RulesData, c: GameCharacter): string[] {
  const out: string[] = [];
  for (const { feature: f, effect: e, vars } of characterFeatures(rules, c)) {
    const parts: string[] = [];
    if (e.grants) parts.push(`spending it makes you ${e.grants.name}`);
    if (e.damage) {
      const d = featureDamage(e.damage, vars);
      if (d) parts.push(`+${d}${e.damage.type === 'weapon' ? '' : ` ${e.damage.type}`} on ${ON[e.damage.on]}${e.damage.once ? ', once per turn' : ''}${e.damage.slot ? `, spends a spell slot (+${e.damage.slot.upcast} per slot level above 1st, up to ${e.damage.slot.max})` : ''}${e.damage.ask ? '; name it in the damage roll\'s "features"' : ''}`);
    }
    if (e.heal) parts.push(`heals ${amount(e.heal, vars)}; name it in the heal roll's "features"`);
    if (e.advantage) parts.push(`advantage on ${e.advantage.map((a) => `${a.ability ? `${a.ability.toUpperCase()} ` : ''}${a.spell ? 'spell ' : ''}${a.kind}s`).join(', ')}`);
    if (e.resist) parts.push(`resists ${e.resist.join(', ')}`);
    if (e.critOn) parts.push(`weapon crits on ${e.critOn}-20`);
    if (e.while && parts.length && !e.grants) parts.push(`while ${e.while}`);
    if (e.note) parts.push(e.note);
    if (parts.length) out.push(`${featureName(f)}: ${parts.join('; ')}`);
  }
  return out;
}
