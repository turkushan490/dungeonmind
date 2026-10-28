import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GameCharacter, GameSettings } from '@dungeonmind/shared';
import { beforeAll, describe, expect, it } from 'vitest';

let bk: typeof import('../src/game/bookkeeper.js');
let make: (over?: Partial<GameCharacter>) => GameCharacter;
const settings = { xpMode: 'xp', approvalXp: 1000, approvalGold: 200, endLevel: 5 } as GameSettings;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dm-bk-'));
  bk = await import('../src/game/bookkeeper.js');
  const { rules } = await import('../src/rules/index.js');
  const { buildCharacter } = await import('../src/game/character.js');
  make = (over = {}) => {
    const c = buildCharacter(
      rules('srd51'),
      {
        ruleset: 'srd51',
        name: 'Esva',
        species: 'human',
        class: 'cleric',
        subclass: 'life',
        background: 'acolyte',
        level: 2,
        abilityMethod: 'standard',
        baseAbilities: { str: 13, dex: 10, con: 14, int: 8, wis: 15, cha: 12 },
        skills: ['medicine', 'persuasion'],
        equipment: ['Mace', '20 Arrows'],
      },
      { id: 'c1', ownerId: 'u1' },
    );
    return { ...c, userId: 'u1', seated: true, absent: false, ...over } as GameCharacter;
  };
});

describe('counters and resources', () => {
  it('normalizes spell slot names', () => {
    expect(bk.normalizeCounterName('1st-level spell slot')).toBe('Spell slot L1');
    expect(bk.normalizeCounterName('spell slot 3')).toBe('Spell slot L3');
    expect(bk.normalizeCounterName('Level 2 slot')).toBe('Spell slot L2');
    expect(bk.normalizeCounterName('Channel Divinity')).toBe('Channel Divinity');
  });

  it('spends what is there and refuses what is not', () => {
    const c = make();
    const cd = c.counters.find((k) => k.name === 'Channel Divinity')!;
    expect(cd).toMatchObject({ current: 1, max: 1 });
    const ok = bk.checkResources([c], [{ pc: 'Esva', name: 'Channel Divinity', amount: 1 }, { pc: 'Esva', name: '1st level spell slot', amount: 1 }]);
    expect(ok.refused).toEqual([]);
    expect(bk.applySpend([c], ok.spend)).toEqual(['Esva: Channel Divinity 1/1 → 0/1', 'Esva: Spell slot L1 3/3 → 2/3']);
    const no = bk.checkResources([c], [{ pc: 'Esva', name: 'Channel Divinity', amount: 1 }]);
    expect(no.refused).toEqual([{ characterId: 'c1', reason: 'Channel Divinity is at 0/1 (used up).' }]);
    expect(no.spend).toEqual([]);
  });

  it('refuses slots the character does not have and counts repeated use in one turn', () => {
    const c = make();
    expect(bk.checkResources([c], [{ pc: 'Esva', name: 'Spell slot L3', amount: 1 }]).refused[0].reason).toMatch(/no Spell slot L3/);
    const two = bk.checkResources([c], [
      { pc: 'Esva', name: 'Spell slot L1', amount: 2 },
      { pc: 'Esva', name: 'Spell slot L1', amount: 2 },
    ]);
    expect(two.refused[0].reason).toMatch(/Spell slot L1 is at 3\/3/);
  });

  it('spends ammunition from the inventory', () => {
    const c = make();
    const r = bk.checkResources([c], [{ pc: 'Esva', name: 'Arrows', amount: 1 }]);
    bk.applySpend([c], r.spend);
    expect(c.inventory.find((i) => i.name === 'Arrows')!.qty).toBe(19);
    expect(bk.checkResources([c], [{ pc: 'Esva', name: 'Arrows', amount: 50 }]).refused[0].reason).toMatch(/19 Arrows left/);
  });

  it('refunds with the opposite sign, never above max', () => {
    const c = make();
    bk.applySpend([c], [{ characterId: 'c1', name: 'Spell slot L1', amount: 1 }], 1);
    expect(c.counters.find((k) => k.name === 'Spell slot L1')!.current).toBe(3);
  });
});

describe('hit points', () => {
  it('takes temporary HP first and never goes below 0', () => {
    const c = make({ tempHp: 5 });
    bk.applyDamage(c, 8, { ruleset: 'srd51' });
    expect(c).toMatchObject({ tempHp: 0, hp: c.maxHp - 3 });
    bk.applyDamage(c, 999 - 999 + c.hp + 2, { ruleset: 'srd51' });
    expect(c.hp).toBe(0);
    expect(c.conditions.map((x) => x.name)).toContain('unconscious');
  });

  it('kills outright on massive damage', () => {
    const c = make();
    bk.applyDamage(c, c.hp + c.maxHp, { ruleset: 'srd51' });
    expect(c.conditions.map((x) => x.name)).toEqual(['dead']);
  });

  it('counts damage at 0 HP as death save failures (two on a crit)', () => {
    const c = make({ hp: 0, conditions: [{ name: 'unconscious' }] });
    bk.applyDamage(c, 3, { ruleset: 'srd51', crit: true });
    expect(c.deathSaves.fail).toBe(2);
    bk.applyDamage(c, 3, { ruleset: 'srd51' });
    expect(c.conditions.map((x) => x.name)).toContain('dead');
  });

  it('heals up to max and wakes a downed character, but not the dead', () => {
    const c = make({ hp: 0, conditions: [{ name: 'unconscious' }], deathSaves: { success: 1, fail: 2 } });
    bk.applyHeal(c, 999);
    expect(c.hp).toBe(c.maxHp);
    expect(c.conditions).toEqual([]);
    expect(c.deathSaves).toEqual({ success: 0, fail: 0 });
    const d = make({ hp: 0, conditions: [{ name: 'dead' }] });
    bk.applyHeal(d, 10);
    expect(d.hp).toBe(0);
  });

  it('death saves: three successes stabilize, a 20 wakes with 1 HP, a 1 counts double', () => {
    const c = make({ hp: 0, conditions: [{ name: 'unconscious' }] });
    bk.deathSave(c, 12);
    bk.deathSave(c, 15);
    expect(bk.deathSave(c, 10)).toMatch(/stable/);
    const d = make({ hp: 0, conditions: [{ name: 'unconscious' }] });
    bk.deathSave(d, 1);
    expect(d.deathSaves.fail).toBe(2);
    expect(bk.deathSave(d, 20)).toMatch(/1 HP/);
    expect(d.hp).toBe(1);
  });

  it('rolls concentration when a concentrating character is hurt', () => {
    const c = make({ concentration: 'Bless' });
    const lines = bk.applyDamage(c, 4, { ruleset: 'srd51', conBonus: 100 });
    expect(lines.join()).toMatch(/keeps concentration on Bless .* vs DC 10/);
    const d = make({ concentration: 'Bless' });
    bk.applyDamage(d, 4, { ruleset: 'srd51', conBonus: -100 });
    expect(d.concentration).toBeUndefined();
    expect(bk.concentrationDc(80, 'srd52')).toBe(40 > 30 ? 30 : 40);
  });
});

describe('deltas are clamped to the rules', () => {
  const run = (c: GameCharacter, deltas: unknown[], backed = new Map<string, number>()) => bk.applyDeltas([c], deltas, { backed, settings });

  it('sends HP changes without a roll to the host, and notes wrong numbers', () => {
    const c = make();
    const r = run(c, [{ pc: 'Esva', hp: -6 }]);
    expect(c.hp).toBe(c.maxHp);
    expect(r.approvals[0]).toMatchObject({ kind: 'delta', amount: -6 });
    const r2 = run(c, [{ pc: 'Esva', hp: -10 }], new Map([['c1', -7]]));
    expect(r2.notes[0]).toMatch(/the DM wrote -10, the dice say -7/);
    expect(r2.approvals).toEqual([]);
  });

  it('never lets a counter go below 0 or above max', () => {
    const c = make();
    const slots = c.counters.find((k) => k.name === 'Spell slot L1')!;
    run(c, [{ pc: 'Esva', counters: { 'Spell slot L1': -5 } }]);
    expect(slots.current).toBe(3);
    run(c, [{ pc: 'Esva', counters: { 'Spell slot L1': -1 } }]);
    expect(slots.current).toBe(2);
    run(c, [{ pc: 'Esva', counters: { 'Spell slot L1': +9 } }]);
    expect(slots.current).toBe(3);
  });

  it('gold: no spending what you lack, big gains need the host', () => {
    const c = make({ gold: 10 });
    expect(run(c, [{ pc: 'Esva', gold: -50 }]).notes[0]).toMatch(/rejected/);
    run(c, [{ pc: 'Esva', gold: 25 }]);
    expect(c.gold).toBe(35);
    const big = run(c, [{ pc: 'Esva', gold: 5000 }]);
    expect(c.gold).toBe(35);
    expect(big.approvals[0]).toMatchObject({ kind: 'gold', amount: 5000 });
  });

  it('items must exist to be removed; temp HP keeps the higher value', () => {
    const c = make({ tempHp: 8 });
    expect(run(c, [{ pc: 'Esva', removeItems: ['Vorpal Sword'] }]).notes[0]).toMatch(/not in the inventory/);
    run(c, [{ pc: 'Esva', addItems: ['2× Healing Potion'], removeItems: ['Mace'], tempHp: 5 }]);
    expect(c.inventory.find((i) => i.name === 'Healing Potion')!.qty).toBe(2);
    expect(c.inventory.some((i) => i.name === 'Mace')).toBe(false);
    expect(c.tempHp).toBe(8);
  });

  it('conditions: durations, removal, and only HP decides unconscious/dead', () => {
    const c = make();
    run(c, [{ pc: 'Esva', addConditions: [{ name: 'Poisoned', rounds: 2 }, { name: 'dead' }] }]);
    expect(c.conditions).toEqual([{ name: 'poisoned', rounds: 2, source: undefined }]);
    expect(bk.tickConditions([c])).toEqual([]);
    expect(bk.tickConditions([c])).toEqual(['Esva: poisoned ended']);
  });

  it('ignores changes for characters that are not at the table', () => {
    expect(run(make(), [{ pc: 'Gandalf', hp: 99 }]).notes[0]).toMatch(/unknown character/);
  });
});

describe('XP and levels', () => {
  it('awards XP, holds back big awards, and flags the level threshold', () => {
    const c = make({ xp: 250, level: 1 });
    const r = bk.applyXp([c], [{ pc: 'party', amount: 50, reason: 'goblins' }], settings);
    expect(c.xp).toBe(300);
    expect(r.changes[0]).toMatch(/\+50 XP/);
    expect(bk.levelCheck([c], 5)).toEqual(['Esva reached level 2! Open the level-up.']);
    expect(c.levelUpPending).toBe(true);
    expect(bk.levelCheck([c], 5)).toEqual([]); // the banner shows once
    const big = bk.applyXp([c], [{ pc: 'Esva', amount: 5000 }], settings);
    expect(big.approvals[0]).toMatchObject({ kind: 'xp', amount: 5000 });
  });

  it.each([
    [299, 1, false],
    [300, 1, true],
    [899, 2, false],
    [900, 2, true],
    [6500, 4, true],
    [355000, 19, true],
  ])('%i XP at level %i → level up %s', (xp, level, ready) => {
    const c = make({ xp, level });
    bk.levelCheck([c], 20);
    expect(!!c.levelUpPending).toBe(ready);
  });

  it('never levels past the end level', () => {
    const c = make({ xp: 100000, level: 5 });
    bk.levelCheck([c], 5);
    expect(c.levelUpPending).toBeUndefined();
  });

  it('ignores DM XP in milestone games', () => {
    const c = make({ xp: 0 });
    const r = bk.applyXp([c], [{ pc: 'Esva', amount: 300 }], { ...settings, xpMode: 'milestone' });
    expect(c.xp).toBe(0);
    expect(r.notes[0]).toMatch(/milestones/);
  });
});

describe('rests', () => {
  it('short rest: short counters back, hit dice spent for HP', () => {
    const c = make({ hp: 3 });
    c.counters.find((k) => k.name === 'Channel Divinity')!.current = 0;
    c.counters.find((k) => k.name === 'Spell slot L1')!.current = 0;
    const lines = bk.rest([c], 'short', 'srd51', { c1: 1 });
    expect(c.counters.find((k) => k.name === 'Channel Divinity')!.current).toBe(1);
    expect(c.counters.find((k) => k.name === 'Spell slot L1')!.current).toBe(0);
    expect(c.counters.find((k) => k.name.startsWith('Hit Dice'))!.current).toBe(1);
    expect(c.hp).toBeGreaterThan(3);
    expect(lines.join()).toMatch(/spends 1 Hit Die/);
  });

  it('long rest: everything back; 2014 regains half the hit dice, 2024 all', () => {
    const a = make({ hp: 1, exhaustion: 2, tempHp: 4 });
    a.counters.find((k) => k.name.startsWith('Hit Dice'))!.current = 0;
    a.counters.find((k) => k.name === 'Spell slot L1')!.current = 0;
    bk.rest([a], 'long', 'srd51');
    expect(a).toMatchObject({ hp: a.maxHp, exhaustion: 1, tempHp: 0 });
    expect(a.counters.find((k) => k.name === 'Spell slot L1')!.current).toBe(3);
    expect(a.counters.find((k) => k.name.startsWith('Hit Dice'))!.current).toBe(1);
    const b = make();
    b.counters.find((k) => k.name.startsWith('Hit Dice'))!.current = 0;
    bk.rest([b], 'long', 'srd52');
    expect(b.counters.find((k) => k.name.startsWith('Hit Dice'))!.current).toBe(2);
  });

  it('per-turn counters recharge every turn', () => {
    const c = make();
    c.counters.push({ name: 'Reaction', current: 0, max: 1, recharge: 'turn', source: 'custom' });
    bk.rechargeTurn([c]);
    expect(c.counters.find((k) => k.name === 'Reaction')!.current).toBe(1);
  });
});
