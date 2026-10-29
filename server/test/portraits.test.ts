import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeHiveMind, PNG } from './fake-hivemind.js';
import { CANVASES, freshApp, settle, setupGame } from './helpers.js';

let app: FastifyInstance;
const hm = new FakeHiveMind();
let t: Awaited<ReturnType<typeof setupGame>>;
let libId: string;

beforeAll(async () => {
  await hm.start();
  app = await freshApp({ HIVEMIND_URL: hm.url, HIVEMIND_TOKEN: hm.token });
  for (const id of CANVASES) hm.canvases.set(id, { id, nodes: [] });
  hm.onRun = (c) => {
    if (c.canvasId === 'dnd-portrait' || c.canvasId === 'dnd-scene') {
      const n = c.canvasId === 'dnd-portrait' ? 4 : 1;
      const files = Array.from({ length: n }, (_, i) => `images/${c.canvasId}-${hm.calls.length}-${i}.png`);
      for (const f of files) hm.files.set(f, PNG);
      return { outputs: { [c.canvasId === 'dnd-portrait' ? 'portraits' : 'scene']: files.map((f) => `![image](hm-file:${f})`).join('\n') } };
    }
    if (c.canvasId === 'dnd-narrate') return { outputs: { narration: 'A storm.', state: JSON.stringify({ image: 'A storm over the marsh', choices: {} }) } };
    if (c.canvasId === 'dnd-chronicle') return { outputs: { patches: '{"patches":[]}' } };
    return { outputs: {} };
  };
  t = await setupGame(app);
  libId = (await t.as(t.host, 'GET', '/api/characters')).json()[0].id;
});
afterAll(async () => {
  await app?.close();
  await hm.stop();
});

describe('portraits', () => {
  let options: string[];

  it('makes 4 options in one HiveMind run and copies them into DungeonMind', async () => {
    const r = await settle(app, t.host, await t.as(t.host, 'POST', `/api/characters/${libId}/portraits`, { style: 'charcoal sketch' }));
    expect(r.statusCode).toBe(200);
    options = r.json().options;
    expect(options).toHaveLength(4);
    expect(hm.callsOf('dnd-portrait')[0]).toMatchObject({ vars: { style: 'charcoal sketch' } });
    expect(hm.callsOf('dnd-portrait')[0].question).toContain('Turks');
    const img = await t.as(t.host, 'GET', options[0]);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
  });

  it('picks one; the game copy of the character gets it too', async () => {
    expect((await t.as(t.host, 'POST', `/api/characters/${libId}/portrait`, { url: '/etc/passwd' })).statusCode).toBe(400);
    const c = (await t.as(t.host, 'POST', `/api/characters/${libId}/portrait`, { url: options[2] })).json();
    expect(c.portrait).toBe(options[2]);
    const g = (await t.as(t.host, 'GET', `/api/games/${t.id}`)).json();
    expect(g.characters.find((x: any) => x.name === 'Turks').portrait).toBe(options[2]);
  });

  it('uploads your own image, checking what it really is', async () => {
    const bad = await app.inject({ method: 'POST', url: `/api/characters/${libId}/portrait/upload`, headers: { cookie: t.host, 'content-type': 'image/png' }, payload: Buffer.from('<svg onload=alert(1)>') });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: `/api/characters/${libId}/portrait/upload`, headers: { cookie: t.host, 'content-type': 'image/png' }, payload: PNG });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().portrait).toMatch(/^\/api\/images\/portrait-.+\.png$/);
    const other = await app.inject({ method: 'POST', url: `/api/characters/${libId}/portrait/upload`, headers: { cookie: t.pl, 'content-type': 'image/png' }, payload: PNG });
    expect(other.statusCode).toBe(404);
  });

  it('reports a missing image model clearly', async () => {
    const before = hm.onRun;
    hm.onRun = () => ({ outputs: { portraits: 'No image model selected' } });
    const r = await settle(app, t.host, await t.as(t.host, 'POST', `/api/characters/${libId}/portraits`, {}));
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/no images/);
    hm.onRun = before;
  });
});

describe('scene images', () => {
  it('illustrates a new scene in the background', async () => {
    await t.as(t.host, 'POST', `/api/games/${t.id}/start`);
    const turn = await import('../src/game/turn.js');
    await turn.settled(t.id);
    let g: any;
    for (let i = 0; i < 40; i++) {
      g = (await t.as(t.pl, 'GET', `/api/games/${t.id}`)).json();
      if (g.state.sceneImage) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(g.state.sceneImage).toMatch(/^\/api\/images\/scene-/);
    expect(hm.callsOf('dnd-scene')[0].question).toBe('A storm over the marsh');
    const log = (await t.as(t.pl, 'GET', `/api/games/${t.id}/log`)).json();
    expect(log.some((e: any) => e.kind === 'image' && e.data.url === g.state.sceneImage)).toBe(true);
  });
});
