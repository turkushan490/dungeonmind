import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

export interface Synth {
  /** Mono PCM. */
  samples: Float32Array;
  rate: number;
  /** Each sentence with its start/end in seconds (for highlighting). */
  sentences: { text: string; start: number; end: number }[];
}

export interface TtsEngine {
  name: 'kokoro' | 'chatterbox' | 'test';
  synth(text: string, voice: string, speed: number): Promise<Synth>;
}

/** Splits text into sentences of a size Kokoro handles well (it truncates at ~500 tokens). */
export function sentences(text: string): string[] {
  const parts = text
    .replace(/\s+/g, ' ')
    .match(/[^.!?…]+[.!?…]+["'”’)]*\s*|[^.!?…]+$/g) ?? [text];
  const out: string[] = [];
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    if (p.length <= 400) out.push(p);
    else for (let i = 0; i < p.length; i += 380) out.push(p.slice(i, i + 380));
  }
  return out;
}

export function concat(chunks: { samples: Float32Array; text: string }[], rate: number, gap = 0.12): Synth {
  const pad = Math.round(rate * gap);
  const total = chunks.reduce((s, c) => s + c.samples.length + pad, 0);
  const samples = new Float32Array(total);
  const out: Synth['sentences'] = [];
  let at = 0;
  for (const c of chunks) {
    samples.set(c.samples, at);
    out.push({ text: c.text, start: at / rate, end: (at + c.samples.length) / rate });
    at += c.samples.length + pad;
  }
  return { samples, rate, sentences: out };
}

/** Kokoro-82M in-process (ONNX on the CPU). The model loads on first use, from the image or downloaded to /data/models. */
class Kokoro implements TtsEngine {
  name = 'kokoro' as const;
  private tts?: Promise<any>;

  private load() {
    if (!this.tts) {
      this.tts = (async () => {
        const { env } = await import('@huggingface/transformers');
        const baked = process.env.KOKORO_MODEL_DIR || '/app/models';
        const cache = existsSync(join(baked, 'onnx-community')) ? baked : join(config.dataDir, 'models');
        mkdirSync(cache, { recursive: true });
        env.cacheDir = cache;
        const { KokoroTTS } = await import('kokoro-js');
        return KokoroTTS.from_pretrained(process.env.KOKORO_MODEL || 'onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: (process.env.KOKORO_DTYPE as 'q8') || 'q8', device: 'cpu' });
      })();
      this.tts.catch(() => (this.tts = undefined));
    }
    return this.tts;
  }

  async synth(text: string, voice: string, speed: number): Promise<Synth> {
    const tts = await this.load();
    const chunks: { samples: Float32Array; text: string }[] = [];
    let rate = 24000;
    for (const s of sentences(text)) {
      const audio = await tts.generate(s, { voice, speed });
      rate = audio.sampling_rate;
      chunks.push({ samples: audio.audio as Float32Array, text: s });
    }
    return concat(chunks, rate);
  }
}

/** Chatterbox (MIT) through the small Python server that ships in the :full image. */
class Chatterbox implements TtsEngine {
  name = 'chatterbox' as const;
  constructor(private url: string) {}
  /** Chatterbox clones a reference clip; DungeonMind records one per library voice with Kokoro (once). */
  private async ensureRef(voice: string) {
    const dir = join(config.dataDir, 'voices');
    const file = join(dir, `${voice}.wav`);
    if (existsSync(file)) return;
    mkdirSync(dir, { recursive: true });
    try {
      const ref = await kokoro.synth('In the old tongue, the tale is told slowly, with care, by the light of a dying fire. Listen, and remember.', voice, 1);
      writeFileSync(file, encodeWav(ref.samples, ref.rate));
    } catch {
      // No Kokoro model: Chatterbox uses its own default voice.
    }
  }

  async synth(text: string, voice: string, speed: number): Promise<Synth> {
    await this.ensureRef(voice);
    const chunks: { samples: Float32Array; text: string }[] = [];
    let rate = 24000;
    for (const s of sentences(text)) {
      const res = await fetch(`${this.url}/speak`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: s, voice, speed }),
        signal: AbortSignal.timeout(300_000),
      });
      if (!res.ok) throw new Error(`Chatterbox ${res.status}: ${await res.text()}`);
      const wav = Buffer.from(await res.arrayBuffer());
      const pcm = decodeWav(wav);
      rate = pcm.rate;
      chunks.push({ samples: pcm.samples, text: s });
    }
    return concat(chunks, rate);
  }
}

let override: TtsEngine | undefined;
/** Tests swap in a fake engine. */
export const setEngine = (e: TtsEngine | undefined) => (override = e);

const kokoro = new Kokoro();
export function engine(kind: string): TtsEngine | undefined {
  if (override) return override;
  if (kind === 'off') return;
  if (kind === 'chatterbox') return new Chatterbox(process.env.CHATTERBOX_URL || 'http://127.0.0.1:4831');
  return kokoro;
}

// ---- WAV ----
export function encodeWav(samples: Float32Array, rate: number): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}

export function decodeWav(buf: Buffer): { samples: Float32Array; rate: number } {
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  let off = 12;
  while (off < buf.length - 8 && buf.toString('ascii', off, off + 4) !== 'data') off += 8 + buf.readUInt32LE(off + 4);
  const len = buf.readUInt32LE(off + 4);
  const start = off + 8;
  if (bits === 32) return { samples: new Float32Array(buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + start + len)), rate };
  const n = len / 2;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(start + i * 2) / 32768;
  return { samples, rate };
}
