import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeatureEffect, GameCharacter, Npc, PendingRoll, RulesData } from '@dungeonmind/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseDice } from '../src/game/dice.js';
// Loaded after DATA_DIR points at a temp folder: the config would otherwise make server/data/secret.key.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dm-features-'));
const { evalFormula, featureDamage, levelValue } = await import('../src/game/features.js');
type Vars = import('../src/game/features.js').Vars;

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const DAMAGE_TYPES = ['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'];
const FIELDS = ['subclass', 'counter', 'grants', 'while', 'damage', 'heal', 'advantage', 'resist', 'critOn', 'note'];
/** Choices the sheet doesn't record yet (invocations, pact boons, weapon masteries) and spell slots, which come from the class table. */
const NOT_TRACKED = /eldritch-invocation|pact-of-|pact-boon|weapon-mastery|spellcasting|pact-magic/;
/** Text that says a feature comes back on a rest: it needs an entry. */
const RESTS = /finish(es)? a (short or long|short|long) rest/i;

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '').replace(/(\w)-(\w)/g, '$1$2');

describe.each(['srd51', 'srd52'])('%s class features', (ruleset) => {
  const rules = JSON.parse(readFileSync(new URL(`../data/${ruleset}/rules.json`, import.meta.url), 'utf8')) as RulesData;
  const effects = JSON.parse(readFileSync(new URL(`../data/${ruleset}/class-features.json`, import.meta.url), 'utf8')) as Record<string, FeatureEffect>;
  const feature = (id: string) => rules.features.find((f) => f.id === id)!;
  const entries = Object.entries(effects);
  /** What a feature's numbers see at a class level, with every ability at 14. */
  const vars = (classId: string, level: number): Vars => {
    const cls = rules.classes.find((c) => c.id === classId)!;
    const v: Vars = { level, pb: 2 + Math.floor((level - 1) / 4), ...Object.fromEntries(ABILITIES.map((a) => [a, 2])) };
    for (const [k, x] of Object.entries(cls.levels[level - 1].classSpecific ?? {})) if (typeof x === 'number') v[k] = x;
    return v;
  };

  it('only names features of this ruleset', () => {
    expect(entries.map(([id]) => id).filter((id) => !feature(id))).toEqual([]);
  });

  it.each(entries)('%s is well-formed', (id, e) => {
    const f = feature(id);
    if (!f) return;
    const text = squash(f.desc);
    const cls = rules.classes.find((c) => c.id === f.owner)!;
    expect(Object.keys(e).filter((k) => !FIELDS.includes(k)), 'unknown fields').toEqual([]);
    if (e.subclass) expect(cls.subclasses.map((s) => s.id)).toContain(e.subclass);
    if (e.counter) {
      expect(Object.keys(e.counter).filter((k) => !['name', 'uses', 'recharge', 'regain'].includes(k))).toEqual([]);
      if (e.counter.recharge) expect(['short', 'long', 'dawn', 'turn']).toContain(e.counter.recharge);
      if (e.counter.regain) expect(e.counter.recharge ?? 'long', 'regain is for long-rest counters').toBe('long');
    }
    for (let level = f.level ?? 1; level <= 20; level++) {
      const v = vars(cls.id, level);
      if (e.counter?.uses !== undefined) expect(levelValue(e.counter.uses, v), `uses at ${level}`).toBeGreaterThanOrEqual(0);
      if (e.damage) expect(() => parseDice(featureDamage(e.damage!, v)!), `damage at ${level}`).not.toThrow();
      if (e.heal) expect(() => (/d\d/.test(e.heal!) ? parseDice(e.heal!.replace(/[a-z_]+(?![\dd])/g, '1')) : evalFormula(e.heal!, v))).not.toThrow();
    }
    if (e.damage) {
      for (const t of e.damage.type.split('|')) expect([...DAMAGE_TYPES, 'weapon']).toContain(t);
      // Dice written out have to be the ones the SRD text names; tables start with them.
      // (Frenzy's dice are "a number of d6s equal to your Rage Damage bonus".)
      const first = typeof e.damage.dice === 'string' ? e.damage.dice : Object.values(e.damage.dice)[0];
      if (/\d+d\d+/.test(first) && id !== 'berserker-frenzy') expect(text, `${first} is not in the text`).toContain(first);
      if (e.damage.slot) for (const t of [e.damage.slot.upcast, e.damage.slot.max]) expect(text).toContain(t);
    }
    if (e.heal) for (const t of e.heal.match(/\d+d\d+/g) ?? []) expect(text).toContain(t);
    for (const a of e.advantage ?? []) {
      expect(['attack', 'save', 'check']).toContain(a.kind);
      if (a.ability) expect(ABILITIES).toContain(a.ability);
    }
    for (const t of e.resist ?? []) expect(DAMAGE_TYPES).toContain(t);
    if (e.critOn) expect([18, 19]).toContain(e.critOn);
    if (e.grants || e.while) expect((e.grants ?? { name: e.while }).name).toMatch(/^[a-z ]+$/);
  });

  it('Sneak Attack dice follow the class table', () => {
    const id = ruleset === 'srd51' ? 'sneak-attack' : 'rogue-sneak-attack';
    for (let level = 1; level <= 20; level++) {
      const col = rules.classes.find((c) => c.id === 'rogue')!.levels[level - 1].classSpecific!.sneak_attack as { dice_count: number; dice_value: number };
      expect(featureDamage(effects[id].damage!, vars('rogue', level))).toBe(`${col.dice_count}d${col.dice_value}`);
    }
  });

  it('covers every feature that comes back on a rest', () => {
    const covered = new Set(entries.map(([id]) => feature(id)?.desc));
    const missing = rules.features.filter((f) => RESTS.test(f.desc) && !NOT_TRACKED.test(f.id) && !covered.has(f.desc)).map((f) => f.id);
    expect(missing).toEqual([]);
  });
});

describe('formulas', () => {
  it('works out uses', () => {
    expect(evalFormula('max(1, cha)', { cha: -1 })).toBe(1);
    expect(evalFormula('5 * level', { level: 7 })).toBe(35);
    expect(evalFormula('(level + 1) / 2', { level: 4 })).toBe(2);
    expect(levelValue({ 2: 1, 17: 2 }, { level: 16 })).toBe(1);
    expect(() => evalFormula('level + nope', { level: 1 })).toThrow(/nope/);
  });

  it('caps a 2014 Divine Smite at 5d8', () => {
    const smite = { dice: '2d8', type: 'radiant', on: 'melee-weapon' as const, ask: true, slot: { upcast: '1d8', max: '5d8' } };
    expect([1, 2, 4, 9].map((slot) => featureDamage(smite, { level: 17 }, slot))).toEqual(['2d8', '3d8', '5d8', '5d8']);
  });
});

describe('class features at the table', () => {
  let R: typeof import('../src/game/rolls.js');
  let F: typeof import('../src/game/features.js');
  let B: typeof import('../src/game/bookkeeper.js');
  const pcs: Record<string, GameCharacter> = {};
  const r: Record<string, RulesData> = {};
  const mod = (c: GameCharacter, a: 'str' | 'dex') => Math.floor((c.abilities[a] - 10) / 2);
  const ogre = (): Npc => ({ name: 'Ogre', hp: 59, maxHp: 59, ac: 11, status: 'hostile' });
  const attack = (actor: string, extra: object = {}) => [
    { id: 'a', actor, kind: 'attack', target: 'Ogre' },
    { id: 'd', actor, kind: 'damage', target: 'Ogre', onHit: 'a', ...extra },
  ];

  beforeAll(async () => {
    R = await import('../src/game/rolls.js');
    F = await import('../src/game/features.js');
    B = await import('../src/game/bookkeeper.js');
    const { rules } = await import('../src/rules/index.js');
    const { buildCharacter } = await import('../src/game/character.js');
    const make = (ruleset: 'srd51' | 'srd52', id: string, name: string, cls: string, subclass: string, level: number, weapon: string, baseAbilities: Record<string, number>) => {
      r[ruleset] = rules(ruleset);
      const b = { ruleset, name, class: cls, subclass, level, species: 'human', background: ruleset === 'srd51' ? 'acolyte' : 'sage', abilityMethod: 'standard' as const, baseAbilities: baseAbilities as any, skills: [], equipment: [weapon] };
      pcs[id] = { ...buildCharacter(r[ruleset], b, { id, ownerId: 'u' }), userId: 'u', seated: true, absent: false };
    };
    make('srd51', 'rogue', 'Vex', 'rogue', 'thief', 5, 'Rapier', { str: 10, dex: 15, con: 13, int: 12, wis: 14, cha: 8 });
    make('srd51', 'paladin', 'Aldo', 'paladin', 'devotion', 5, 'Longsword', { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 });
    make('srd51', 'fighter', 'Brakka', 'fighter', 'champion', 3, 'Longsword', { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 });
    make('srd52', 'barbarian', 'Hrok', 'barbarian', 'path-of-the-berserker', 9, 'Greataxe', { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 });
  });

  it('adds Sneak Attack once per turn, and only when the adjudicator names it', () => {
    const vex = pcs.rogue;
    const rolls = R.buildRolls(r.srd51, [vex], [ogre()], {
      rolls: [...attack('Vex', { features: ['Sneak Attack'] }), { id: 'a2', actor: 'Vex', kind: 'attack', target: 'Ogre' }, { id: 'd2', actor: 'Vex', kind: 'damage', target: 'Ogre', onHit: 'a2', features: ['sneak attack'] }],
    });
    expect(rolls[1].dice).toBe(`1d8+${mod(pcs.rogue, 'dex')}+3d6`);
    expect(rolls[1].label).toMatch(/Sneak Attack 3d6/);
    expect(rolls[3].dice).toBe(`1d8+${mod(pcs.rogue, 'dex')}`);
    expect(R.buildRolls(r.srd51, [vex], [ogre()], { rolls: attack('Vex') })[1].dice).toBe(`1d8+${mod(pcs.rogue, 'dex')}`);
  });

  it('smites with the slot the adjudicator spends, and not without one', () => {
    const aldo = pcs.paladin;
    const smite = (resources: { pc: string; name: string; amount: number }[]) => R.buildRolls(r.srd51, [aldo], [ogre()], { rolls: attack('Aldo', { features: ['Divine Smite'] }), resources })[1];
    expect(smite([{ pc: 'Aldo', name: 'Spell slot L2', amount: 1 }])).toMatchObject({ dice: `1d8+${mod(pcs.paladin, 'str')}+3d8`, damageType: 'slashing, radiant' });
    const free = smite([]);
    expect(free.dice).toBe(`1d8+${mod(pcs.paladin, 'str')}`);
    expect(free.reason).toMatch(/Divine Smite needs a spell slot/);
  });

  it('does not apply Divine Smite to a dart, while daggers and javelins stay melee', () => {
    for (const weapon of ['Dart', 'Dagger', 'Javelin']) {
      const pc = { ...pcs.paladin, inventory: [{ name: weapon, qty: 1, equipped: true }] };
      const rolls = R.buildRolls(r.srd51, [pc], [ogre()], {
        rolls: [
          { id: 'a', actor: pc.name, kind: 'attack', weapon, target: 'Ogre' },
          { actor: pc.name, kind: 'damage', weapon, target: 'Ogre', onHit: 'a', features: ['Divine Smite'] },
        ],
        resources: [{ pc: pc.name, name: 'Spell slot L1', amount: 1 }],
      });
      const damage = rolls[1];
      expect(damage.label.includes('Divine Smite')).toBe(weapon !== 'Dart');
      expect(damage.dice.endsWith('+2d8')).toBe(weapon !== 'Dart');
      const item = r.srd51.items.find((w) => w.name === weapon)!;
      expect(F.isRanged(r.srd51, item)).toBe(weapon === 'Dart');
    }
  });

  it('crits on 19 with Improved Critical, weapon attacks only', () => {
    const [a] = R.buildRolls(r.srd51, [pcs.fighter], [ogre()], { rolls: attack('Brakka') });
    expect(a.critOn).toBe(19);
    const all = [a];
    expect(R.resolveRoll(a, all, [19]).crit).toBe(true);
    expect(R.buildRolls(r.srd51, [pcs.rogue], [ogre()], { rolls: attack('Vex') })[0].critOn).toBeUndefined();
  });

  it('heals Second Wind with the real dice', () => {
    const [h] = R.buildRolls(r.srd51, [pcs.fighter], [], { rolls: [{ actor: 'Brakka', kind: 'heal', target: 'Brakka', dice: '2d10', features: ['Second Wind'] }] });
    expect(h.dice).toBe('1d10+3');
  });

  it('Rage: spending it makes the barbarian raging, with damage, advantage and resistance', () => {
    const hrok = structuredClone(pcs.barbarian);
    const plain = R.buildRolls(r.srd52, [hrok], [ogre()], { rolls: attack('Hrok') })[1].dice;
    expect(plain).toBe('1d12+2');
    expect(F.grantConditions(r.srd52, [hrok], [{ characterId: hrok.id, name: 'Rage' }])).toEqual(['Hrok is raging']);
    expect(hrok.conditions).toEqual([{ name: 'raging', rounds: 100, source: 'Rage' }]);
    const rolls = R.buildRolls(r.srd52, [hrok], [ogre()], {
      rolls: [...attack('Hrok'), { actor: 'Hrok', kind: 'check', ability: 'str', dc: 15 }, { actor: 'Hrok', kind: 'save', ability: 'dex', dc: 15 }],
    });
    expect(rolls[1].dice).toBe('1d12+2+3');
    expect(rolls.slice(2).map((x) => x.adv)).toEqual(['adv', 'none']);
    // An ogre's club: halved; fire: not.
    const hit = (damageType: string): PendingRoll => ({ id: 'x', actor: 'Ogre', kind: 'damage' as const, label: '', dice: '2d8+4', bonus: 0, target: 'Hrok', damageType, result: { dice: [], total: 13, manual: false, text: '' } });
    const fx = R.rollEffects([hit('bludgeoning'), hit('fire')], [hrok], [], (c) => F.resistances(r.srd52, c));
    expect(fx.pcs.get(hrok.id)!.damage).toBe(6 + 13);
    expect(fx.resisted).toEqual(['Hrok resists bludgeoning: 13 → 6']);
  });

  it('2024: a short rest gives back one Rage, a long rest all', () => {
    const hrok = structuredClone(pcs.barbarian);
    const rage = hrok.counters.find((k) => k.name === 'Rage')!;
    expect(rage).toMatchObject({ max: 4, recharge: 'long', regain: 1 });
    rage.current = 0;
    B.rest([hrok], 'short', 'srd52');
    expect(rage.current).toBe(1);
    B.rest([hrok], 'long', 'srd52');
    expect(rage.current).toBe(4);
  });

  it('tells the AI what each feature does', () => {
    const lines = F.featureLines(r.srd51, pcs.rogue);
    expect(lines.find((l) => l.startsWith('Sneak Attack'))).toMatch(/\+3d6 on finesse or ranged weapon hits, once per turn; name it/);
    expect(F.featureLines(r.srd52, pcs.barbarian).join('\n')).toMatch(/Rage: spending it makes you raging; \+3 on Strength melee hits; advantage on STR checks, STR saves; resists bludgeoning, piercing, slashing/);
  });
});
