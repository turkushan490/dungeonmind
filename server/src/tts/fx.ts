import { spawn, spawnSync } from 'node:child_process';
import type { Fx } from './voices.js';

let has: boolean | undefined;
export const hasFfmpeg = () => (has ??= spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0);

/** ffmpeg audio filters for monster and other voices. */
export function filterFor(fx: Fx, rate: number): string | undefined {
  switch (fx) {
    case 'monster':
      return `asetrate=${Math.round(rate * 0.72)},aresample=${rate},atempo=1.25,acrusher=bits=10:mix=0.25,aecho=0.8:0.7:60:0.35`;
    case 'giant':
      return `asetrate=${Math.round(rate * 0.8)},aresample=${rate},atempo=1.18,aecho=0.8:0.8:90:0.3`;
    case 'small':
      return `asetrate=${Math.round(rate * 1.3)},aresample=${rate},atempo=0.82`;
    case 'ghost':
      return 'highpass=f=300,aecho=0.8:0.88:500|900:0.4|0.25,volume=0.9';
    case 'radio':
      return 'highpass=f=500,lowpass=f=3000,acrusher=bits=8:mix=0.15';
    default:
      return;
  }
}

/**
 * WAV in → compressed audio out (Ogg/Opus when ffmpeg is there), with an optional voice effect.
 * Without ffmpeg the WAV is kept as is (and effects are skipped).
 */
export function encode(wav: Buffer, fx: Fx, rate: number): Promise<{ data: Buffer; ext: 'ogg' | 'wav'; fx: boolean }> {
  if (!hasFfmpeg()) return Promise.resolve({ data: wav, ext: 'wav', fx: false });
  const filter = filterFor(fx, rate);
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', ...(filter ? ['-af', filter] : []), '-c:a', 'libopus', '-b:a', '48k', '-f', 'ogg', 'pipe:1'];
  return new Promise((ok, fail) => {
    const p = spawn('ffmpeg', args);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok({ data: Buffer.concat(out), ext: 'ogg', fx: !!filter }) : fail(new Error(`ffmpeg: ${Buffer.concat(err).toString().slice(0, 300)}`))));
    p.stdin.on('error', () => {});
    p.stdin.end(wav);
  });
}
