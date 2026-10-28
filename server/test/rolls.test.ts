import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GameCharacter, Npc, RulesData } from '@dungeonmind/shared';
import { beforeAll, describe, expect, it } from 'vitest';

let R: typeof import('../src/game/rolls.js');
let I: typeof import('../src/game/initiative.js');
let Z: typeof import('../src/game/zones.js');
let V: typeof import('../src/game/rerolls.js');
let rules: RulesData;
let turks: GameCharacter;
let esva: GameCharacter;
const hag = (): Npc => ({ name: 'The Bell-Hag', hp: 30, maxHp: 30, ac: 15, dex: 2, status: 'hostile' });

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dm-rolls-'));
  R = await import('../src/game/rolls.js');
  I = await import('../src/game/initiative.js');
  Z = await import('../src/game/zones.js');
  V = await import('../src/game/rerolls.js');
  rules = (await import('../src/rules/index.js')).rules('srd51');
  const { buildCharacter } = await import('../src/game/character.js');
  const base = { ruleset: 'srd51' as const, background: 'acolyte', level: 1, abilityMethod: 'standard' as const };
  turks = {
    ...buildCharacter(rules, { ...base, name: 'Turks', species: 'human', class: 'fighter', baseAbilities: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, skills: ['athletics', 'perception'], equipment: ['Longsword', 'Chain Mail'] }, { id: 't', ownerId: 'u1' }),
    userId: 'u1',
    seated: true,
    absent: false,
  };
  esva = {
    ...buildCharacter(
      rules,
      { ...base, name: 'Esva', species: 'human', class: 'cleric', subclass: 'life', baseAbilities: { str: 13, dex: 10, con: 14, int: 8, wis: 15, cha: 12 }, skills: ['medicine', 'persuasion'], cantrips: ['sacred-flame'], spells: ['guiding-bolt'], equipment: ['Mace'] },
      { id: 'e', ownerId: 'u2' },
    ),
    userId: 'u2',
    seated: true,
    absent: false,
  };
});

describe('building rolls from the adjudicator', () => {
  it('uses the sheet for player numbers, never the AI bonus', () => {
    const rolls = R.buildRolls(rules, [turks], [hag()], {
      rolls: [
        { id: 'a', actor: 'Turks', kind: 'attack', target: 'The Bell-Hag', targetAc: 99, bonus: 30, weapon: 'Longsword' },
        { id: 'b', actor: 'Turks', kind: 'damage', target: 'The Bell-Hag', dice: '10d10', onHit: 'a', weapon: 'Longsword' },
        { id: 'c', actor: 'Turks', kind: 'check', skill: 'Athletics', dc: 12, bonus: 20 },
      ],
    });
    // STR 16 (+3) + proficiency 2; the hag's AC from the state, not the AI's 99.
    expect(rolls[0]).toMatchObject({ bonus: 5, targetAc: 15, characterId: 't', auto: false });
    expect(rolls[1]).toMatchObject({ dice: '1d8+3', onHit: 'r1', damageType: 'slashing' });
    expect(rolls[2]).toMatchObject({ bonus: 5, dc: 12, label: 'Turks athletics check' });
  });

  it('NPC rolls use the AI bonus and are rolled by the server', () => {
    const [r] = R.buildRolls(rules, [turks], [hag()], { rolls: [{ actor: 'The Bell-Hag', kind: 'attack', target: 'Turks', bonus: 6, targetAc: 3 }] });
    expect(r).toMatchObject({ auto: true, bonus: 6, targetAc: 16 }); // Turks' real AC: chain mail 16 (no DEX), not the AI's 3
  });

  it('uses the caster’s real spell DC for saves against PC spells', () => {
    const [r] = R.buildRolls(rules, [esva], [hag()], { rolls: [{ actor: 'The Bell-Hag', kind: 'save', ability: 'dex', dc: 25, spell: 'Sacred Flame', bonus: 2 }] });
    expect(r.dc).toBe(8 + 2 + 3);
  });

  it('applies condition disadvantage and cancels it with advantage', () => {
    const poisoned = { ...turks, conditions: [{ name: 'poisoned' }] };
    expect(R.buildRolls(rules, [poisoned], [hag()], { rolls: [{ actor: 'Turks', kind: 'attack', target: 'The Bell-Hag' }] })[0].adv).toBe('dis');
    expect(R.buildRolls(rules, [poisoned], [hag()], { rolls: [{ actor: 'Turks', kind: 'attack', target: 'The Bell-Hag', adv: 'adv' }] })[0].adv).toBe('none');
  });

  it('falls back to safe dice for nonsense expressions', () => {
    const [r] = R.buildRolls(rules, [esva], [], { rolls: [{ actor: 'Esva', kind: 'heal', dice: 'lots', target: 'Esva' }] });
    expect(r.dice).toBe('1d4');
  });
});

describe('resolving rolls', () => {
  const pair = () => R.buildRolls(rules, [turks], [hag()], {
    rolls: [
      { id: 'a', actor: 'Turks', kind: 'attack', target: 'The Bell-Hag' },
      { id: 'b', actor: 'Turks', kind: 'damage', target: 'The Bell-Hag', onHit: 'a' },
    ],
  });

  it('a hit unlocks the damage, a miss skips it', () => {
    const hit = pair();
    expect(R.ready(hit[1], hit)).toBe(false);
    R.resolveRoll(hit[0], hit, [12]); // 12 + 5 = 17 vs 15
    expect(hit[0].result).toMatchObject({ success: true, manual: true, total: 17 });
    expect(R.ready(hit[1], hit)).toBe(true);
    const miss = pair();
    R.resolveRoll(miss[0], miss, [5]);
    expect(miss[1].result).toMatchObject({ skipped: true, total: 0 });
  });

  it('a natural 20 always hits and doubles the damage dice; a natural 1 always misses', () => {
    const c = pair();
    c[0].targetAc = 40;
    R.resolveRoll(c[0], c, [20]);
    expect(c[0].result!.success).toBe(true);
    expect(c[1].crit).toBe(true);
    R.resolveRoll(c[1], c, [8, 8]);
    expect(c[1].result!.total).toBe(19);
    const f = pair();
    f[0].targetAc = 1;
    R.resolveRoll(f[0], f, [1]);
    expect(f[0].result!.success).toBe(false);
  });

  it('refuses impossible "I roll myself" values', () => {
    const c = pair();
    expect(() => R.resolveRoll(c[0], c, [21])).toThrow(/d20 shows 1-20/);
    expect(c[0].result).toBeUndefined();
  });

  it('half damage on a made save when the spell says so', () => {
    const rolls = R.buildRolls(rules, [esva], [hag()], {
      rolls: [
        { id: 's', actor: 'The Bell-Hag', kind: 'save', ability: 'dex', dc: 13, bonus: 0 },
        { id: 'd', actor: 'Esva', kind: 'damage', target: 'The Bell-Hag', dice: '8d6', onFail: 's', half: true, spell: 'Fireball' },
      ],
    });
    R.resolveRoll(rolls[0], rolls, [19]);
    R.resolveRoll(rolls[1], rolls, [6, 6, 6, 6, 6, 6, 6, 5]);
    expect(rolls[1].result!.total).toBe(23);
    const fx = R.rollEffects(rolls, [esva], [hag()]);
    expect(fx.foes.get('The Bell-Hag')).toEqual({ damage: 23, heal: 0 });
  });
});

describe('initiative', () => {
  it('sorts by total, then bonus, then players first', () => {
    const order = I.sortInitiative([
      { name: 'Goblin', roll: 10, bonus: 2, total: 12 },
      { name: 'Turks', characterId: 't', roll: 10, bonus: 2, total: 12 },
      { name: 'Hag', roll: 18, bonus: 2, total: 20 },
      { name: 'Esva', characterId: 'e', roll: 12, bonus: 0, total: 12 },
    ]);
    expect(order.map((o) => o.name)).toEqual(['Hag', 'Turks', 'Goblin', 'Esva']);
  });

  it('rolls for the party and every hostile NPC', () => {
    const c = I.rollInitiative(rules, [turks, esva], [hag(), { name: 'Villager', status: 'friendly' }], ['Wolf'], () => 10);
    expect(c.order.map((o) => o.name).sort()).toEqual(['Esva', 'The Bell-Hag', 'Turks', 'Wolf']);
    expect(c.order.find((o) => o.name === 'Turks')).toMatchObject({ bonus: 2, total: 12 });
    expect(c.round).toBe(1);
  });

  it('ends the fight when no enemy is left', () => {
    const npcs = [hag()];
    const c = I.rollInitiative(rules, [turks], npcs, [], () => 10);
    expect(I.pruneCombat(c, [turks], npcs)).toBe(false);
    npcs[0].hp = 0;
    expect(I.pruneCombat(c, [turks], npcs)).toBe(true);
    expect(I.nextRound(c).round).toBe(2);
  });
});

describe('zone board', () => {
  it('validates zones, makes distances symmetric, places only known creatures', () => {
    const z = Z.cleanZones(
      [{ name: 'Altar', distances: { Door: 30, Nowhere: 10, Pit: -5 } }, { name: 'Door', distances: {} }, { name: 'altar' }, { name: 'Pit', distances: { Altar: 99999 } }],
      { Altar: ['Turks', 'Ghost'], Door: ['The Bell-Hag', 'Turks'], Ledge: ['Esva'] },
      ['Turks', 'Esva', 'The Bell-Hag'],
    );
    expect(z.zones.map((x) => x.name)).toEqual(['Altar', 'Door', 'Pit', 'Ledge']);
    expect(z.zones[1].distances).toEqual({ Altar: 30 });
    expect(z.positions).toEqual({ Altar: ['Turks'], Door: ['The Bell-Hag'], Ledge: ['Esva'] });
    expect(Z.range(z.zones, z.positions, 'Turks', 'The Bell-Hag')).toBe(30);
    expect(Z.range(z.zones, z.positions, 'Turks', 'Turks')).toBe(5);
    expect(Z.range(z.zones, z.positions, 'Turks', 'Esva')).toBeUndefined();
  });
});

describe('reroll voting', () => {
  it('needs a majority of the players', () => {
    expect(V.tally({ a: true }, ['a', 'b', 'c'])).toBe('open');
    expect(V.tally({ a: true, b: true }, ['a', 'b', 'c'])).toBe('pass');
    expect(V.tally({ a: true, b: false, c: false }, ['a', 'b', 'c'])).toBe('fail');
    expect(V.tally({ a: true, b: false }, ['a', 'b'])).toBe('fail'); // 1 of 2 is no majority
    expect(V.tally({ a: true }, ['a'])).toBe('pass');
    expect(V.tally({ x: true, y: true }, ['a', 'b', 'c'])).toBe('open'); // non-voters don't count
  });

  it('one vote per player, absent players excluded', () => {
    expect(V.voters([turks, { ...esva, userId: 'u1' }, { ...esva, id: 'z', userId: 'u3', absent: true }])).toEqual(['u1']);
  });
});
