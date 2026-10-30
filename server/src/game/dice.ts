import { randomInt } from 'node:crypto';
import { simContext } from '../trainer/context.js';

export const DIE_SIDES = [2, 3, 4, 6, 8, 10, 12, 20, 100];
const MAX_DICE = 100;

export interface DiceTerm {
  sign: 1 | -1;
  count: number;
  sides: number;
  /** 4d6kh3: keep the highest 3; 2d20kl1: keep the lowest. */
  keep?: { which: 'h' | 'l'; n: number };
}
export interface ParsedDice {
  terms: DiceTerm[];
  flat: number;
}

export class DiceError extends Error {}

/** "2d6+3", "1d20-1", "4d6kh3", "d8 + 1d4 + 2". */
export function parseDice(expr: string): ParsedDice {
  const s = expr.replace(/\s+/g, '').toLowerCase();
  if (!s || s.length > 60 || !/^[+-]?(\d*d\d+(k[hl]\d+)?|\d+)([+-](\d*d\d+(k[hl]\d+)?|\d+))*$/.test(s)) throw new DiceError(`Not a dice expression: "${expr}"`);
  const terms: DiceTerm[] = [];
  let flat = 0;
  let total = 0;
  for (const m of s.matchAll(/([+-]?)(?:(\d*)d(\d+)(?:k([hl])(\d+))?|(\d+))/g)) {
    const sign = m[1] === '-' ? -1 : 1;
    if (m[6] !== undefined) {
      flat += sign * Number(m[6]);
      continue;
    }
    const count = m[2] === '' ? 1 : Number(m[2]);
    const sides = Number(m[3]);
    if (!DIE_SIDES.includes(sides)) throw new DiceError(`There is no d${sides}`);
    if (count < 1) throw new DiceError('Roll at least one die');
    total += count;
    const term: DiceTerm = { sign, count, sides };
    if (m[4]) {
      const n = Number(m[5]);
      if (n < 1 || n > count) throw new DiceError(`Can't keep ${n} of ${count} dice`);
      term.keep = { which: m[4] as 'h' | 'l', n };
    }
    terms.push(term);
  }
  if (total > MAX_DICE) throw new DiceError(`At most ${MAX_DICE} dice per roll`);
  return { terms, flat };
}

/** How many physical dice of which sizes a roll needs (what "I roll myself" must supply). */
export function diceNeeded(p: ParsedDice): number[] {
  return p.terms.flatMap((t) => Array<number>(t.count).fill(t.sides));
}

export interface DieResult {
  sides: number;
  value: number;
  dropped?: boolean;
}
export interface RollResult {
  expr: string;
  dice: DieResult[];
  flat: number;
  total: number;
  /** The player rolled real dice and typed the values in. */
  manual: boolean;
}

/** Server RNG; simulated games (M9) roll seeded dice so a run can be repeated. */
export const rollDie = (sides: number) => {
  const rng = simContext()?.rng;
  return rng ? 1 + Math.floor(rng() * sides) : randomInt(1, sides + 1);
};

/**
 * Checks values a player typed in for "I roll myself": one integer per die, each in 1..sides.
 * Returns an error message, or undefined when fine.
 */
export function checkManual(needed: number[], values: unknown): string | undefined {
  if (!Array.isArray(values)) return 'Enter one value per die';
  if (values.length !== needed.length) return `Enter ${needed.length} value${needed.length > 1 ? 's' : ''} (${needed.map((s) => `d${s}`).join(', ')})`;
  for (let i = 0; i < needed.length; i++) {
    const v = values[i];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > needed[i]) return `A d${needed[i]} shows 1-${needed[i]}, not ${String(v)}`;
  }
}

/** Rolls (or takes the player's manual values for) a dice expression. crit doubles every die. */
export function roll(expr: string, opts: { manual?: number[]; crit?: boolean } = {}): RollResult {
  const parsed = parseDice(expr);
  if (opts.crit) parsed.terms = parsed.terms.map((t) => ({ ...t, count: t.count * 2, keep: t.keep && { ...t.keep, n: t.keep.n * 2 } }));
  const needed = diceNeeded(parsed);
  if (opts.manual) {
    const err = checkManual(needed, opts.manual);
    if (err) throw new DiceError(err);
  }
  const dice: DieResult[] = [];
  let total = parsed.flat;
  let k = 0;
  for (const t of parsed.terms) {
    const vals = Array.from({ length: t.count }, () => (opts.manual ? opts.manual[k++] : rollDie(t.sides)));
    let keep = vals.map((_, i) => i);
    if (t.keep) {
      const order = keep.sort((a, b) => (t.keep!.which === 'h' ? vals[b] - vals[a] : vals[a] - vals[b]));
      keep = order.slice(0, t.keep.n);
    }
    vals.forEach((v, i) => {
      const dropped = !keep.includes(i);
      dice.push({ sides: t.sides, value: v, ...(dropped ? { dropped } : {}) });
      if (!dropped) total += t.sign * v;
    });
  }
  return { expr, dice, flat: parsed.flat, total, manual: !!opts.manual };
}

export type Adv = 'adv' | 'dis' | 'none';

export interface D20Result {
  natural: number;
  rolls: number[];
  bonus: number;
  total: number;
  adv: Adv;
  crit: boolean;
  fumble: boolean;
  manual: boolean;
}

/** A D20 Test: advantage rolls two and keeps the higher; disadvantage the lower. */
export function rollD20(bonus: number, adv: Adv = 'none', manual?: number[]): D20Result {
  const n = adv === 'none' ? 1 : 2;
  if (manual) {
    const err = checkManual(Array(n).fill(20), manual);
    if (err) throw new DiceError(err);
  }
  const rolls = manual ?? Array.from({ length: n }, () => rollDie(20));
  const natural = adv === 'adv' ? Math.max(...rolls) : adv === 'dis' ? Math.min(...rolls) : rolls[0];
  return { natural, rolls, bonus, total: natural + bonus, adv, crit: natural === 20, fumble: natural === 1, manual: !!manual };
}

/** Advantage and disadvantage cancel out; several of one kind don't stack. */
export function combineAdv(...sources: Adv[]): Adv {
  const a = sources.includes('adv');
  const d = sources.includes('dis');
  return a && d ? 'none' : a ? 'adv' : d ? 'dis' : 'none';
}

/** 4d6, drop the lowest, six times (server-rolled ability scores). */
export function rollAbilityScores(): number[] {
  return Array.from({ length: 6 }, () => roll('4d6kh3').total);
}
