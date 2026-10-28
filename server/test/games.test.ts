import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeHiveMind } from './fake-hivemind.js';
import { freshApp, register } from './helpers.js';

let app: FastifyInstance;
const hm = new FakeHiveMind();
let host: string, ana: string, bob: string, eve: string;
let gameId: string;

beforeAll(async () => {
  await hm.start();
  app = await freshApp({ HIVEMIND_URL: hm.url, HIVEMIND_TOKEN: hm.token });
  host = await register(app, 'host');
  ana = await register(app, 'ana');
  bob = await register(app, 'bob');
  eve = await register(app, 'eve');
  hm.canvases.set('dnd-setup', { id: 'dnd-setup', nodes: [] });
});
afterAll(async () => {
  await app?.close();
  await hm.stop();
});

const as = (cookie: string, method: string, url: string, payload?: unknown) => app.inject({ method: method as 'GET', url, headers: { cookie }, payload: payload as object });

export const fighter = (level = 1) => ({
  ruleset: 'srd51',
  name: `Fighter${level}`,
  species: 'human',
  class: 'fighter',
  background: 'acolyte',
  level,
  subclass: level >= 3 ? 'champion' : undefined,
  abilityMethod: 'standard',
  baseAbilities: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
  skills: ['athletics', 'perception'],
  equipment: ['Chain Mail', 'Longsword'],
});

describe('adventure setup', () => {
  it('creates a game with clamped settings', async () => {
    const r = await as(host, 'POST', '/api/games', { ruleset: 'srd51', name: 'The Hag of Hollowmere', startLevel: 3, endLevel: 1, maxPlayers: 50, rerolls: 2 });
    gameId = r.json().id;
    const g = (await as(host, 'GET', `/api/games/${gameId}`)).json();
    expect(g.settings).toMatchObject({ startLevel: 3, endLevel: 3, maxPlayers: 8, rerolls: 2 });
    expect(g.state).toMatchObject({ phase: 'lobby', rerollsLeft: 2 });
    expect(g.myRole).toBe('host');
    await as(host, 'PUT', `/api/games/${gameId}`, { startLevel: 1, endLevel: 14, maxPlayers: 3 });
    expect((await as(host, 'GET', `/api/games/${gameId}`)).json().settings).toMatchObject({ startLevel: 1, endLevel: 14 });
  });

  it('gets pitches, then a dynamic form for the chosen pitch', async () => {
    hm.onRun = (c) =>
      c.vars.stage === 'pitches'
        ? { outputs: { pitch: JSON.stringify({ pitches: [{ title: 'Drowned Bells', hook: 'A village where the bells ring underwater.' }, { title: 'Ash Crown', hook: 'A king who will not stay dead.' }] }) } }
        : {
            outputs: {
              pitch: JSON.stringify({
                title: 'Drowned Bells',
                summary: 'Horror on the marsh.',
                fields: [
                  { id: 'deadly', label: 'How deadly?', type: 'slider', min: 1, max: 5, default: 3 },
                  { id: 'villain', label: 'The villain', type: 'select', options: ['A hag', 'A drowned priest'], default: 'A hag' },
                  { id: 'bad' },
                ],
              }),
            },
          };
    const p = (await as(host, 'POST', `/api/games/${gameId}/pitches`, { wishes: 'swamp horror' })).json();
    expect(p.pitches.map((x: any) => x.title)).toEqual(['Drowned Bells', 'Ash Crown']);
    expect(hm.callsOf('dnd-setup')[0]).toMatchObject({ question: 'swamp horror', vars: { stage: 'pitches', startLevel: '1', endLevel: '14' } });
    const f = (await as(host, 'POST', `/api/games/${gameId}/form`, { pitch: p.pitches[0] })).json();
    expect(f.form.fields.map((x: any) => x.id)).toEqual(['deadly', 'villain']);
    expect(f.formValues).toEqual({ deadly: 3, villain: 'A hag' });
    await as(host, 'PUT', `/api/games/${gameId}`, { formValues: { deadly: 5, villain: 'A drowned priest' } });
    expect((await as(host, 'GET', `/api/games/${gameId}`)).json().settings.formValues.deadly).toBe(5);
  });

  it('only the host changes the setup', async () => {
    expect((await as(ana, 'PUT', `/api/games/${gameId}`, { maxPlayers: 1 })).statusCode).toBe(404);
  });

  it('invites players who then accept', async () => {
    expect((await as(host, 'POST', `/api/games/${gameId}/invites`, { username: 'nobody' })).statusCode).toBe(404);
    await as(host, 'POST', `/api/games/${gameId}/invites`, { username: 'ana' });
    await as(host, 'POST', `/api/games/${gameId}/invites`, { username: 'bob' });
    const lobby = (await as(ana, 'GET', '/api/games')).json();
    expect(lobby.invites.map((g: any) => g.id)).toEqual([gameId]);
    expect((await as(ana, 'GET', `/api/games/${gameId}`)).json().myRole).toBe('invited');
    await as(ana, 'POST', `/api/games/${gameId}/accept`);
    expect((await as(ana, 'GET', '/api/games')).json().mine.map((g: any) => g.id)).toEqual([gameId]);
    // Bob declines.
    const bobId = (await as(bob, 'GET', '/api/auth/me')).json().id;
    await as(bob, 'DELETE', `/api/games/${gameId}/members/${bobId}`);
    expect((await as(bob, 'GET', '/api/games')).json().invites).toEqual([]);
  });

  it('seats legal characters of the right ruleset and level only', async () => {
    const make = async (cookie: string, b: object) => (await as(cookie, 'POST', '/api/characters', b)).json().id;
    const ok = await make(ana, fighter(1));
    const tooHigh = await make(ana, { ...fighter(3), name: 'Old' });
    const other = await make(ana, { ...fighter(1), ruleset: 'srd52', name: 'New', background: 'soldier', bonusChoices: { str: 2, con: 1 }, skills: ['perception', 'survival'] });
    expect((await as(ana, 'POST', `/api/games/${gameId}/characters`, { characterId: tooHigh })).json().error).toMatch(/level 1/);
    expect((await as(ana, 'POST', `/api/games/${gameId}/characters`, { characterId: other })).json().error).toMatch(/srd51/);
    expect((await as(ana, 'POST', `/api/games/${gameId}/characters`, { characterId: ok })).statusCode).toBe(200);
    const second = await make(ana, { ...fighter(1), name: 'Second' });
    expect((await as(ana, 'POST', `/api/games/${gameId}/characters`, { characterId: second })).json().error).toMatch(/One character per player/);
    // Someone else's character can't be seated.
    expect((await as(host, 'POST', `/api/games/${gameId}/characters`, { characterId: ok })).statusCode).toBe(404);
    const g = (await as(ana, 'GET', `/api/games/${gameId}`)).json();
    expect(g.characters).toHaveLength(1);
    expect(g.characters[0]).toMatchObject({ name: 'Fighter1', seated: true, absent: false });
    expect(g.characters[0].id).not.toBe(ok);
  });

  it('lists running public games to spectate, never private ones', async () => {
    const { db } = await import('../src/db.js');
    db.prepare("UPDATE games SET status = 'playing' WHERE id = ?").run(gameId);
    expect((await as(eve, 'GET', '/api/games')).json().spectate.map((g: any) => g.id)).toEqual([gameId]);
    expect((await as(eve, 'GET', `/api/games/${gameId}`)).json().myRole).toBe('spectator');
    await as(host, 'PUT', `/api/games/${gameId}`, { visibility: 'private' });
    expect((await as(eve, 'GET', '/api/games')).json().spectate).toEqual([]);
    expect((await as(eve, 'GET', `/api/games/${gameId}`)).statusCode).toBe(404);
  });
});
