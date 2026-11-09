import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterBuild, RulesData } from '@dungeonmind/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let rules: (r: 'srd51' | 'srd52') => RulesData;
let findIn: typeof import('../src/rules/index.js')['findIn'];
let memoryEntries: typeof import('../src/rules/index.js')['memoryEntries'];
let searchRules: typeof import('../src/rules/index.js')['searchRules'];
let lib: typeof import('../src/game/character.js');
let dataDir: string;
const originalDataDir = process.env.DATA_DIR;
const baseJson = readFileSync(new URL('../data/srd51/rules.json', import.meta.url), 'utf8');
const base51 = JSON.parse(baseJson) as RulesData;
const base52 = JSON.parse(readFileSync(new URL('../data/srd52/rules.json', import.meta.url), 'utf8')) as RulesData;
type Origins = Pick<RulesData, 'backgrounds' | 'feats' | 'traits'> & {
  subspecies: Record<string, RulesData['species'][number]['subspecies']>;
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'dm-origins-'));
  process.env.DATA_DIR = dataDir;
  rules = (await import('../src/rules/index.js')).rules;
  findIn = (await import('../src/rules/index.js')).findIn;
  memoryEntries = (await import('../src/rules/index.js')).memoryEntries;
  searchRules = (await import('../src/rules/index.js')).searchRules;
  lib = await import('../src/game/character.js');
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

// Same legal level-1 fighter setup as builder.test.ts.
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

const backgrounds = [
  { id: 'charlatan', skills: ['deception', 'sleight-of-hand'], tools: ['Disguise kit', 'Forgery kit'], languages: 0, gold: 15 },
  { id: 'criminal', skills: ['deception', 'stealth'], tools: ['One type of gaming set', "Thieves' tools"], languages: 0, gold: 15 },
  { id: 'entertainer', skills: ['acrobatics', 'performance'], tools: ['Disguise kit', 'One type of musical instrument'], languages: 0, gold: 15 },
  { id: 'folk-hero', skills: ['animal-handling', 'survival'], tools: ["One type of artisan's tools", 'Vehicles (land)'], languages: 0, gold: 10 },
  { id: 'guild-artisan', skills: ['insight', 'persuasion'], tools: ["One type of artisan's tools"], languages: 1, gold: 15 },
  { id: 'hermit', skills: ['medicine', 'religion'], tools: ['Herbalism kit'], languages: 1, gold: 5 },
  { id: 'noble', skills: ['history', 'persuasion'], tools: ['One type of gaming set'], languages: 1, gold: 25 },
  { id: 'outlander', skills: ['athletics', 'survival'], tools: ['One type of musical instrument'], languages: 1, gold: 10 },
  { id: 'sage', skills: ['arcana', 'history'], tools: [], languages: 2, gold: 10 },
  { id: 'sailor', skills: ['athletics', 'perception'], tools: ["Navigator's tools", 'Vehicles (water)'], languages: 0, gold: 10 },
  { id: 'soldier', skills: ['athletics', 'intimidation'], tools: ['One type of gaming set', 'Vehicles (land)'], languages: 0, gold: 10 },
  { id: 'urchin', skills: ['sleight-of-hand', 'stealth'], tools: ['Disguise kit', "Thieves' tools"], languages: 0, gold: 10 },
];

const subspecies = [
  { species: 'dwarf', id: 'mountain-dwarf' },
  { species: 'elf', id: 'wood-elf' },
  { species: 'elf', id: 'dark-elf' },
  { species: 'halfling', id: 'stout-halfling' },
  { species: 'gnome', id: 'forest-gnome' },
  ...['black', 'blue', 'brass', 'bronze', 'copper', 'gold', 'green', 'red', 'silver', 'white'].map((color) => ({
    species: 'dragonborn', id: `draconic-ancestry-${color}`,
  })),
];

describe('standard origins, SRD 5.1', () => {
  it('loads Acolyte plus the twelve standard backgrounds and all fifteen new subspecies', () => {
    const r = rules('srd51');
    expect(r.backgrounds).toHaveLength(13);
    expect(r.backgrounds.map((b) => b.id).sort()).toEqual(['acolyte', ...backgrounds.map((b) => b.id)].sort());
    const added = r.species.flatMap((s) => s.subspecies
      .filter((sub) => !base51.species.find((original) => original.id === s.id)?.subspecies.some((original) => original.id === sub.id))
      .map((sub) => ({ species: s.id, id: sub.id })));
    expect(added.map((s) => `${s.species}:${s.id}`).sort()).toEqual(subspecies.map((s) => `${s.species}:${s.id}`).sort());
  });

  it.each(backgrounds)('$id has the standard proficiencies and builds a legal level-1 character', (expected) => {
    const r = rules('srd51');
    const background = r.backgrounds.find((b) => b.id === expected.id)!;
    expect(background).toMatchObject({ skills: expected.skills, tools: expected.tools, source: 'standard option, own words' });
    expect(background.languages).toBe(expected.languages || undefined);
    expect(background.skills.every((id) => r.skills.some((s) => s.id === id))).toBe(true);
    expect(background.feature).toMatch(/^[^:]+: .+/);
    expect(background.equipment).toContain(`${expected.gold} gp`);
    const fighter = r.classes.find((c) => c.id === 'fighter')!;
    const build = fighter51({
      background: expected.id,
      skills: fighter.skillChoices.from.filter((s) => !background.skills.includes(s)).slice(0, fighter.skillChoices.choose),
      equipment: background.equipment,
    });
    expect(lib.validateBuild(r, build)).toEqual([]);
    const character = lib.buildCharacter(r, build, { id: expected.id, ownerId: 'u' });
    expect(character).toMatchObject({ background: expected.id, level: 1, gold: expected.gold });
    expect(character.skills).toEqual(expect.arrayContaining(expected.skills));
  });

  it.each(subspecies)('$id builds a legal level-1 character', ({ species, id }) => {
    const r = rules('srd51');
    expect(r.species.find((s) => s.id === species)?.subspecies.some((s) => s.id === id)).toBe(true);
    // Elves already have Perception; Acolyte already grants Insight and Religion.
    const build = fighter51({ species, subspecies: id, skills: ['athletics', 'survival'] });
    expect(lib.validateBuild(r, build)).toEqual([]);
    const character = lib.buildCharacter(r, build, { id, ownerId: 'u' });
    expect(character).toMatchObject({ species, subspecies: id, level: 1 });
    expect(lib.derive(r, character).speed).toBeGreaterThan(0);
  });

  it('adds both the dwarf CON bonus and Mountain Dwarf STR bonus', () => {
    const r = rules('srd51');
    const build = fighter51({ subspecies: 'mountain-dwarf' });
    expect(lib.validateBuild(r, build)).toEqual([]);
    const character = lib.buildCharacter(r, build, { id: 'mountain', ownerId: 'u' });
    expect(character.abilities.str).toBe(build.baseAbilities.str + 2);
    expect(character.abilities.con).toBe(build.baseAbilities.con + 2);
  });

  it.each([{ id: 'wood-elf', speed: 35 }, { id: 'high-elf', speed: 30 }])('$id derives speed $speed', ({ id, speed }) => {
    const r = rules('srd51');
    const build = fighter51({ species: 'elf', subspecies: id, skills: ['athletics', 'survival'] });
    expect(lib.validateBuild(r, build)).toEqual([]);
    expect(lib.derive(r, lib.buildCharacter(r, build, { id, ownerId: 'u' })).speed).toBe(speed);
  });

  it('resolves every subspecies trait except the dragonborn breath and resistance labels', () => {
    const r = rules('srd51');
    const traitNames = new Set(r.traits.map((t) => t.name));
    for (const species of r.species) {
      for (const sub of species.subspecies) {
        for (const name of sub.traits) {
          // SRD 5.2 also represents these choices as labels, not separate trait entries.
          if (/^(Breath Weapon:|Damage Resistance:)/.test(name)) continue;
          expect(traitNames.has(name), `${sub.id}: ${name}`).toBe(true);
        }
      }
    }
  });

  it.each([
    { id: 'wood-elf', name: 'Wood Elf', parent: 'Elf', speed: 35, mechanics: ['WIS +1', 'Mask of the Wild'] },
    { id: 'draconic-ancestry-black', name: 'Draconic Ancestry: Black', parent: 'Dragonborn', speed: 30, mechanics: ['Acid', '5 by 30 ft. line', 'DEX save', 'Damage Resistance: Acid'] },
  ])('indexes $name mechanics in memory and rules search', ({ id, name, parent, speed, mechanics }) => {
    const entries = memoryEntries('srd51');
    const entry = entries.find((e) => e.kind === 'Subspecies' && e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.text).toContain(`Parent species: ${parent}`);
    expect(entry!.text).toContain(`Speed ${speed} feet`);
    for (const mechanic of mechanics) expect(entry!.text).toContain(mechanic);
    expect(entries.some((e) => e.kind === 'Species' && e.name === parent)).toBe(true);
    expect(searchRules('srd51', name)).toContainEqual(expect.objectContaining(entry!));
  });

  it('keeps origins data in plain ASCII', () => {
    expect(readFileSync(new URL('../data/srd51/origins.json', import.meta.url), 'utf8')).not.toMatch(/[^\x09\x0a\x0d\x20-\x7e]/);
  });
});

const backgrounds52 = [
  { id: 'artisan', skills: ['investigation', 'persuasion'], abilityOptions: ['str', 'dex', 'int'], feat: 'Crafter', tools: ["One kind of artisan's tools"], gold: 32 },
  { id: 'charlatan', skills: ['deception', 'sleight-of-hand'], abilityOptions: ['dex', 'con', 'cha'], feat: 'Skilled', tools: ['Forgery kit'], gold: 15 },
  { id: 'entertainer', skills: ['acrobatics', 'performance'], abilityOptions: ['str', 'dex', 'cha'], feat: 'Musician', tools: ['One kind of musical instrument'], gold: 11 },
  { id: 'farmer', skills: ['animal-handling', 'nature'], abilityOptions: ['str', 'con', 'wis'], feat: 'Tough', tools: ["Carpenter's tools"], gold: 30 },
  { id: 'guard', skills: ['athletics', 'perception'], abilityOptions: ['str', 'int', 'wis'], feat: 'Alert', tools: ['One kind of gaming set'], gold: 12 },
  { id: 'guide', skills: ['stealth', 'survival'], abilityOptions: ['dex', 'con', 'wis'], feat: 'Magic Initiate (Druid)', tools: ["Cartographer's tools"], gold: 3 },
  { id: 'hermit', skills: ['medicine', 'religion'], abilityOptions: ['con', 'wis', 'cha'], feat: 'Healer', tools: ['Herbalism kit'], gold: 16 },
  { id: 'merchant', skills: ['animal-handling', 'persuasion'], abilityOptions: ['con', 'int', 'cha'], feat: 'Lucky', tools: ["Navigator's tools"], gold: 22 },
  { id: 'noble', skills: ['history', 'persuasion'], abilityOptions: ['str', 'int', 'cha'], feat: 'Skilled', tools: ['One kind of gaming set'], gold: 29 },
  { id: 'sailor', skills: ['acrobatics', 'perception'], abilityOptions: ['str', 'dex', 'wis'], feat: 'Tavern Brawler', tools: ["Navigator's tools"], gold: 20 },
  { id: 'scribe', skills: ['investigation', 'perception'], abilityOptions: ['dex', 'int', 'wis'], feat: 'Skilled', tools: ["Calligrapher's supplies"], gold: 23 },
  { id: 'wayfarer', skills: ['insight', 'stealth'], abilityOptions: ['dex', 'wis', 'cha'], feat: 'Lucky', tools: ["Thieves' tools"], gold: 16 },
];

const feats52 = [
  { id: 'crafter', name: 'Crafter' },
  { id: 'healer', name: 'Healer' },
  { id: 'lucky', name: 'Lucky' },
  { id: 'musician', name: 'Musician' },
  { id: 'tavern-brawler', name: 'Tavern Brawler' },
  { id: 'tough', name: 'Tough' },
];

describe('standard origins, SRD 5.2', () => {
  it('loads sixteen backgrounds and keeps the nine species and their lineages', () => {
    const r = rules('srd52');
    expect(r.backgrounds).toHaveLength(16);
    expect(r.backgrounds.map((b) => b.id).sort()).toEqual([...base52.backgrounds, ...backgrounds52].map((b) => b.id).sort());
    expect(r.species).toHaveLength(9);
    expect(r.species).toEqual(base52.species);
  });

  it.each(backgrounds52)('$id has the standard 2024 proficiencies, abilities, feat and equipment choices', ({ gold, ...expected }) => {
    const r = rules('srd52');
    const background = r.backgrounds.find((b) => b.id === expected.id)!;
    expect(background).toMatchObject({ ...expected, source: 'standard option, own words' });
    expect(background.skills.every((id) => r.skills.some((s) => s.id === id))).toBe(true);
    expect(background.equipment).toHaveLength(1);
    expect(background.equipment[0]).toContain('50 GP');
    expect(background.equipment[0]).toContain(`${gold} GP`);
  });

  it('loads exactly the six additional origin feats', () => {
    const added = rules('srd52').feats.filter((f) => !base52.feats.some((original) => original.id === f.id));
    expect(added.map(({ id, name }) => ({ id, name }))).toEqual(feats52);
    for (const feat of added) {
      expect(feat.source).toBe('standard option, own words');
      expect(feat.desc.split(/\.\s+|\.$/).filter(Boolean).length).toBeGreaterThanOrEqual(2);
      expect(feat.desc.split(/\.\s+|\.$/).filter(Boolean).length).toBeLessThanOrEqual(4);
    }
  });

  it('every background names an existing feat, with a spell-list suffix allowed for Magic Initiate', () => {
    const r = rules('srd52');
    expect(r.backgrounds.find((b) => b.id === 'acolyte')!.feat).toBe('Magic Initiate (Cleric)');
    expect(r.backgrounds.find((b) => b.id === 'guide')!.feat).toBe('Magic Initiate (Druid)');
    for (const background of r.backgrounds) {
      expect(background.feat, background.id).toBeTruthy();
      // Like Acolyte, Guide labels its spell list; the rules entry covers all three lists.
      // The builder displays these labels and does not apply feat mechanics automatically.
      const name = background.feat!.replace(/^Magic Initiate \((Cleric|Druid|Wizard)\)$/, 'Magic Initiate');
      expect(findIn(r.feats, name), `${background.id}: ${background.feat}`).toBeDefined();
    }
  });

  describe.each(['two-and-one', 'one-each'] as const)('level-1 builds with %s background bonuses', (bonuses) => {
    it.each(backgrounds52)('$id builds without errors and applies its abilities and skills', ({ id }) => {
      const r = rules('srd52');
      const background = r.backgrounds.find((b) => b.id === id)!;
      const [first, second, third] = background.abilityOptions!;
      const fighter = r.classes.find((c) => c.id === 'fighter')!;
      const build = fighter51({
        ruleset: 'srd52',
        species: 'dwarf',
        subspecies: undefined,
        background: id,
        bonusChoices: bonuses === 'two-and-one' ? { [first]: 2, [second]: 1 } : { [first]: 1, [second]: 1, [third]: 1 },
        skills: fighter.skillChoices.from.filter((s) => !background.skills.includes(s)).slice(0, fighter.skillChoices.choose),
        // Select the background's cash alternative, rather than sending its choice prompt as an item.
        equipment: ['50 GP'],
      });
      expect(lib.validateBuild(r, build)).toEqual([]);
      const character = lib.buildCharacter(r, build, { id, ownerId: 'u' });
      expect(character).toMatchObject({ ruleset: 'srd52', background: id, level: 1, gold: 50 });
      expect(lib.validateBuild(r, lib.buildOf(character))).toEqual([]);
      expect(character.skills).toEqual(expect.arrayContaining(background.skills));
      for (const ability of background.abilityOptions!) {
        expect(character.abilities[ability]).toBe(build.baseAbilities[ability] + (build.bonusChoices?.[ability] ?? 0));
      }
    });
  });

  it('has no id clashes after merging the origins', () => {
    const r = rules('srd52');
    for (const kind of ['backgrounds', 'feats', 'traits', 'species'] as const) {
      expect(new Set(r[kind].map((entry) => entry.id)).size, kind).toBe(r[kind].length);
    }
    for (const species of r.species) {
      expect(new Set(species.subspecies.map((sub) => sub.id)).size, species.id).toBe(species.subspecies.length);
    }
  });

  it('keeps all four origins keys, empty species additions, and plain ASCII', () => {
    const text = readFileSync(new URL('../data/srd52/origins.json', import.meta.url), 'utf8');
    const origins = JSON.parse(text) as Origins;
    expect(Object.keys(origins).sort()).toEqual(['backgrounds', 'feats', 'subspecies', 'traits']);
    expect(origins.backgrounds).toHaveLength(12);
    expect(origins.feats).toHaveLength(6);
    expect(origins.subspecies).toEqual({});
    expect(origins.traits).toEqual([]);
    expect(text).not.toMatch(/[^\x09\x0a\x0d\x20-\x7e]/);
  });
});

describe('origins loader rejects invalid data', () => {
  let rulesDir: string;
  let origins: Origins;

  beforeEach(() => {
    rulesDir = mkdtempSync(join(tmpdir(), 'dm-origins-rules-'));
    mkdirSync(join(rulesDir, 'srd51'));
    writeFileSync(join(rulesDir, 'srd51', 'rules.json'), baseJson);
    origins = { backgrounds: [], feats: [], traits: [], subspecies: {} };
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({ config: { rulesDir } }));
  });

  afterEach(() => {
    vi.doUnmock('../src/config.js');
    vi.resetModules();
    rmSync(rulesDir, { recursive: true, force: true });
  });

  async function expectRejected(message: string) {
    writeFileSync(join(rulesDir, 'srd51', 'origins.json'), JSON.stringify(origins));
    const loader = await import('../src/rules/index.js');
    expect(() => loader.rules('srd51')).toThrow(message);
  }

  it.each(['backgrounds', 'feats', 'traits'] as const)('rejects %s ids already in the base rules', async (kind) => {
    const [entry] = base51[kind];
    origins = { ...origins, [kind]: [entry] };
    const singular = { backgrounds: 'background', feats: 'feat', traits: 'trait' }[kind];
    await expectRejected(`Duplicate ${singular} id "${entry.id}" in srd51 origins`);
  });

  it.each(['backgrounds', 'feats', 'traits'] as const)('rejects duplicate %s ids within origins', async (kind) => {
    const entry = { ...base51[kind][0], id: 'duplicate-origin' };
    origins = { ...origins, [kind]: [entry, entry] };
    const singular = { backgrounds: 'background', feats: 'feat', traits: 'trait' }[kind];
    await expectRejected(`Duplicate ${singular} id "duplicate-origin" in srd51 origins`);
  });

  it('rejects a subspecies id already in the base species', async () => {
    origins.subspecies.dwarf = [base51.species.find((s) => s.id === 'dwarf')!.subspecies[0]];
    await expectRejected('Duplicate subspecies id "hill-dwarf" in srd51 origins');
  });

  it('rejects duplicate subspecies ids within origins', async () => {
    const entry = { id: 'new-dwarf', name: 'New Dwarf', abilityBonuses: {}, traits: [] };
    origins.subspecies.dwarf = [entry, entry];
    await expectRejected('Duplicate subspecies id "new-dwarf" in srd51 origins');
  });

  it('rejects an unknown parent species id', async () => {
    origins.subspecies['unknown-species'] = [];
    await expectRejected('Unknown species id "unknown-species" in srd51 origins');
  });
});
