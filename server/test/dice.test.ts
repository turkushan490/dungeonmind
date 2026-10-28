import { describe, expect, it } from 'vitest';
import { checkManual, combineAdv, DiceError, diceNeeded, parseDice, roll, rollAbilityScores, rollD20 } from '../src/game/dice.js';

describe('dice expressions', () => {
  it('parses dice, modifiers and keep', () => {
    expect(parseDice('2d6+3')).toEqual({ terms: [{ sign: 1, count: 2, sides: 6 }], flat: 3 });
    expect(parseDice('d8 + 1d4 - 1').terms.map((t) => t.sides)).toEqual([8, 4]);
    expect(parseDice('4d6kh3').terms[0].keep).toEqual({ which: 'h', n: 3 });
  });

  it.each(['', '2d7', '1d20+', 'fireball', '200d6', '3d6kh4', '0d6'])('rejects "%s"', (e) => {
    expect(() => parseDice(e)).toThrow(DiceError);
  });

  it('stays inside the possible range over many rolls', () => {
    for (let i = 0; i < 2000; i++) {
      const r = roll('3d6+2');
      expect(r.total).toBeGreaterThanOrEqual(5);
      expect(r.total).toBeLessThanOrEqual(20);
      expect(r.dice).toHaveLength(3);
    }
  });

  it('hits every face of a d20 (and nothing else)', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 4000; i++) seen.add(roll('1d20').total);
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('keeps the highest three of 4d6', () => {
    const r = roll('4d6kh3', { manual: [1, 6, 4, 3] });
    expect(r.total).toBe(13);
    expect(r.dice.filter((d) => d.dropped).map((d) => d.value)).toEqual([1]);
  });

  it('doubles the dice on a critical hit, not the modifier', () => {
    const r = roll('1d8+3', { crit: true, manual: [8, 8] });
    expect(r.dice).toHaveLength(2);
    expect(r.total).toBe(19);
  });

  it('rolls ability scores as six 4d6-drop-lowest', () => {
    const s = rollAbilityScores();
    expect(s).toHaveLength(6);
    expect(s.every((v) => v >= 3 && v <= 18)).toBe(true);
  });
});

describe('"I roll myself"', () => {
  it('accepts real die values and marks the roll as manual', () => {
    const r = roll('2d6+1', { manual: [3, 5] });
    expect(r).toMatchObject({ total: 9, manual: true });
  });

  it('needs exactly one value per die', () => {
    expect(diceNeeded(parseDice('2d6+1d4'))).toEqual([6, 6, 4]);
    expect(checkManual([6, 6], [3])).toMatch(/Enter 2 values/);
  });

  it.each([
    [[20], [21]],
    [[20], [0]],
    [[6], [3.5]],
    [[6], ['4']],
    [[8, 8], [8, 9]],
  ])('refuses impossible faces %j ← %j', (needed, values) => {
    expect(checkManual(needed as number[], values)).toBeTruthy();
  });

  it('refuses an impossible manual roll instead of using it', () => {
    expect(() => roll('1d6', { manual: [7] })).toThrow(/d6 shows 1-6/);
    expect(() => rollD20(5, 'none', [0])).toThrow(DiceError);
  });

  it('takes the right die of a manual advantage roll', () => {
    expect(rollD20(3, 'adv', [4, 17])).toMatchObject({ natural: 17, total: 20, manual: true });
    expect(rollD20(3, 'dis', [4, 17])).toMatchObject({ natural: 4, total: 7 });
    expect(() => rollD20(3, 'adv', [12])).toThrow(/Enter 2 values/);
  });
});

describe('d20 tests', () => {
  it('flags natural 20s and 1s', () => {
    expect(rollD20(0, 'none', [20])).toMatchObject({ crit: true, fumble: false });
    expect(rollD20(0, 'none', [1])).toMatchObject({ crit: false, fumble: true });
  });

  it('advantage and disadvantage cancel and do not stack', () => {
    expect(combineAdv('adv', 'adv')).toBe('adv');
    expect(combineAdv('adv', 'dis', 'adv')).toBe('none');
    expect(combineAdv('none', 'dis')).toBe('dis');
  });
});
