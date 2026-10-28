import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshApp, register, registerAdmin } from './helpers.js';

let app: FastifyInstance;
let a: string, b: string;
beforeAll(async () => {
  app = await freshApp();
  a = await registerAdmin(app, 'admin1');
  b = await register(app, 'maker');
});
afterAll(() => app?.close());

const as = (cookie: string, method: string, url: string, payload?: unknown) => app.inject({ method: method as 'GET', url, headers: { cookie }, payload: payload as object });

describe('homebrew', () => {
  let spellId: string;

  it('adds a spell that the builder and the rules search then know', async () => {
    const r = await as(b, 'POST', '/api/homebrew', { ruleset: 'srd51', kind: 'spell', data: { name: 'Grave Bell', level: 1, classes: 'Cleric, Wizard', school: 'Necromancy', desc: 'A bell tolls; one creature makes a Wisdom save or is frightened.', damage: '2d6 necrotic' } });
    expect(r.statusCode).toBe(200);
    spellId = r.json().id;
    const spells = (await as(b, 'GET', '/api/rules/srd51/spells?class=cleric&maxLevel=1')).json();
    expect(spells.find((s: any) => s.id === 'hb-grave-bell')).toMatchObject({ level: 1, homebrew: true });
    expect((await as(b, 'GET', '/api/rules/srd51/search?q=grave bell')).json()[0].name).toBe('Grave Bell');
    // Other ruleset untouched.
    expect((await as(b, 'GET', '/api/rules/srd52/spells?class=cleric')).json().some((s: any) => s.id === 'hb-grave-bell')).toBe(false);
  });

  it('a homebrew spell is legal in the builder', async () => {
    const r = await as(b, 'POST', '/api/characters/validate', {
      ruleset: 'srd51', name: 'Hb', species: 'human', class: 'cleric', subclass: 'life', background: 'acolyte', level: 1, abilityMethod: 'standard',
      baseAbilities: { str: 13, dex: 10, con: 14, int: 8, wis: 15, cha: 12 }, skills: ['medicine', 'persuasion'], cantrips: ['guidance'], spells: ['hb-grave-bell'],
    });
    expect(r.json().errors).toEqual([]);
  });

  it('validates input and refuses duplicates', async () => {
    expect((await as(b, 'POST', '/api/homebrew', { ruleset: 'srd51', kind: 'spell', data: {} })).json().error).toMatch(/name/);
    expect((await as(b, 'POST', '/api/homebrew', { ruleset: 'srd51', kind: 'feat', data: { name: 'Lucky Hat' } })).json().error).toMatch(/Describe/);
    expect((await as(b, 'POST', '/api/homebrew', { ruleset: 'srd51', kind: 'weapon-of-doom', data: { name: 'x' } })).statusCode).toBe(400);
    expect((await as(b, 'POST', '/api/homebrew', { ruleset: 'srd51', kind: 'spell', data: { name: 'grave bell', desc: 'again' } })).statusCode).toBe(409);
  });

  it('monsters and items get clamped numbers', async () => {
    const m = (await as(b, 'POST', '/api/homebrew', { ruleset: 'srd51', kind: 'monster', data: { name: 'Bell-Hag', ac: 99, hp: 45, abilities: { str: 14, dex: 12, con: 16, int: 13, wis: 14, cha: 16 }, cr: 3, xp: 700, actions: 'Claws: +5 to hit, 2d6+3' } })).json();
    expect(m.data).toMatchObject({ id: 'hb-bell-hag', ac: 30, hp: 45, actions: ['Claws: +5 to hit', '2d6+3'] });
    const i = (await as(b, 'POST', '/api/homebrew', { ruleset: 'srd51', kind: 'item', data: { name: 'Bone Mail', armorBase: 15, dexBonus: true, maxBonus: 2 } })).json();
    expect(i.data.armor).toEqual({ base: 15, dexBonus: true, maxBonus: 2 });
  });

  it('only the maker or an admin edits, disables or deletes', async () => {
    expect((await as(a, 'PUT', `/api/homebrew/${spellId}`, { enabled: false })).statusCode).toBe(200); // admin1 is the first user = admin
    expect((await as(b, 'GET', '/api/rules/srd51/spells?class=cleric')).json().some((s: any) => s.id === 'hb-grave-bell')).toBe(false);
    const c = await register(app, 'stranger');
    expect((await as(c, 'DELETE', `/api/homebrew/${spellId}`)).statusCode).toBe(403);
    expect((await as(b, 'DELETE', `/api/homebrew/${spellId}`)).statusCode).toBe(200);
    expect((await as(b, 'GET', '/api/homebrew?ruleset=srd51')).json().map((h: any) => h.name)).toEqual(['Bone Mail', 'Bell-Hag']);
  });
});
