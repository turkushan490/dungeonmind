import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeHiveMind } from './fake-hivemind.js';
import { CANVASES, freshApp, register, registerAdmin, setupGame } from './helpers.js';

let app: FastifyInstance;
const hm = new FakeHiveMind();
let token: string;
let cookie: string;

beforeAll(async () => {
  await hm.start();
  app = await freshApp({ HIVEMIND_URL: hm.url, HIVEMIND_TOKEN: hm.token });
  for (const id of CANVASES) hm.canvases.set(id, { id, nodes: [] });
  cookie = await registerAdmin(app, 'labadmin');
  token = (await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: { name: 'HiveMind Lab' } })).json().token;
});
afterAll(async () => {
  await app?.close();
  await hm.stop();
});

const lab = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object });

const cleric = { name: 'Esva', hp: 10, maxHp: 10, class: 'cleric', level: 2, abilities: { str: 13, dex: 10, con: 14, int: 8, wis: 16, cha: 12 }, counters: [{ name: 'Channel Divinity', current: 0, max: 1, recharge: 'short' }, { name: 'Spell slot L1', current: 3, max: 3 }], inventory: [{ name: 'Mace', qty: 1, equipped: true }], gold: 5 };

describe('API tokens', () => {
  it('a dm_ token authenticates programs; it is shown once', async () => {
    expect(token).toMatch(/^dm_/);
    const list = (await app.inject({ url: '/api/tokens', headers: { cookie } })).json();
    expect(list[0]).toMatchObject({ name: 'HiveMind Lab', prefix: token.slice(0, 7) });
    expect(list[0].token).toBeUndefined();
    expect((await app.inject({ method: 'POST', url: '/api/lab/bookkeeper/check', headers: { authorization: 'Bearer dm_wrong' }, payload: {} })).statusCode).toBe(401);
  });
});

describe('Bookkeeper API for the Lab judge', () => {
  it('flags a resource the character does not have left', async () => {
    const r = (await lab('/api/lab/bookkeeper/check', { ruleset: 'srd51', party: [cleric], adjudication: { rolls: [], resources: [{ pc: 'Esva', name: 'Channel Divinity', amount: 1 }] } })).json();
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ type: 'refused-resource', pc: 'Esva' });
    expect(r.party[0].counters[0].current).toBe(0);
  });

  it('spends resources, rolls the dice, applies the turn and flags invented numbers', async () => {
    const r = (
      await lab('/api/lab/bookkeeper/check', {
        ruleset: 'srd51',
        party: [cleric],
        npcs: [{ name: 'Goblin', hp: 7, maxHp: 7, ac: 15, status: 'hostile' }],
        adjudication: {
          rolls: [
            { id: 'a', actor: 'Esva', kind: 'attack', target: 'Goblin', spell: 'Guiding Bolt', bonus: 9 },
            { id: 'b', actor: 'Esva', kind: 'damage', target: 'Goblin', dice: '4d6', onHit: 'a', spell: 'Guiding Bolt' },
          ],
          resources: [{ pc: 'Esva', name: '1st level spell slot', amount: 1 }],
        },
        state: { deltas: [{ pc: 'Esva', hp: -4, gold: 100, removeItems: ['Holy Water'] }, { pc: 'Gandalf', hp: 5 }], xp: [{ pc: 'Esva', amount: 50 }], choices: { Esva: ['a', 'b', 'c', 'd'], Bob: ['x'] } },
      })
    ).json();
    expect(r.party[0].counters.find((k: any) => k.name === 'Spell slot L1').current).toBe(2);
    expect(r.rolls[0]).toMatchObject({ actor: 'Esva', kind: 'attack', bonus: 5 }); // WIS +3, proficiency +2
    expect(r.errorTypes).toEqual(expect.arrayContaining(['invented-bonus', 'unbacked-hp', 'missing-item', 'unknown-character']));
    expect(r.party[0].hp).toBe(10); // the -4 had no dice behind it
    expect(r.party[0].gold).toBe(105);
    expect(r.party[0].xp).toBe(50);
    const goblin = r.npcs.find((n: any) => n.name === 'Goblin');
    expect(goblin.hp).toBe(r.rolls[1].result.skipped ? 7 : Math.max(0, 7 - r.rolls[1].result.total));
    expect(r.derived.Esva.spellDc).toBe(13);
  });

  it('rests and makes legal sheets for fake players', async () => {
    const rested = (await lab('/api/lab/bookkeeper/rest', { ruleset: 'srd51', party: [cleric], kind: 'short' })).json();
    expect(rested.party[0].counters[0].current).toBe(1);
    const c = (
      await lab('/api/lab/bookkeeper/character', {
        ruleset: 'srd52', name: 'Reckless', species: 'orc', class: 'barbarian', background: 'soldier', level: 3, subclass: 'berserker', abilityMethod: 'standard',
        baseAbilities: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 }, bonusChoices: { str: 2, con: 1 }, skills: ['animal-handling', 'perception'],
      })
    ).json();
    expect(c.character.counters.find((k: any) => k.name === 'Rage')).toMatchObject({ max: 3 });
    expect((await lab('/api/lab/bookkeeper/character', { ruleset: 'srd52', name: 'X', species: 'orc', class: 'barbarian', background: 'soldier', level: 1, abilityMethod: 'standard', baseAbilities: { str: 18, dex: 13, con: 14, int: 8, wis: 12, cha: 10 }, skills: [] })).statusCode).toBe(400);
  });
});

describe('export of real games', () => {
  it('records the DM calls of every game and exports them as chat JSONL with the Bookkeeper notes', async () => {
    const t = await setupGame(app);
    hm.onRun = (c) =>
      c.canvasId === 'dnd-narrate'
        ? { outputs: { narration: 'Fog.', state: JSON.stringify({ deltas: [{ pc: 'Turks', hp: -3 }], choices: {} }) } }
        : c.canvasId === 'dnd-chronicle'
          ? { outputs: { patches: '{"patches":[]}' } }
          : { outputs: {} };
    const hostCookie = t.host;
    await t.as(hostCookie, 'POST', `/api/games/${t.id}/start`);
    const turn = await import('../src/game/turn.js');
    await turn.settled(t.id);
    const res = await t.as(hostCookie, 'GET', `/api/lab/games/${t.id}/turns.jsonl`);
    expect(res.statusCode).toBe(200);
    const lines = res.body.split('\n').map((l: string) => JSON.parse(l));
    const narrate = lines.find((l: any) => l.meta.canvas === 'dnd-narrate');
    expect(narrate.messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(narrate.messages[2].content).toContain('Fog.');
    expect(narrate.meta.bookkeeper.join()).toMatch(/held back Turks HP -3/);
    expect(narrate.meta.ok).toBe(false);
    expect((await t.as(t.pl, 'GET', `/api/lab/games/${t.id}/turns.jsonl`)).statusCode).toBe(404); // host only
  });
});

describe('the fine-tuned DM model as the default', () => {
  it('pulls it through HiveMind and sets it for the story and JSON blocks', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/hivemind/dm-model', headers: { cookie }, payload: { providerId: 'ollama', model: 'hf.co/turkushan490/dungeonmind-dm-8b-gguf:Q4_K_M', pull: false } });
    expect(r.statusCode).toBe(200);
    expect(r.json().models.story.model).toBe('hf.co/turkushan490/dungeonmind-dm-8b-gguf:Q4_K_M');
    expect(hm.canvases.get('dnd-narrate')).toBeDefined();
  });
});
