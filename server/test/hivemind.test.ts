import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeHiveMind } from './fake-hivemind.js';
import { freshApp, register } from './helpers.js';

let app: FastifyInstance;
let admin: string;
const hm = new FakeHiveMind();

beforeAll(async () => {
  await hm.start();
  app = await freshApp({ HIVEMIND_URL: hm.url, HIVEMIND_TOKEN: hm.token });
  admin = await register(app, 'admin');
});
afterAll(async () => {
  await app?.close();
  await hm.stop();
});

const as = (method: string, url: string, payload?: unknown) => app.inject({ method: method as 'GET', url, headers: { cookie: admin }, payload: payload as object });

describe('HiveMind connection', () => {
  it('passes the compatibility check when every feature is there', async () => {
    const h = (await as('GET', '/api/hivemind/health')).json();
    expect(h).toMatchObject({ ok: true, missing: [], missingOptional: [] });
  });

  it('lists what is missing on an old HiveMind', async () => {
    const before = hm.features;
    hm.features = ['vars'];
    const h = (await as('GET', '/api/hivemind/health')).json();
    expect(h.missing).toContain('jsonMode');
    expect(h.missing).not.toContain('vars');
    hm.features = before;
  });

  it('installs every canvas, filling models by role and keeping models picked in HiveMind', async () => {
    await as('PUT', '/api/settings/hivemind', { models: { story: { providerId: 'ollama', model: 'story-24b' }, json: { providerId: 'ollama', model: 'json-20b' } } });
    const r = (await as('POST', '/api/hivemind/install')).json();
    expect(r.canvases.every((c: any) => c.ok)).toBe(true);
    expect(hm.canvases.size).toBe(readdirSync('../hivemind').filter((f) => f.endsWith('.canvas.json')).length);
    const narrate = hm.canvases.get('dnd-narrate');
    expect(narrate.nodes.find((n: any) => n.label === 'narration').config.model.model).toBe('story-24b');
    expect(narrate.nodes.find((n: any) => n.label === 'state').config.model.model).toBe('json-20b');
    // The image node has no image model yet: reported, not failed.
    expect(r.canvases.find((c: any) => c.id === 'dnd-portrait').needsModel).toEqual(['portraits']);

    // The user picks another narration model in HiveMind; a reinstall keeps it.
    narrate.nodes.find((n: any) => n.label === 'narration').config.model = { providerId: 'groq', model: 'mine' };
    await as('POST', '/api/hivemind/install');
    expect(hm.canvases.get('dnd-narrate').nodes.find((n: any) => n.label === 'narration').config.model.model).toBe('mine');
  });

  it('imports the SRD into memory under rules:<ruleset>, in chunks', async () => {
    const r = await as('POST', '/api/hivemind/import-rules?wait=1', { rulesets: ['srd51', 'srd52'] });
    expect(r.statusCode).toBe(200);
    expect(hm.memory.get('rules:srd51')!.length).toBeGreaterThan(1500);
    expect(hm.memory.get('rules:srd52')!.length).toBeGreaterThan(1000);
    expect(hm.memory.get('rules:srd51')!.some((e) => e.text.startsWith('## Spell: Fireball'))).toBe(true);
    const s = (await as('GET', '/api/settings/hivemind')).json();
    expect(s.installed.rules.srd51.count).toBe(hm.memory.get('rules:srd51')!.length);
    expect(s.hasToken).toBe(true);
  });

  it('only admins change the connection', async () => {
    const user = await register(app, 'player');
    expect((await app.inject({ method: 'POST', url: '/api/hivemind/install', headers: { cookie: user } })).statusCode).toBe(403);
  });
});

describe('runCanvas', () => {
  it('streams tokens and returns per-node outputs', async () => {
    const { runCanvas, outputJson } = await import('../src/hivemind.js');
    hm.onRun = () => ({ stream: { label: 'narration', text: 'The hag laughs.' }, outputs: { narration: 'The hag laughs.', state: '{"deltas":[]}' } });
    let streamed = '';
    const r = await runCanvas('dnd-narrate', 'go', { vars: { tableId: 't1' }, onToken: (l, t) => l === 'narration' && (streamed += t) });
    expect(streamed).toBe('The hag laughs.');
    expect(outputJson(r, 'state')).toEqual({ deltas: [] });
    expect(hm.calls.at(-1)!.vars.tableId).toBe('t1');
  });

  it('turns a failed run into a retryable error', async () => {
    const { runCanvas, withRetry } = await import('../src/hivemind.js');
    let n = 0;
    hm.onRun = () => (++n < 2 ? { error: 'Invalid JSON after repair' } : { outputs: { narration: 'ok' } });
    const r = await withRetry(() => runCanvas('dnd-narrate', 'go'), { baseMs: 1 });
    expect(r.outputs.narration.text).toBe('ok');
    expect(n).toBe(2);
  });
});

describe('canvas files', () => {
  it('are in sync with scripts/build-canvases.mjs', () => {
    const before = readdirSync('../hivemind').map((f) => readFileSync(`../hivemind/${f}`, 'utf8'));
    execFileSync(process.execPath, ['../scripts/build-canvases.mjs']);
    const after = readdirSync('../hivemind').map((f) => readFileSync(`../hivemind/${f}`, 'utf8'));
    expect(after).toEqual(before);
  });

  it('match the canvas table in HIVEMIND_CHANGES.md', () => {
    const want: Record<string, string[]> = {
      'dnd-setup': ['pitch'],
      'dnd-adjudicate': ['rolls'],
      'dnd-narrate': ['narration', 'state'],
      'dnd-chronicle': ['patches'],
      'dnd-ask': ['answer'],
      'dnd-sheet': ['sheet'],
      'dnd-portrait': ['portraits'],
    };
    for (const [id, labels] of Object.entries(want)) {
      const c = JSON.parse(readFileSync(`../hivemind/${id}.canvas.json`, 'utf8'));
      expect(c.nodes.some((n: any) => n.type === 'input')).toBe(true);
      for (const l of labels) expect(c.nodes.map((n: any) => n.label)).toContain(l);
      const ids = new Set(c.nodes.map((n: any) => n.id));
      for (const e of c.edges) expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
    }
    const narrate = JSON.parse(readFileSync('../hivemind/dnd-narrate.canvas.json', 'utf8'));
    expect(narrate.nodes.find((n: any) => n.label === 'narration').config.numCtx).toBe(32768);
    expect(narrate.nodes.find((n: any) => n.label === 'state').config.json).toBe(true);
    expect(narrate.nodes.find((n: any) => n.type === 'memory' && n.config.mode === 'save').config.key).toBe('dnd:{{vars.tableId}}');
  });
});
