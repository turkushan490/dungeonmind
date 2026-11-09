import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ABILITIES, SKILLS, type GameCharacter, type Npc, type PendingRoll, type RulesData } from '@dungeonmind/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { RawRoll } from '../src/game/rolls.js';

let R: typeof import('../src/game/rolls.js');
let C: typeof import('../src/game/character.js');
let rules: RulesData;
let rules2024: RulesData;
let hero: GameCharacter;
let caster: GameCharacter;
const goblin: Npc = { name: 'Goblin', monster: 'goblin', ac: 15, dex: 2, status: 'hostile' };
const stranger: Npc = { name: 'Rook', ac: 14, status: 'neutral' };

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dm-roll-parts-'));
  R = await import('../src/game/rolls.js');
  C = await import('../src/game/character.js');
  const data = await import('../src/rules/index.js');
  rules = data.rules('srd51');
  rules2024 = data.rules('srd52');
  const base = { ruleset: 'srd51' as const, background: 'acolyte', level: 1, abilityMethod: 'standard' as const, species: 'human' };
  hero = {
    ...C.buildCharacter(rules, {
      ...base, name: 'Hero', class: 'fighter',
      baseAbilities: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
      skills: ['athletics', 'perception'], equipment: ['Longsword', 'Rapier', 'Longbow'],
    }, { id: 'hero', ownerId: 'player' }),
    abilities: { str: 14, dex: 18, con: 12, int: 8, wis: 16, cha: 10 },
    saves: ['str', 'con'], skills: ['athletics', 'perception'],
    userId: 'player', seated: true, absent: false,
  };
  caster = { ...hero, id: 'caster', name: 'Mira', class: 'cleric', spells: ['guiding-bolt'] };
});

function build(raw: RawRoll[], pc = hero, data = rules): PendingRoll[] {
  return R.buildRolls(data, [pc], [goblin, stranger], { rolls: raw.map((r) => ({ actor: pc.name, ...r })) });
}

function exact(r: PendingRoll) {
  expect(r.parts, r.label).toBeDefined();
  expect(r.parts!.reduce((sum, p) => sum + p.value, 0), r.label).toBe(r.bonus);
}

describe('named flat bonuses', () => {
  it.each([
    ['Longsword', 'STR', 2, 4],
    ['Rapier', 'DEX', 4, 6],
  ])('%s names the ability actually used and proficiency', (weapon, ability, mod, bonus) => {
    const [r] = build([{ kind: 'attack', weapon, bonus: 99 }]);
    expect(r.bonus).toBe(bonus);
    expect(r.parts).toEqual([{ label: ability, value: mod }, { label: 'Proficiency', value: 2 }]);
    exact(r);
  });

  it('uses DEX when the weapon category is ranged and preserves the existing SRD category behavior', () => {
    const ranged = { ...rules, items: rules.items.map((item) => item.id === 'longbow' ? { ...item, category: 'Martial Ranged Weapons' } : item) };
    const [r] = build([{ kind: 'attack', weapon: 'Longbow' }], hero, ranged);
    expect(r.parts).toEqual([{ label: 'DEX', value: 4 }, { label: 'Proficiency', value: 2 }]);
    expect(r.bonus).toBe(6);
    exact(r);
    // SRD 5.1 calls the category "Weapon, Martial Weapons"; its Ammunition property makes it ranged.
    const [srd51] = build([{ kind: 'attack', weapon: 'Longbow' }]);
    expect(srd51.parts).toEqual([{ label: 'DEX', value: 4 }, { label: 'Proficiency', value: 2 }]);
    expect(srd51.bonus).toBe(6);
    exact(srd51);
  });

  it('rolls SRD 5.1 bow damage with DEX', () => {
    const [, dmg] = build([{ id: 'a', kind: 'attack', weapon: 'Longbow' }, { kind: 'damage', weapon: 'Longbow', onHit: 'a' }]);
    expect(dmg.dice).toBe('1d8+4');
  });

  it('uses DEX for SRD 5.1 nets and keeps darts finesse in both rulesets', async () => {
    const { isRanged } = await import('../src/game/features.js');
    const inventory = ['Net', 'Dart'].map((name) => ({ name, qty: 1, equipped: true }));
    const pc = { ...hero, inventory };
    const [net] = build([{ kind: 'attack', weapon: 'Net' }], pc);
    expect(net.bonus).toBe(6);
    expect(net.parts).toEqual([{ label: 'DEX', value: 4 }, { label: 'Proficiency', value: 2 }]);
    exact(net);
    expect(isRanged(rules, rules.items.find((w) => w.id === 'net'))).toBe(true);
    expect(isRanged(rules2024, rules2024.items.find((w) => w.id === 'net'))).toBe(false);
    for (const data of [rules, rules2024]) {
      expect(isRanged(data, data.items.find((w) => w.id === 'dart'))).toBe(true);
      for (const [str, ability, bonus] of [[14, 'DEX', 6], [20, 'STR', 7]] as const) {
        const [dart] = build([{ kind: 'attack', weapon: 'Dart' }], { ...pc, abilities: { ...pc.abilities, str } }, data);
        expect(dart.bonus).toBe(bonus);
        expect(dart.parts![0].label).toBe(ability);
        exact(dart);
      }
      for (const id of ['dagger', 'handaxe', 'javelin', 'spear', 'light-hammer', 'trident']) {
        const item = data.items.find((w) => w.id === id);
        expect(item, id).toBeDefined();
        expect(isRanged(data, item), id).toBe(false);
      }
    }
  });

  it('uses STR for finesse when STR is higher and for unarmed attacks', () => {
    const strong = { ...hero, abilities: { ...hero.abilities, str: 20 } };
    for (const pc of [strong, { ...strong, inventory: [] }]) {
      const [r] = build([{ kind: 'attack', weapon: 'Rapier' }], pc);
      expect(r.parts).toEqual([{ label: 'STR', value: 5 }, { label: 'Proficiency', value: 2 }]);
      expect(r.bonus).toBe(7);
      exact(r);
    }
  });

  it('names the spellcasting ability and proficiency', () => {
    const [r] = build([{ kind: 'attack', spell: 'Guiding Bolt', bonus: 99 }], caster);
    expect(r.parts).toEqual([{ label: 'Spellcasting (WIS)', value: 3 }, { label: 'Proficiency', value: 2 }]);
    expect(r.bonus).toBe(5);
    exact(r);
  });

  it('names the spell-specific multiclass ability and the racial fallback', () => {
    const multiclass = {
      ...caster, level: 2, multiclass: [{ class: 'wizard', level: 1 }],
      abilities: { ...caster.abilities, int: 20 },
    };
    const [r] = build([{ kind: 'attack', spell: 'Fire Bolt' }], multiclass);
    expect(r.parts).toEqual([{ label: 'Spellcasting (INT)', value: 5 }, { label: 'Proficiency', value: 2 }]);
    exact(r);
    const [racial] = build([{ kind: 'attack', spell: 'Unknown spell' }]);
    expect(racial.parts).toEqual([{ label: 'Spellcasting (WIS)', value: 3 }, { label: 'Proficiency', value: 2 }]);
    exact(racial);
  });

  it.each([
    ['save', { ability: 'str' }, 'STR', 2, true, 4],
    ['save', { ability: 'dex' }, 'DEX', 4, false, 4],
    ['check', { skill: 'athletics' }, 'STR', 2, true, 4],
    ['check', { skill: 'stealth' }, 'DEX', 4, false, 4],
    ['check', { ability: 'str' }, 'STR', 2, false, 2],
  ])('%s %j uses sheet parts', (kind, details, ability, mod, proficient, bonus) => {
    const [r] = build([{ kind, ...details, bonus: 99 }]);
    expect(r.parts).toEqual([
      { label: ability, value: mod },
      ...(proficient ? [{ label: 'Proficiency', value: 2 }] : []),
    ]);
    expect(r.bonus).toBe(bonus);
    exact(r);
  });

  it('applies 2024 exhaustion to every d20 test, including spell attacks', () => {
    const tired = { ...caster, exhaustion: 2 };
    const rolls = build([
      { kind: 'attack', weapon: 'Rapier' },
      { kind: 'save', ability: 'str' },
      { kind: 'check', skill: 'athletics' },
      { kind: 'check', ability: 'str' },
      { kind: 'attack', spell: 'Guiding Bolt' },
    ], tired, rules2024);
    expect(rolls.map((r) => r.bonus)).toEqual([2, 0, 0, -2, 1]);
    for (const r of rolls) expect(r.parts?.at(-1)).toEqual({ label: 'Exhaustion', value: -4 });
    rolls.forEach(exact);
    const [old] = build([{ kind: 'attack', weapon: 'Rapier' }], tired);
    expect(old.bonus).toBe(6);
    expect(old.parts?.some((p) => p.label === 'Exhaustion')).toBe(false);
    expect(old.advFrom).toBeUndefined();
    const [oldSpell] = build([{ kind: 'attack', spell: 'Guiding Bolt' }], tired);
    expect(oldSpell.bonus).toBe(5);
    expect(oldSpell.parts?.some((p) => p.label === 'Exhaustion')).toBe(false);
    const [save] = build([{ actor: 'Goblin', kind: 'save', spell: 'Sacred Flame', ability: 'dex', dc: 99 }], { ...tired, cantrips: ['sacred-flame'] }, rules2024);
    expect(save.dc).toBe(13);
    expect(C.derive(rules2024, tired).spellDc).toBe(13);
  });

  it('uses one stat block part for monsters and one Bonus part for DM-given NPC bonuses', () => {
    const rolls = build([
      { actor: 'Goblin', kind: 'attack', weapon: 'Scimitar', bonus: 99 },
      { actor: 'Goblin', kind: 'save', ability: 'dex', bonus: 99 },
      { actor: 'Goblin', kind: 'check', skill: 'stealth', bonus: 99 },
      { actor: 'Rook', kind: 'attack', bonus: 7 },
      { actor: 'Rook', kind: 'save', ability: 'wis', bonus: -2 },
      { actor: 'Rook', kind: 'check', ability: 'cha', bonus: 0 },
    ]);
    expect(rolls.map((r) => r.bonus)).toEqual([4, 2, 6, 7, -2, 0]);
    rolls.forEach((r, i) => {
      expect(r.parts).toEqual([{ label: i < 3 ? 'Stat block' : 'Bonus', value: r.bonus }]);
      exact(r);
    });
  });

  it('all varied buildRolls d20 outputs have parts that sum exactly to the existing bonus', () => {
    const raw: RawRoll[] = [
      ...['Longsword', 'Rapier', 'Longbow', 'Missing weapon'].map((weapon) => ({ kind: 'attack', weapon })),
      { kind: 'attack', spell: 'Guiding Bolt' },
      ...ABILITIES.flatMap((ability) => [{ kind: 'save', ability }, { kind: 'check', ability }]),
      { kind: 'unknown' },
    ];
    const skills = Object.keys(SKILLS).map((skill) => ({ kind: 'check', skill }));
    for (const data of [rules, rules2024]) {
      for (const exhaustion of [0, 1, 3, 5]) {
        for (const pc of [hero, caster]) {
          for (const batch of [raw, skills]) build(batch, { ...pc, exhaustion }, data).forEach(exact);
        }
      }
    }
    for (const kind of ['damage', 'heal']) expect(build([{ kind }])[0].parts).toBeUndefined();
  });
});

describe('advantage sources', () => {
  it('names Poisoned and keeps both sources when DM advantage cancels it', () => {
    const pc = { ...hero, conditions: [{ name: 'poisoned' }] };
    const [poisoned, cancelled] = build([{ kind: 'attack' }, { kind: 'attack', adv: 'adv' }], pc);
    expect(poisoned.adv).toBe('dis');
    expect(poisoned.advFrom).toEqual([{ adv: 'dis', from: 'Poisoned' }]);
    expect(cancelled.adv).toBe('none');
    expect(cancelled.advFrom).toEqual([{ adv: 'adv', from: 'The DM' }, { adv: 'dis', from: 'Poisoned' }]);
  });

  it('cancels all sources together, including Poisoned, Invisible and DM disadvantage', () => {
    const pc = { ...hero, conditions: [{ name: 'poisoned' }, { name: 'invisible' }, { name: 'hidden' }] };
    const [r] = build([{ kind: 'attack', adv: 'dis' }], pc);
    expect(r.adv).toBe('none');
    expect(R.conditionAdv(pc, 'attack')).toBe('none');
    expect(r.advFrom).toEqual([
      { adv: 'dis', from: 'The DM' }, { adv: 'dis', from: 'Poisoned' },
      { adv: 'adv', from: 'Invisible' }, { adv: 'adv', from: 'Hidden' },
    ]);
  });

  it('names each contributing condition, exhaustion and class feature', () => {
    const pc = { ...hero, class: 'barbarian', exhaustion: 3, conditions: [{ name: 'poisoned' }, { name: 'frightened' }, { name: 'raging' }] };
    const [r] = build([{ kind: 'check', ability: 'str' }], pc);
    expect(r.adv).toBe('none');
    expect(r.advFrom).toEqual([
      { adv: 'dis', from: 'Poisoned' }, { adv: 'dis', from: 'Frightened' },
      { adv: 'dis', from: 'Exhaustion' }, { adv: 'adv', from: 'Rage' },
    ]);
    const [save] = build([{ kind: 'save', ability: 'dex' }], { ...hero, conditions: [{ name: 'restrained' }, { name: 'dodging' }] });
    expect(save.adv).toBe('none');
    expect(save.advFrom).toEqual([{ adv: 'dis', from: 'Restrained' }, { adv: 'adv', from: 'Dodging' }]);
  });

  it('records every target condition currently granting advantage; prone alone has no effect today', () => {
    for (const name of ['blinded', 'paralyzed', 'restrained', 'stunned', 'unconscious', 'petrified', 'prone']) {
      const target = { ...caster, conditions: [{ name }] };
      const [r] = R.buildRolls(rules, [hero, target], [], { rolls: [{ actor: hero.name, kind: 'attack', target: target.name }] });
      expect(r.adv).toBe(name === 'prone' ? 'none' : 'adv');
      expect(r.advFrom).toEqual(name === 'prone' ? undefined : [{ adv: 'adv', from: `Target is ${name}` }]);
    }
    expect(build([{ kind: 'check' }])[0].advFrom).toBeUndefined();
  });
});

describe('roll outcome bookkeeping', () => {
  it.each([[12, true, 2], [8, false, -2]])('records attack margin with natural %i', (natural, success, margin) => {
    const [r] = build([{ kind: 'attack', weapon: 'Longsword', targetAc: 14 }]);
    const result = R.resolveRoll(r, [r], [natural]);
    expect(result).toMatchObject({ total: natural + 4, success, margin });
    expect(result.bonusRolls).toBeUndefined();
    // Compare the exact legacy text, including its existing punctuation.
    expect(result.text).toBe(`${r.label}: d20 ${natural} + 4 = ${natural + 4} vs AC 14 \u2014 ${success ? 'hit' : 'miss'} (rolled by the player)`);
  });

  it('records a failed save margin and leaves checks without DC and death saves without margin', () => {
    const [save, check] = build([{ kind: 'save', ability: 'str', dc: 14 }, { kind: 'check', ability: 'str' }]);
    expect(R.resolveRoll(save, [save], [8])).toMatchObject({ total: 12, success: false, margin: -2 });
    expect(R.resolveRoll(check, [check], [8]).margin).toBeUndefined();
    const death: PendingRoll = { id: 'death', actor: hero.name, kind: 'death', label: 'Death save', dice: '1d20', bonus: 0, dc: 10 };
    expect(R.resolveRoll(death, [death], [8]).margin).toBeUndefined();
  });

  it('records Bless separately without changing its total or text', () => {
    const [r] = build([{ kind: 'attack', weapon: 'Longsword', targetAc: 14 }], { ...hero, conditions: [{ name: 'blessed' }] });
    const result = R.resolveRoll(r, [r], [10, 3]);
    expect(result).toMatchObject({ total: 17, margin: 3, bonusRolls: [{ from: 'Bless', dice: '1d4', total: 3 }] });
    expect(result.text).toBe(`${r.label}: d20 10 + Bless 1d4 (3) + 4 = 17 vs AC 14 \u2014 hit (rolled by the player)`);
  });

  it('records multiple bonus dice and includes them in the margin even when targets are hidden', () => {
    const [r] = build([{ kind: 'save', ability: 'str', dc: 20 }], { ...hero, conditions: [{ name: 'blessed' }, { name: 'inspired', source: 'Bardic Inspiration d8' }] });
    const result = R.resolveRoll(r, [r], [10, 3, 6], { hideTargets: true });
    expect(result).toMatchObject({
      total: 23, margin: 3,
      bonusRolls: [{ from: 'Bless', dice: '1d4', total: 3 }, { from: 'Bardic Inspiration', dice: '1d8', total: 6 }],
      usedConditions: ['inspired'],
    });
    expect(result.text).not.toContain('DC 20');
  });
});

describe('other server d20 paths', () => {
  it('asked checks carry sheet parts and condition sources into resolveRoll', async () => {
    const store = await import('../src/game/store.js');
    const log = await import('../src/game/log.js');
    const engine = await import('../src/game/engine.js');
    const pc = { ...hero, exhaustion: 2, conditions: [{ name: 'poisoned' }] };
    const chars = vi.spyOn(store, 'gameCharacters').mockReturnValue([pc]);
    const logged = vi.spyOn(log, 'addLog').mockReturnValue({ id: 1, turn: 1, kind: 'roll', text: '', at: '' });
    const resolved = vi.spyOn(R, 'resolveRoll');
    const g = {
      id: 'game', hostId: 'host', name: 'Game', ruleset: 'srd52' as const, status: 'playing' as const,
      visibility: 'private' as const, settings: store.DEFAULT_SETTINGS, state: store.freshState(0), updatedAt: '',
    };
    try {
      for (const [i, body] of [{ skill: 'athletics' }, { skill: 'stealth' }, { ability: 'str' }].entries()) {
        const userId = `asked-player-${i}`;
        chars.mockReturnValue([{ ...pc, userId }]);
        expect(engine.freeRoll(g, { id: userId, username: 'Player' }, body)).toEqual({});
        const r = resolved.mock.calls.at(-1)![0];
        expect(r.id).toBe('asked');
        expect(r.parts).toEqual(i === 0
          ? [{ label: 'STR', value: 2 }, { label: 'Proficiency', value: 2 }, { label: 'Exhaustion', value: -4 }]
          : [{ label: i === 1 ? 'DEX' : 'STR', value: i === 1 ? 4 : 2 }, { label: 'Exhaustion', value: -4 }]);
        expect(r.bonus).toBe(i === 2 ? -2 : 0);
        expect(r.advFrom).toEqual([{ adv: 'dis', from: 'Poisoned' }]);
        exact(r);
      }
      expect(logged).toHaveBeenCalledTimes(3);
    } finally {
      resolved.mockRestore();
      logged.mockRestore();
      chars.mockRestore();
    }
  });

  it('initiative remains a direct roll with its existing DEX and 2024 exhaustion totals', async () => {
    const { rollInitiative } = await import('../src/game/initiative.js');
    const pc = { ...hero, exhaustion: 2 };
    expect(rollInitiative(rules, [pc], [goblin], [], () => 10).order).toEqual([
      { name: hero.name, characterId: hero.id, roll: 10, bonus: 4, total: 14 },
      { name: goblin.name, roll: 10, bonus: 2, total: 12 },
    ]);
    expect(rollInitiative(rules2024, [pc], [], [], () => 10).order[0]).toEqual({ name: hero.name, characterId: hero.id, roll: 10, bonus: 0, total: 10 });
  });
});
