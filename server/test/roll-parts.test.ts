import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type GameCharacter, type Npc, type PendingRoll, type RulesData } from '@dungeonmind/shared';
import { beforeAll, describe, expect, it } from 'vitest';
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

describe('ranged weapon rules', () => {
  it.each(['Shortbow', 'Longbow', 'Crossbow, light', 'Crossbow, heavy', 'Crossbow, hand', 'Sling'])('%s uses DEX for attacks and damage in 2014 games', (weapon) => {
    const item = rules.items.find((w) => w.name === weapon)!;
    expect(item).toBeDefined();
    const pc = { ...hero, inventory: [{ name: weapon, qty: 1, equipped: true }] };
    const [attack, damage] = build([{ id: 'a', kind: 'attack', weapon }, { kind: 'damage', weapon, onHit: 'a' }], pc);
    expect(attack.bonus).toBe(6);
    expect(damage.dice).toBe(`${item.damage}+4`);
  });

  it('uses DEX when a weapon category explicitly says ranged', () => {
    const ranged = { ...rules, items: rules.items.map((item) => item.id === 'longbow' ? { ...item, category: 'Martial Ranged Weapons' } : item) };
    expect(build([{ kind: 'attack', weapon: 'Longbow' }], hero, ranged)[0].bonus).toBe(6);
  });

  it('uses DEX for SRD 5.1 nets and preserves dart finesse in both rulesets', async () => {
    const { isRanged } = await import('../src/game/features.js');
    const pc = { ...hero, inventory: ['Net', 'Dart'].map((name) => ({ name, qty: 1, equipped: true })) };
    expect(build([{ kind: 'attack', weapon: 'Net' }], pc)[0].bonus).toBe(6);
    expect(isRanged(rules, rules.items.find((w) => w.id === 'net'))).toBe(true);
    expect(isRanged(rules2024, rules2024.items.find((w) => w.id === 'net'))).toBe(false);
    for (const data of [rules, rules2024]) {
      expect(isRanged(data, data.items.find((w) => w.id === 'dart'))).toBe(true);
      for (const [str, bonus, damage] of [[14, 6, '1d4+4'], [20, 7, '1d4+5']] as const) {
        const dartPc = { ...pc, abilities: { ...pc.abilities, str } };
        const rolls = build([{ id: 'a', kind: 'attack', weapon: 'Dart' }, { kind: 'damage', weapon: 'Dart', onHit: 'a' }], dartPc, data);
        expect(rolls[0].bonus).toBe(bonus);
        expect(rolls[1].dice).toBe(damage);
      }
      for (const id of ['dagger', 'handaxe', 'javelin', 'spear', 'light-hammer', 'trident']) {
        const item = data.items.find((w) => w.id === id);
        expect(item, id).toBeDefined();
        expect(isRanged(data, item), id).toBe(false);
      }
    }
  });
});

describe('2024 exhaustion', () => {
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
    const [old] = build([{ kind: 'attack', weapon: 'Rapier' }], tired);
    expect(old.bonus).toBe(6);
    const [oldSpell] = build([{ kind: 'attack', spell: 'Guiding Bolt' }], tired);
    expect(oldSpell.bonus).toBe(5);
    const [save] = build([{ actor: 'Goblin', kind: 'save', spell: 'Sacred Flame', ability: 'dex', dc: 99 }], { ...tired, cantrips: ['sacred-flame'] }, rules2024);
    expect(save.dc).toBe(13);
    expect(C.derive(rules2024, tired).spellDc).toBe(13);
  });

});

describe('advantage sources', () => {
  it('names Poisoned and keeps both sources when DM advantage cancels it', () => {
    const pc = { ...hero, conditions: [{ name: 'poisoned' }] };
    const [poisoned, cancelled] = build([{ kind: 'attack' }, { kind: 'attack', adv: 'adv' }], pc);
    expect(poisoned.adv).toBe('dis');
    expect(cancelled.adv).toBe('none');
  });

  it('cancels all sources together, including Poisoned, Invisible and DM disadvantage', () => {
    const pc = { ...hero, conditions: [{ name: 'poisoned' }, { name: 'invisible' }, { name: 'hidden' }] };
    const [r] = build([{ kind: 'attack', adv: 'dis' }], pc);
    expect(r.adv).toBe('none');
    expect(R.conditionAdv(pc, 'attack')).toBe('none');
  });

  it('names each contributing condition, exhaustion and class feature', () => {
    const pc = { ...hero, class: 'barbarian', exhaustion: 3, conditions: [{ name: 'poisoned' }, { name: 'frightened' }, { name: 'raging' }] };
    const [r] = build([{ kind: 'check', ability: 'str' }], pc);
    expect(r.adv).toBe('none');
    const [save] = build([{ kind: 'save', ability: 'dex' }], { ...hero, conditions: [{ name: 'restrained' }, { name: 'dodging' }] });
    expect(save.adv).toBe('none');
  });

  it('records every target condition currently granting advantage; prone alone has no effect today', () => {
    for (const name of ['blinded', 'paralyzed', 'restrained', 'stunned', 'unconscious', 'petrified', 'prone']) {
      const target = { ...caster, conditions: [{ name }] };
      const [r] = R.buildRolls(rules, [hero, target], [], { rolls: [{ actor: hero.name, kind: 'attack', target: target.name }] });
      expect(r.adv).toBe(name === 'prone' ? 'none' : 'adv');
      }
  });
});

describe('cancellation across source groups', () => {
  it('does not revive target advantage after actor conditions cancel', () => {
    const pc = { ...hero, conditions: [{ name: 'poisoned' }, { name: 'invisible' }] };
    const target = { ...caster, conditions: [{ name: 'restrained' }] };
    const [r] = R.buildRolls(rules, [pc, target], [], { rolls: [{ actor: pc.name, kind: 'attack', target: target.name }] });
    expect(r.adv).toBe('none');
  });

  it('does not revive DM advantage after save conditions cancel', () => {
    const pc = { ...hero, conditions: [{ name: 'restrained' }, { name: 'dodging' }] };
    expect(build([{ kind: 'save', ability: 'dex', adv: 'adv' }], pc)[0].adv).toBe('none');
  });

  it('does not revive feature advantage after check conditions cancel', () => {
    const pc = { ...hero, class: 'barbarian', conditions: [{ name: 'poisoned' }, { name: 'raging' }] };
    expect(build([{ kind: 'check', ability: 'str', adv: 'adv' }], pc)[0].adv).toBe('none');
  });
});
