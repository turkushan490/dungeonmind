import { spawnSync } from 'node:child_process';
import { existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeHiveMind } from './fake-hivemind.js';
import { CANVASES, freshApp, setupGame } from './helpers.js';

let app: FastifyInstance;
const hm = new FakeHiveMind();
let cast: typeof import('../src/tts/cast.js');
let tts: typeof import('../src/tts/index.js');
let synths = 0;

beforeAll(async () => {
  await hm.start();
  app = await freshApp({ HIVEMIND_URL: hm.url, HIVEMIND_TOKEN: hm.token });
  cast = await import('../src/tts/cast.js');
  tts = await import('../src/tts/index.js');
  const { setEngine, concat, sentences } = await import('../src/tts/engine.js');
  // A fake engine: a short tone per sentence, no model needed.
  setEngine({
    name: 'test',
    synth: async (text) => {
      synths++;
      return concat(sentences(text).map((s) => ({ text: s, samples: Float32Array.from({ length: 2400 + s.length * 100 }, (_, i) => Math.sin(i / 8) * 0.3) })), 24000);
    },
  });
  for (const id of CANVASES) hm.canvases.set(id, { id, nodes: [] });
});
afterAll(async () => {
  await app?.close();
  await hm.stop();
});

describe('voice casting', () => {
  const speakers = [
    { name: 'narrator', kind: 'narrator' },
    { name: 'The Bell-Hag', kind: 'monster', gender: 'female', age: 'old' },
    { name: 'Old Tam', kind: 'npc', gender: 'male', age: 'old' },
  ];

  it('splits narration into narrator text and who says each quote', () => {
    const s = cast.segments('The hag hisses, "Closer, little lamb." Old Tam shakes. "Run!" he cries. The rain falls.', speakers);
    expect(s).toEqual([
      { speaker: 'narrator', text: 'The hag hisses,' },
      { speaker: 'The Bell-Hag', text: 'Closer, little lamb.' },
      { speaker: 'narrator', text: 'Old Tam shakes.' },
      { speaker: 'Old Tam', text: 'Run!' },
      { speaker: 'narrator', text: 'he cries. The rain falls.' },
    ]);
  });

  it('casts fitting voices once and keeps them', () => {
    const c: Record<string, import('../src/tts/cast.js').Casting> = {};
    const hag = cast.castVoice(c, speakers[1]);
    const tam = cast.castVoice(c, speakers[2]);
    expect(hag.fx).toBe('monster');
    expect(hag.voice.startsWith('af') || hag.voice.startsWith('bf')).toBe(true);
    expect(tam.voice.startsWith('am') || tam.voice.startsWith('bm')).toBe(true);
    expect(tam.voice).not.toBe('bm_fable'); // never the narrator
    expect(cast.castVoice(c, { name: 'the bell-hag' })).toEqual(hag);
    expect(cast.fxFor({ name: 'Wailing Banshee' })).toBe('ghost');
    expect(cast.fxFor({ name: 'Hill Giant' })).toBe('giant');
  });

  it('spreads word timings over each sentence', () => {
    const w = tts.wordTimings([{ text: 'Run now', start: 0, end: 1 }]);
    expect(w.map((x) => x.w)).toEqual(['Run', 'now']);
    expect(w[0].start).toBe(0);
    expect(w[1].end).toBeCloseTo(1);
  });
});

describe('narrator audio', () => {
  it('speaks once per text and voice, then serves the stored file', async () => {
    const before = synths;
    const a = await tts.speak('The bells ring beneath the water.', 'bm_fable');
    const b = await tts.speak('The bells ring beneath the water.', 'bm_fable');
    expect(b).toEqual(a);
    expect(synths).toBe(before + 1);
    expect(a.duration).toBeGreaterThan(0.1);
    expect(a.words.length).toBe(6);
    await tts.speak('The bells ring beneath the water.', 'af_heart');
    expect(synths).toBe(before + 2);
  });

  it.runIf(spawnSync('ffmpeg', ['-version']).status === 0)('compresses with ffmpeg and applies monster effects', async () => {
    const a = await tts.speak('Pretty voices.', 'af_kore', 1, 'monster');
    expect(a.file.endsWith('.ogg')).toBe(true);
  });

  it('voices a narration for the table, casting the NPCs', async () => {
    const t = await setupGame(app);
    hm.onRun = (c) =>
      c.canvasId === 'dnd-narrate'
        ? { outputs: { narration: 'Mist. The ferryman mutters, "Not after dark." Silence.', state: JSON.stringify({ speakers: [{ name: 'narrator', kind: 'narrator' }, { name: 'Ferryman', kind: 'npc', gender: 'male', age: 'old' }], choices: {} }) } }
        : c.canvasId === 'dnd-chronicle'
          ? { outputs: { patches: '{"patches":[]}' } }
          : { outputs: {} };
    await t.as(t.host, 'POST', `/api/games/${t.id}/start`);
    const turn = await import('../src/game/turn.js');
    await turn.settled(t.id);
    const log = (await t.as(t.pl, 'GET', `/api/games/${t.id}/log`)).json();
    const n = log.find((e: any) => e.kind === 'narration');
    let r: any;
    for (let i = 0; i < 50; i++) {
      r = (await t.as(t.pl, 'GET', `/api/games/${t.id}/narration/${n.id}?voice=bf_emma`)).json();
      if (r.ready) break;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    expect(r.ready).toBe(true);
    expect(r.parts.map((p: any) => p.speaker)).toEqual(['narrator', 'Ferryman', 'narrator']);
    expect(r.parts[0].voice).toBe('bf_emma');
    expect(r.parts[1].voice).not.toBe('bf_emma');
    const g = (await t.as(t.pl, 'GET', `/api/games/${t.id}`)).json();
    expect(g.state.voices.Ferryman.voice).toBe(r.parts[1].voice);
    const audio = await t.as(t.pl, 'GET', `/api/audio/${r.parts[0].clip.file}`);
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['content-type']).toMatch(/audio/);
    expect((await app.inject({ url: `/api/audio/${r.parts[0].clip.file}` })).statusCode).toBe(401);
    expect((await t.as(t.pl, 'GET', '/api/audio/..%2F..%2Fsecret.key')).statusCode).toBe(404);
  });

  it('reads any selected text aloud', async () => {
    const { register } = await import('./helpers.js');
    const u = await register(app, 'reader');
    let r: any;
    for (let i = 0; i < 50; i++) {
      r = (await app.inject({ method: 'POST', url: '/api/tts/speak', headers: { cookie: u }, payload: { text: 'Read this aloud, please.', voice: 'af_heart' } })).json();
      if (r.ready) break;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    expect(r.parts[0].clip.words.length).toBe(4);
  });

  it('cleans up audio older than the retention', async () => {
    const a = await tts.speak('Old words.', 'bm_george');
    const p = join(tts.audioDir(), a.file);
    const old = new Date(Date.now() - 30 * 86400_000);
    utimesSync(p, old, old);
    expect(tts.cleanupAudio()).toBeGreaterThan(0);
    expect(existsSync(p)).toBe(false);
  });
});
