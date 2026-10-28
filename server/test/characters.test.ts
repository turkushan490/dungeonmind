import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeHiveMind } from './fake-hivemind.js';
import { freshApp, register } from './helpers.js';

let app: FastifyInstance;
let cookie: string;
const hm = new FakeHiveMind();

beforeAll(async () => {
  await hm.start();
  app = await freshApp({ HIVEMIND_URL: hm.url, HIVEMIND_TOKEN: hm.token });
  cookie = await register(app, 'player');
  for (const id of ['dnd-sheet']) hm.canvases.set(id, { id, nodes: [] });
});
afterAll(async () => {
  await app?.close();
  await hm.stop();
});

const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as 'GET', url, headers: { cookie }, payload: payload as object });

const build = {
  ruleset: 'srd51',
  name: 'Mitchel',
  species: 'halfling',
  subspecies: 'lightfoot-halfling',
  class: 'rogue',
  background: 'acolyte',
  level: 1,
  abilityMethod: 'standard',
  baseAbilities: { str: 8, dex: 15, con: 14, int: 12, wis: 10, cha: 13 },
  skills: ['stealth', 'perception', 'deception', 'sleight-of-hand'],
  equipment: ['Leather Armor', 'Shortsword', '2× Dagger', "Thieves' Tools"],
};

describe('character library', () => {
  let id: string;

  it('creates a legal character and refuses an illegal one', async () => {
    const bad = await call('POST', '/api/characters', { ...build, skills: ['stealth'] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors.join()).toMatch(/more skills/);
    const ok = await call('POST', '/api/characters', build);
    expect(ok.statusCode).toBe(200);
    id = ok.json().id;
    expect(ok.json()).toMatchObject({ maxHp: 10, abilities: { dex: 17, cha: 14 } });
    expect(ok.json().inventory).toContainEqual({ name: 'Dagger', qty: 2, equipped: true });
  });

  it('lists only your own characters', async () => {
    expect((await call('GET', '/api/characters')).json().map((c: any) => c.name)).toEqual(['Mitchel']);
    const other = await register(app, 'other');
    expect((await app.inject({ url: `/api/characters/${id}`, headers: { cookie: other } })).statusCode).toBe(404);
  });

  it('derives AC and bonuses on read', async () => {
    const r = (await call('GET', `/api/characters/${id}`)).json();
    expect(r.derived.ac).toBe(14); // leather 11 + DEX 3
    expect(r.derived.skillBonus.stealth).toBe(5);
  });

  it('uses only server-rolled scores for the rolled method', async () => {
    const { rollId, values } = (await call('POST', '/api/characters/roll-abilities')).json();
    expect(values).toHaveLength(6);
    const [a, b, c, d, e, f] = values;
    const mine = { ...build, abilityMethod: 'rolled', rollId, baseAbilities: { str: a, dex: b, con: c, int: d, wis: e, cha: f } };
    const v = (await call('POST', '/api/characters/validate', mine)).json();
    expect(v.errors.filter((x: string) => /rolled/.test(x))).toEqual([]);
    const cheat = { ...mine, baseAbilities: { ...mine.baseAbilities, str: 18 === a ? 17 : 18 } };
    expect((await call('POST', '/api/characters/validate', cheat)).json().errors.join()).toMatch(/server rolled/);
  });

  it('edits story fields and inventory without touching the rules', async () => {
    const r = await call('PATCH', `/api/characters/${id}`, { backstory: 'Grew up in the sewers.', inventory: [{ name: 'Rope', qty: 1 }], maxHp: 999 });
    expect(r.json()).toMatchObject({ backstory: 'Grew up in the sewers.', maxHp: 10 });
  });

  it('exports and re-imports our own format', async () => {
    const ex = (await call('GET', `/api/characters/${id}/export`)).json();
    expect(ex.format).toBe('dungeonmind-character');
    const im = (await call('POST', '/api/characters/import', { ruleset: 'srd51', text: JSON.stringify(ex) })).json();
    expect(im.errors).toEqual([]);
    expect(im.build.name).toBe('Mitchel');
  });

  it('imports a foreign JSON sheet by its field names', async () => {
    const foreign = { name: 'Vex', race: 'Elf', subrace: 'High Elf', class: 'Wizard', level: 1, stats: { STR: 8, DEX: 14, CON: 13, INT: 15, WIS: 12, CHA: 10 }, skills: ['Arcana', 'History'], spells: ['Magic Missile', 'Shield'], cantrips: ['Fire Bolt', 'Light', 'Mage Hand'] };
    const im = (await call('POST', '/api/characters/import', { ruleset: 'srd51', text: JSON.stringify(foreign) })).json();
    expect(im.build).toMatchObject({ species: 'elf', subspecies: 'high-elf', class: 'wizard', abilityMethod: 'standard', spells: ['magic-missile', 'shield'] });
    expect(im.errors).toEqual([]);
  });

  it('lets the AI build a sheet and fix what it got wrong', async () => {
    let n = 0;
    hm.onRun = (c) => {
      n++;
      const sheet = {
        name: 'Brakka',
        species: 'Half-Orc',
        class: 'Barbarian',
        background: 'Acolyte',
        level: 1,
        abilities: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 },
        // First answer picks a skill barbarians can't take; the repair round fixes it.
        skills: c.question.includes('broke these rules') ? ['athletics', 'survival'] : ['athletics', 'arcana'],
        equipment: ['Greataxe', '2 Handaxe'],
        appearance: 'Scarred, grey-skinned',
      };
      return { outputs: { sheet: JSON.stringify(sheet) } };
    };
    const r = await call('POST', '/api/characters/ai', { ruleset: 'srd51', level: 1, description: 'An angry orc who hates wizards' });
    expect(r.statusCode).toBe(200);
    expect(r.json().errors).toEqual([]);
    expect(r.json().build).toMatchObject({ species: 'half-orc', class: 'barbarian', skills: ['athletics', 'survival'] });
    expect(n).toBe(2);
    expect(hm.callsOf('dnd-sheet')[0].vars).toMatchObject({ ruleset: 'srd51', level: '1' });
  });

  it('reports a HiveMind outage as 502, not a crash', async () => {
    hm.onRun = () => ({ error: 'model not loaded' });
    const r = await call('POST', '/api/characters/ai', { ruleset: 'srd51', level: 1, description: 'x' });
    expect(r.statusCode).toBe(502);
  }, 30_000);
});
