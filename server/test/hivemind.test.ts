import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeHiveMind } from './fake-hivemind.js';
import { freshApp, register, registerAdmin } from './helpers.js';

let app: FastifyInstance;
let admin: string;
const hm = new FakeHiveMind();

beforeAll(async () => {
  await hm.start();
  app = await freshApp({ HIVEMIND_URL: hm.url, HIVEMIND_TOKEN: hm.token });
  admin = await registerAdmin(app, 'admin');
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

  it('installs every canvas, with the models from Settings by role', async () => {
    await as('PUT', '/api/settings/hivemind', { models: { story: { providerId: 'ollama', model: 'story-24b' }, json: { providerId: 'ollama', model: 'json-20b' } } });
    const r = (await as('POST', '/api/hivemind/install')).json();
    expect(r.canvases.every((c: any) => c.ok)).toBe(true);
    expect(hm.canvases.size).toBe(readdirSync('../hivemind').filter((f) => f.endsWith('.canvas.json')).length);
    const narrate = hm.canvases.get('dnd-narrate');
    expect(narrate.nodes.find((n: any) => n.label === 'narration').config.model.model).toBe('story-24b');
    expect(narrate.nodes.find((n: any) => n.label === 'state').config.model.model).toBe('json-20b');
    // The image node has no image model yet: reported, not failed.
    expect(r.canvases.find((c: any) => c.id === 'dnd-portrait').needsModel).toEqual(['portraits']);

    // A model left in a DM block gives way to the one in Settings; the Trainer's blocks keep theirs.
    narrate.nodes.find((n: any) => n.label === 'narration').config.model = { providerId: 'ollama', model: 'old-dm' };
    hm.canvases.get('dnd-judge').nodes.find((n: any) => n.label === 'verdict').config.model = { providerId: 'ollama', model: 'strict-judge' };
    await as('POST', '/api/hivemind/install');
    expect(hm.canvases.get('dnd-narrate').nodes.find((n: any) => n.label === 'narration').config.model.model).toBe('story-24b');
    expect(hm.canvases.get('dnd-judge').nodes.find((n: any) => n.label === 'verdict').config.model.model).toBe('strict-judge');
  });

  it('reads answers a model wrapped in an extra layer, and leaves real answers alone', async () => {
    const { outputJson } = await import('../src/hivemind.js');
    const out = (text: string, label: string) => outputJson<any>({ runId: 'r', outputs: { [label]: { text } } } as any, label);
    expect(out('{"pitches":{"pitches":[{"title":"A"}]}}', 'pitch')).toEqual({ pitches: [{ title: 'A' }] });
    expect(out('{"state":{"xp":5}}', 'state')).toEqual({ xp: 5 });
    expect(out('{"choices":{"Rook":["Run"]}}', 'state')).toEqual({ choices: { Rook: ['Run'] } });
  });

  it('keeps what went wrong for admins under Settings → Problems', async () => {
    const { logProblem } = await import('../src/problems.js');
    await as('DELETE', '/api/problems');
    logProblem('job', Object.assign(new Error('The DM had no pitches'), { raw: 'not a pitch' }), 'POST /api/games/x/pitches');
    const [p] = (await as('GET', '/api/problems')).json();
    expect(p).toMatchObject({ source: 'job', message: 'The DM had no pitches' });
    expect(p.detail).toContain('not a pitch');
    expect(p.detail).toContain('POST /api/games/x/pitches');
    expect((await app.inject({ url: '/api/problems' })).statusCode).toBe(401);
    await as('DELETE', '/api/problems');
    expect((await as('GET', '/api/problems')).json()).toEqual([]);
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

describe('withRetry with a cancel signal', () => {
  it('stops in the pause between attempts and never runs the next one', async () => {
    const { withRetry, HiveMindError, CancelledError } = await import('../src/hivemind.js');
    const stop = new AbortController();
    let n = 0;
    const run = withRetry(
      async () => {
        n++;
        setTimeout(() => stop.abort(), 20);
        throw new HiveMindError('Invalid JSON after repair');
      },
      { baseMs: 5000, signal: stop.signal },
    );
    const t = Date.now();
    await expect(run).rejects.toBeInstanceOf(CancelledError);
    expect(n).toBe(1);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('stops the HiveMind run when the signal fires mid-run', async () => {
    const { runCanvas, withRetry, CancelledError } = await import('../src/hivemind.js');
    hm.onRun = () => ({ delayMs: 300, outputs: { narration: 'too late' } });
    const calls = hm.calls.length;
    const stops = hm.cancelled.length;
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    await expect(withRetry(() => runCanvas('dnd-narrate', 'go', { signal: stop.signal }), { baseMs: 1, signal: stop.signal })).rejects.toBeInstanceOf(CancelledError);
    for (let i = 0; i < 100 && hm.cancelled.length === stops; i++) await new Promise((r) => setTimeout(r, 10));
    expect(hm.cancelled.length).toBe(stops + 1);
    expect(hm.calls.length).toBe(calls + 1);
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
    expect(narrate.nodes.find((n: any) => n.label === 'narration').config.numCtx).toBe(16384);
    expect(narrate.nodes.find((n: any) => n.label === 'state').config.json).toBe(true);
    expect(narrate.nodes.find((n: any) => n.type === 'memory' && n.config.mode === 'save').config.key).toBe('dnd:{{vars.tableId}}');
  });
});
