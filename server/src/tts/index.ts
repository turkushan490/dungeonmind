import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { getSetting } from '../db.js';
import { encodeWav, engine } from './engine.js';
import { encode } from './fx.js';
import { DEFAULT_NARRATOR, FX, voiceById, type Fx } from './voices.js';

export const audioDir = () => {
  const d = join(config.dataDir, 'audio');
  mkdirSync(d, { recursive: true });
  return d;
};

export interface Clip {
  /** Served at /api/audio/<file>. */
  file: string;
  duration: number;
  /** Estimated word timings (seconds) for highlighting: exact per sentence, spread by length inside it. */
  words: { w: string; start: number; end: number }[];
}

export interface TtsSettings {
  engine: 'kokoro' | 'chatterbox' | 'off';
  narrator: string;
  retentionDays: number;
}
export function ttsSettings(): TtsSettings {
  const e = getSetting('tts.engine') ?? process.env.TTS_ENGINE ?? 'kokoro';
  return {
    engine: e === 'chatterbox' || e === 'off' ? e : 'kokoro',
    narrator: voiceById(getSetting('tts.narrator') ?? '') ? getSetting('tts.narrator')! : DEFAULT_NARRATOR,
    retentionDays: Number(getSetting('tts.retentionDays') ?? 14),
  };
}

export function wordTimings(sentences: { text: string; start: number; end: number }[]): Clip['words'] {
  const out: Clip['words'] = [];
  for (const s of sentences) {
    const words = s.text.split(/\s+/).filter(Boolean);
    const weight = words.reduce((n, w) => n + w.length + 1, 0);
    let t = s.start;
    for (const w of words) {
      const d = ((s.end - s.start) * (w.length + 1)) / weight;
      out.push({ w, start: +t.toFixed(3), end: +(t + d).toFixed(3) });
      t += d;
    }
  }
  return out;
}

const keyOf = (text: string, voice: string, speed: number, fx: Fx, eng: string) => createHash('sha256').update(`${eng}|${voice}|${speed}|${fx}|${text}`).digest('hex').slice(0, 32);

/** One synthesis at a time: the CPU is shared with the server. */
let chain: Promise<unknown> = Promise.resolve();
const inflight = new Map<string, Promise<Clip>>();

export function cachedClip(text: string, voice: string, speed = 1, fx: Fx = 'none'): Clip | undefined {
  const eng = engine(ttsSettings().engine);
  if (!eng) return;
  const sp = Math.max(0.5, Math.min(2, Math.round(speed * 20) / 20));
  const key = keyOf(text, voiceById(voice) ? voice : ttsSettings().narrator, sp, FX.includes(fx) ? fx : 'none', eng.name);
  const meta = join(audioDir(), `${key}.json`);
  return existsSync(meta) ? (JSON.parse(readFileSync(meta, 'utf8')) as Clip) : undefined;
}

/**
 * Speaks a text with a voice, once: the result is stored and every listener plays the same file.
 */
export function speak(text: string, voice: string, speed = 1, fx: Fx = 'none'): Promise<Clip> {
  const s = ttsSettings();
  const eng = engine(s.engine);
  if (!eng) return Promise.reject(new Error('The narrator voice is turned off'));
  const v = voiceById(voice) ? voice : s.narrator;
  const sp = Math.max(0.5, Math.min(2, Math.round(speed * 20) / 20));
  const f: Fx = FX.includes(fx) ? fx : 'none';
  const key = keyOf(text, v, sp, f, eng.name);
  const hit = cachedClip(text, v, sp, f);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running;
  const job = (chain = chain.catch(() => {}).then(async () => {
    const out = await eng.synth(text.slice(0, 6000), v, sp);
    const enc = await encode(encodeWav(out.samples, out.rate), f, out.rate);
    const file = `${key}.${enc.ext}`;
    writeFileSync(join(audioDir(), file), enc.data);
    const clip: Clip = { file, duration: out.samples.length / out.rate, words: wordTimings(out.sentences) };
    writeFileSync(join(audioDir(), `${key}.json`), JSON.stringify(clip));
    return clip;
  })) as Promise<Clip>;
  inflight.set(key, job);
  job.finally(() => inflight.delete(key)).catch(() => {});
  return job;
}

/** Removes audio not played (or made) for `retentionDays`. */
export function cleanupAudio(now = Date.now()): number {
  const days = ttsSettings().retentionDays;
  if (days <= 0) return 0;
  let n = 0;
  for (const f of readdirSync(audioDir())) {
    const p = join(audioDir(), f);
    if (now - statSync(p).mtimeMs > days * 86400_000) {
      rmSync(p, { force: true });
      n++;
    }
  }
  return n;
}
