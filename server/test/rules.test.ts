import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshApp, register } from './helpers.js';

let app: FastifyInstance;
let cookie: string;
beforeAll(async () => {
  app = await freshApp();
  cookie = await register(app, 'reader');
});
afterAll(() => app?.close());

const get = (url: string) => app.inject({ url, headers: { cookie } });

describe('SRD rules data', () => {
  it.each(['srd51', 'srd52'])('%s has the full builder data', async (r) => {
    const b = (await get(`/api/rules/${r}/builder`)).json();
    expect(b.classes).toHaveLength(12);
    expect(b.species.length).toBeGreaterThanOrEqual(9);
    expect(b.skills).toHaveLength(18);
    const wizard = b.classes.find((c: any) => c.id === 'wizard');
    expect(wizard).toMatchObject({ hitDie: 6, spellAbility: 'int', saves: ['int', 'wis'] });
    expect(wizard.levels).toHaveLength(20);
    expect(wizard.levels[0].spellcasting.slots[0]).toBe(2);
  });

  it('2014 has racial bonuses, 2024 has background ability options', async () => {
    const a = (await get('/api/rules/srd51/builder')).json();
    expect(a.species.find((s: any) => s.id === 'dwarf').abilityBonuses).toEqual({ con: 2 });
    const b = (await get('/api/rules/srd52/builder')).json();
    expect(b.backgrounds.map((x: any) => x.id)).toEqual(['acolyte', 'criminal', 'sage', 'soldier']);
    expect(b.backgrounds[0].abilityOptions).toEqual(['int', 'wis', 'cha']);
  });

  it('filters spells by class and level', async () => {
    const list = (await get('/api/rules/srd51/spells?class=wizard&maxLevel=1')).json();
    expect(list.length).toBeGreaterThan(20);
    expect(list.every((s: any) => s.level <= 1 && s.classes.includes('wizard'))).toBe(true);
    expect(list.some((s: any) => s.id === 'magic-missile')).toBe(true);
  });

  it('searches rules, with the 2024 gaps filled', async () => {
    const a = (await get('/api/rules/srd51/search?q=grapple')).json();
    expect(a[0].text.toLowerCase()).toContain('grapple');
    const b = (await get('/api/rules/srd52/search?q=concentration')).json();
    expect(b.some((h: any) => h.kind === 'Rule' && h.name === 'Concentration')).toBe(true);
    const f = (await get('/api/rules/srd52/search?q=fireball')).json();
    expect(f[0].name).toBe('Fireball');
  });

  it('404s an unknown ruleset', async () => {
    expect((await get('/api/rules/pf2e/builder')).statusCode).toBe(404);
  });
});
