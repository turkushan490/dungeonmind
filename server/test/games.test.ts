import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeHiveMind } from './fake-hivemind.js';
import { freshApp, register, settle } from './helpers.js';

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
    const p = (await settle(app, host, await as(host, 'POST', `/api/games/${gameId}/pitches`, { wishes: 'swamp horror' }))).json();
    expect(p.pitches.map((x: any) => x.title)).toEqual(['Drowned Bells', 'Ash Crown']);
    expect(hm.callsOf('dnd-setup')[0]).toMatchObject({ question: 'swamp horror', vars: { stage: 'pitches', startLevel: '1', endLevel: '14' } });
    const f = (await settle(app, host, await as(host, 'POST', `/api/games/${gameId}/form`, { pitch: p.pitches[0] }))).json();
    expect(f.form.fields.map((x: any) => x.id)).toEqual(['deadly', 'villain']);
    expect(f.formValues).toEqual({ deadly: 3, villain: 'A hag' });
    await as(host, 'PUT', `/api/games/${gameId}`, { formValues: { deadly: 5, villain: 'A drowned priest' } });
    expect((await as(host, 'GET', `/api/games/${gameId}`)).json().settings.formValues.deadly).toBe(5);
  });

  it('runs slow AI work as a background job, so no proxy timeout can hit it', async () => {
    const before = hm.onRun;
    hm.onRun = () => ({ delayMs: 300, outputs: { pitch: JSON.stringify({ pitches: [{ title: 'Slow Fog', hook: 'It takes its time.' }] }) } });
    const start = await as(host, 'POST', `/api/games/${gameId}/pitches`, { wishes: 'fog' });
    expect(start.statusCode).toBe(202);
    const { jobId } = start.json();
    expect((await as(host, 'GET', `/api/jobs/${jobId}`)).json().status).toBe('running');
    expect((await as(ana, 'GET', `/api/jobs/${jobId}`)).statusCode).toBe(404);
    const done = await settle(app, host, start);
    expect(done.json().pitches[0].title).toBe('Slow Fog');

    hm.onRun = () => ({ error: "Ollama /api/chat failed: HTTP 404 {\"error\":\"model 'x' not found\"}" });
    const failed = await settle(app, host, await as(host, 'POST', `/api/games/${gameId}/pitches`, { wishes: 'fog' }));
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toMatch(/DM model isn't available/);
    hm.onRun = before;
  }, 60_000);

  describe('cancel', () => {
    const settingsOf = async () => (await as(host, 'GET', `/api/games/${gameId}`)).json().settings;
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
    };
    const late = (title: string) => () => ({ delayMs: 300, outputs: { pitch: JSON.stringify({ pitches: [{ title, hook: 'Too late.' }], title, fields: [{ id: 'x', label: 'X', type: 'text' }] }) } });

    it('stops the pitches: the run is cancelled on HiveMind, not retried, and its late result is not saved', async () => {
      const before = await settingsOf();
      const calls = hm.callsOf('dnd-setup').length;
      const stops = hm.cancelled.length;
      hm.onRun = late('Never Seen');
      const start = await as(host, 'POST', `/api/games/${gameId}/pitches`, { wishes: 'something else' });
      const { jobId } = start.json();
      await until(() => hm.callsOf('dnd-setup').length > calls);
      expect((await as(ana, 'DELETE', `/api/jobs/${jobId}`)).json()).toEqual({ cancelled: false });
      expect((await as(host, 'DELETE', `/api/jobs/${jobId}`)).json()).toEqual({ cancelled: true });
      expect((await as(host, 'GET', `/api/jobs/${jobId}`)).json().status).toBe('cancelled');
      await until(() => hm.cancelled.length > stops);
      expect(hm.cancelled.length).toBe(stops + 1);
      // Well past the moment HiveMind answers.
      await new Promise((r) => setTimeout(r, 600));
      expect(hm.callsOf('dnd-setup').length).toBe(calls + 1);
      expect((await as(host, 'GET', `/api/jobs/${jobId}`)).json().status).toBe('cancelled');
      const after = await settingsOf();
      expect(after.pitches).toEqual(before.pitches);
      expect(after.wishes).toEqual(before.wishes);
      expect(after.pitch).toEqual(before.pitch);
    });

    it('stops the setup questions: settings.pitch and the form stay as they were', async () => {
      const before = await settingsOf();
      expect(before.pitch.title).toBe('Drowned Bells');
      const calls = hm.callsOf('dnd-setup').length;
      hm.onRun = late('Ash Crown');
      const start = await as(host, 'POST', `/api/games/${gameId}/form`, { pitch: { title: 'Ash Crown', hook: 'A king who will not stay dead.' } });
      await until(() => hm.callsOf('dnd-setup').length > calls);
      expect((await as(host, 'DELETE', `/api/jobs/${start.json().jobId}`)).json()).toEqual({ cancelled: true });
      await new Promise((r) => setTimeout(r, 600));
      const after = await settingsOf();
      expect(after.pitch).toEqual(before.pitch);
      expect(after.form).toEqual(before.form);
      expect(after.formValues).toEqual(before.formValues);
      expect((await as(host, 'GET', `/api/games/${gameId}`)).json().name).toBe('The Hag of Hollowmere');
    });

    it('does not retry a failed attempt once it is cancelled', async () => {
      const calls = hm.callsOf('dnd-setup').length;
      hm.onRun = () => ({ error: 'Invalid JSON after repair' });
      const start = await as(host, 'POST', `/api/games/${gameId}/pitches`, { wishes: 'fog' });
      await until(() => hm.callsOf('dnd-setup').length > calls);
      // The first attempt failed; withRetry is in its pause before attempt 2.
      await new Promise((r) => setTimeout(r, 200));
      await as(host, 'DELETE', `/api/jobs/${start.json().jobId}`);
      await new Promise((r) => setTimeout(r, 1800));
      expect(hm.callsOf('dnd-setup').length).toBe(calls + 1);
      expect((await as(host, 'GET', `/api/jobs/${start.json().jobId}`)).json().status).toBe('cancelled');
    }, 10_000);

    it('a cancel that arrives before its request means the request starts nothing', async () => {
      const calls = hm.callsOf('dnd-setup').length;
      const id = 'c0ffee00c0ffee00c0ffee00';
      expect((await as(host, 'DELETE', `/api/jobs/${id}`)).json()).toEqual({ cancelled: true });
      const start = await app.inject({ method: 'POST', url: `/api/games/${gameId}/pitches`, headers: { cookie: host, 'x-job-id': id }, payload: { wishes: 'fog' } });
      expect(start.json()).toEqual({ jobId: id });
      expect((await as(host, 'GET', `/api/jobs/${id}`)).json().status).toBe('cancelled');
      await new Promise((r) => setTimeout(r, 50));
      expect(hm.callsOf('dnd-setup').length).toBe(calls);
      // Another player can't reuse or see that id.
      expect((await as(ana, 'GET', `/api/jobs/${id}`)).statusCode).toBe(404);
    });
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
