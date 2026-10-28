import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterBuild, RulesData } from '@dungeonmind/shared';
import { beforeAll, describe, expect, it } from 'vitest';

let rules: (r: 'srd51' | 'srd52') => RulesData;
let lib: typeof import('../src/game/character.js');

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dm-builder-'));
  rules = (await import('../src/rules/index.js')).rules;
  lib = await import('../src/game/character.js');
});

const fighter51 = (over: Partial<CharacterBuild> = {}): CharacterBuild => ({
  ruleset: 'srd51',
  name: 'Turks',
  species: 'dwarf',
  subspecies: 'hill-dwarf',
  class: 'fighter',
  background: 'acolyte',
  level: 1,
  abilityMethod: 'standard',
  baseAbilities: { str: 15, dex: 12, con: 14, int: 8, wis: 13, cha: 10 },
  skills: ['athletics', 'perception'],
  equipment: ['Chain Mail', 'Shield', 'Longsword', '10 gp'],
  ...over,
});

const cleric52 = (over: Partial<CharacterBuild> = {}): CharacterBuild => ({
  ruleset: 'srd52',
  name: 'Esvahanna',
  species: 'human',
  class: 'cleric',
  background: 'acolyte',
  level: 3,
  subclass: 'life',
  abilityMethod: 'pointbuy',
  baseAbilities: { str: 10, dex: 12, con: 14, int: 8, wis: 15, cha: 12 },
  bonusChoices: { wis: 2, cha: 1 },
  skills: ['medicine', 'persuasion', 'history'],
  cantrips: ['guidance', 'sacred-flame', 'light'],
  spells: ['cure-wounds', 'bless', 'guiding-bolt', 'healing-word'],
  equipment: ['Chain Mail', 'Shield', 'Mace'],
  ...over,
});

describe('builder legality, SRD 5.1', () => {
  it('accepts a legal level 1 hill dwarf fighter', () => {
    expect(lib.validateBuild(rules('srd51'), fighter51())).toEqual([]);
  });

  it('applies racial bonuses, HP and AC', () => {
    const r = rules('srd51');
    const c = lib.buildCharacter(r, fighter51(), { id: 'x', ownerId: 'u' });
    expect(c.abilities).toMatchObject({ con: 16, wis: 14 }); // +2 CON dwarf, +1 WIS hill dwarf
    expect(c.maxHp).toBe(13); // d10 + 3
    expect(c.skills).toEqual(expect.arrayContaining(['insight', 'religion', 'athletics', 'perception']));
    const d = lib.derive(r, c);
    expect(d.ac).toBe(18); // chain mail 16 + shield 2
    expect(d.profBonus).toBe(2);
    expect(d.saveBonus.str).toBe(4);
    expect(c.gold).toBe(10);
    expect(c.counters.map((x) => x.name)).toEqual(['Hit Dice (d10)', 'Second Wind']);
  });

  it('refuses a broken standard array', () => {
    const e = lib.validateBuild(rules('srd51'), fighter51({ baseAbilities: { str: 15, dex: 15, con: 14, int: 8, wis: 13, cha: 10 } }));
    expect(e.join()).toMatch(/standard array/);
  });

  it('counts point buy costs', () => {
    const ok = fighter51({ abilityMethod: 'pointbuy', baseAbilities: { str: 15, dex: 14, con: 13, int: 8, wis: 10, cha: 8 } }); // 9+7+5+0+2+0 = 23
    expect(lib.validateBuild(rules('srd51'), ok)).toEqual([]);
    const over = fighter51({ abilityMethod: 'pointbuy', baseAbilities: { str: 15, dex: 15, con: 15, int: 8, wis: 8, cha: 8 } }); // 27 ok
    expect(lib.validateBuild(rules('srd51'), over)).toEqual([]);
    const bad = fighter51({ abilityMethod: 'pointbuy', baseAbilities: { str: 15, dex: 15, con: 15, int: 10, wis: 8, cha: 8 } }); // 29
    expect(lib.validateBuild(rules('srd51'), bad).join()).toMatch(/costs 29 of 27/);
  });

  it('checks rolled scores against the server roll', () => {
    const b = fighter51({ abilityMethod: 'rolled', baseAbilities: { str: 17, dex: 12, con: 14, int: 8, wis: 13, cha: 10 } });
    expect(lib.validateBuild(rules('srd51'), b, { rolled: [17, 14, 13, 12, 10, 8] })).toEqual([]);
    expect(lib.validateBuild(rules('srd51'), b, { rolled: [16, 14, 13, 12, 10, 8] }).join()).toMatch(/server rolled/);
  });

  it('limits skills to the class list and count', () => {
    expect(lib.validateBuild(rules('srd51'), fighter51({ skills: ['athletics', 'arcana'] })).join()).toMatch(/choose 2 skills/);
    expect(lib.validateBuild(rules('srd51'), fighter51({ skills: ['athletics', 'insight'] })).join()).toMatch(/1 more skill/); // insight comes from the background
    expect(lib.validateBuild(rules('srd51'), fighter51({ skills: ['athletics', 'perception', 'survival'] })).join()).toMatch(/choose 2 skills/);
    expect(lib.validateBuild(rules('srd51'), fighter51({ skills: ['athletics'] })).join()).toMatch(/1 more skill/);
  });

  it('requires a subrace and a subclass at the right level', () => {
    expect(lib.validateBuild(rules('srd51'), fighter51({ subspecies: undefined })).join()).toMatch(/subrace/);
    expect(lib.validateBuild(rules('srd51'), fighter51({ level: 3 })).join()).toMatch(/needs a subclass/);
    expect(lib.validateBuild(rules('srd51'), fighter51({ level: 3, subclass: 'champion' }))).toEqual([]);
  });

  it('gives half-elves two free +1s, never Charisma', () => {
    const he = (bonusChoices: CharacterBuild['bonusChoices']) => fighter51({ species: 'half-elf', subspecies: undefined, bonusChoices, skills: ['athletics', 'perception', 'stealth', 'arcana'] });
    expect(lib.validateBuild(rules('srd51'), he({ str: 1, con: 1 }))).toEqual([]);
    expect(lib.validateBuild(rules('srd51'), he({ cha: 1, con: 1 })).join()).toMatch(/other than Charisma/);
    expect(lib.validateBuild(rules('srd51'), he({ str: 2 })).join()).toMatch(/Half-elves/);
  });

  it('counts Ability Score Improvements', () => {
    const b = fighter51({ level: 4, subclass: 'champion', asi: { str: 2 } });
    expect(lib.validateBuild(rules('srd51'), b)).toEqual([]);
    expect(lib.validateBuild(rules('srd51'), { ...b, asi: { str: 2, con: 2 } }).join()).toMatch(/2 ability points/);
  });

  it('checks spells: on the list, within slot level, within the count', () => {
    const wiz = (spells: string[], cantrips = ['fire-bolt', 'light', 'mage-hand']): CharacterBuild => ({
      ...fighter51(),
      class: 'wizard',
      skills: ['arcana', 'history'],
      cantrips,
      spells,
    });
    expect(lib.validateBuild(rules('srd51'), wiz(['magic-missile', 'shield', 'sleep']))).toEqual([]);
    expect(lib.validateBuild(rules('srd51'), wiz(['fireball'])).join()).toMatch(/above your highest slot/);
    expect(lib.validateBuild(rules('srd51'), wiz(['cure-wounds'])).join()).toMatch(/not on the Wizard spell list/);
    expect(lib.validateBuild(rules('srd51'), wiz([], ['fire-bolt', 'light', 'mage-hand', 'prestidigitation'])).join()).toMatch(/knows 3 cantrips/);
  });
});

describe('builder legality, SRD 5.2', () => {
  it('accepts a legal level 3 life cleric with +2/+1 background bonuses', () => {
    expect(lib.validateBuild(rules('srd52'), cleric52())).toEqual([]);
  });

  it('puts background bonuses only on the background abilities', () => {
    expect(lib.validateBuild(rules('srd52'), cleric52({ bonusChoices: { str: 2, wis: 1 } })).join()).toMatch(/raises only INT, WIS, CHA/);
    expect(lib.validateBuild(rules('srd52'), cleric52({ bonusChoices: { wis: 2, cha: 2 } })).join()).toMatch(/\+2 and \+1/);
    expect(lib.validateBuild(rules('srd52'), cleric52({ bonusChoices: { int: 1, wis: 1, cha: 1 } }))).toEqual([]);
  });

  it('subclasses come at level 3 for everyone', () => {
    expect(lib.validateBuild(rules('srd52'), cleric52({ level: 2, subclass: undefined, spells: ['bless'] }))).toEqual([]);
    expect(lib.validateBuild(rules('srd52'), cleric52({ subclass: undefined })).join()).toMatch(/needs a subclass/);
  });

  it('builds counters: slots, Channel Divinity, hit dice', () => {
    const r = rules('srd52');
    const c = lib.buildCharacter(r, cleric52(), { id: 'x', ownerId: 'u' });
    const byName = Object.fromEntries(c.counters.map((x) => [x.name, x]));
    expect(byName['Spell slot L1']).toMatchObject({ max: 4, recharge: 'long' });
    expect(byName['Spell slot L2']).toMatchObject({ max: 2 });
    expect(byName['Channel Divinity']).toMatchObject({ max: 2, recharge: 'short' });
    expect(byName['Hit Dice (d8)']).toMatchObject({ max: 3 });
    expect(lib.derive(r, c).spellDc).toBe(8 + 2 + 3); // WIS 17
  });

  it('warlock pact slots recharge on a short rest', () => {
    const r = rules('srd51');
    const w = lib.buildCharacter(
      r,
      { ...fighter51(), class: 'warlock', subclass: 'fiend', level: 3, skills: ['arcana', 'deception'], cantrips: ['eldritch-blast', 'chill-touch'], spells: ['hellish-rebuke'] },
      { id: 'w', ownerId: 'u' },
    );
    expect(w.counters.find((c) => c.name === 'Spell slot L2')).toMatchObject({ max: 2, recharge: 'short' });
  });

  it('a rebuild keeps spent resources and lost HP', () => {
    const r = rules('srd52');
    const c = lib.buildCharacter(r, cleric52(), { id: 'x', ownerId: 'u' });
    c.counters.find((x) => x.name === 'Channel Divinity')!.current = 0;
    c.hp -= 5;
    const again = lib.buildCharacter(r, cleric52({ name: 'Esva' }), { id: 'x', ownerId: 'u', prev: c });
    expect(again.counters.find((x) => x.name === 'Channel Divinity')!.current).toBe(0);
    expect(again.hp).toBe(c.maxHp - 5);
  });
});
