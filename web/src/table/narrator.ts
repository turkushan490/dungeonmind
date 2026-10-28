import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';

export interface Clip {
  file: string;
  duration: number;
  words: { w: string; start: number; end: number }[];
}
interface Part {
  speaker: string;
  voice: string;
  text: string;
  clip?: Clip;
}
interface Rendered {
  ready: boolean;
  progress: number;
  parts: Part[];
}

export interface NarratorPrefs {
  voice?: string;
  speed?: number;
  volume?: number;
  autoplay?: boolean;
  highlight?: boolean;
}

/** What's playing right now, shared by the story log (highlighting) and the player bar (stop/skip). */
interface NowPlaying {
  key: string;
  label: string;
  /** Index of the spoken word within the whole text (for highlighting). */
  word: number;
  loading: boolean;
}
let now: NowPlaying | null = null;
const subs = new Set<(n: NowPlaying | null) => void>();
const emit = () => subs.forEach((f) => f(now ? { ...now } : null));
export function useNowPlaying() {
  const [n, setN] = useState<NowPlaying | null>(now);
  useEffect(() => {
    subs.add(setN);
    return () => void subs.delete(setN);
  }, []);
  return n;
}

let audio: HTMLAudioElement | null = null;
let token = 0;
let skipPart: (() => void) | null = null;

export function stop() {
  token++;
  audio?.pause();
  audio = null;
  skipPart = null;
  now = null;
  emit();
}
export const skip = () => skipPart?.();

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, '');

/** Words of a text as the story log renders them (split on whitespace). */
export const textWords = (text: string) => text.split(/\s+/).filter(Boolean);

async function fetchRendered(url: string, body?: object, onProgress?: (p: number) => void): Promise<Rendered> {
  for (let i = 0; i < 400; i++) {
    const r = await api<Rendered>(url, body ? { body, quiet: true } : { quiet: true });
    if (r.ready) return r;
    onProgress?.(r.progress);
    await new Promise((ok) => setTimeout(ok, 1200));
  }
  throw new Error('The narrator took too long');
}

/**
 * Plays the parts in order (narrator and NPC voices), highlighting the spoken word in `fullText`.
 */
async function playParts(key: string, label: string, fullText: string, load: () => Promise<Rendered>, prefs: NarratorPrefs) {
  stop();
  const my = ++token;
  now = { key, label, word: -1, loading: true };
  emit();
  let r: Rendered;
  try {
    r = await load();
  } catch (err) {
    if (my === token) {
      toast((err as Error).message);
      stop();
    }
    return;
  }
  if (my !== token) return;
  now = { ...now!, loading: false };
  emit();
  // Map each part's words onto the words of the full text.
  const words = textWords(fullText).map(norm);
  let cursor = 0;
  for (const part of r.parts) {
    if (my !== token || !part.clip) continue;
    const offsets = part.clip.words.map((x) => {
      const w = norm(x.w);
      for (let i = cursor; i < Math.min(words.length, cursor + 6); i++)
        if (words[i] === w || words[i].includes(w) || w.includes(words[i])) {
          cursor = i + 1;
          return i;
        }
      return -1;
    });
    await new Promise<void>((done) => {
      const a = new Audio(`/api/audio/${part.clip!.file}`);
      audio = a;
      a.volume = Math.max(0, Math.min(1, prefs.volume ?? 1));
      skipPart = () => {
        a.pause();
        done();
      };
      a.ontimeupdate = () => {
        if (my !== token || prefs.highlight === false) return;
        const t = a.currentTime;
        const i = part.clip!.words.findIndex((x) => t >= x.start && t < x.end);
        if (i >= 0 && offsets[i] >= 0 && offsets[i] !== now?.word) {
          now = { ...now!, word: offsets[i] };
          emit();
        }
      };
      a.onended = () => done();
      a.onerror = () => done();
      a.play().catch(() => done());
    });
  }
  if (my === token) stop();
}

export function playNarration(gameId: string, logId: number, text: string, prefs: NarratorPrefs) {
  const q = new URLSearchParams({ ...(prefs.voice ? { voice: prefs.voice } : {}), speed: String(prefs.speed ?? 1) });
  return playParts(`log-${logId}`, 'Narration', text, () => fetchRendered(`/api/games/${gameId}/narration/${logId}?${q}`), prefs);
}

export function readAloud(text: string, prefs: NarratorPrefs) {
  return playParts('selection', 'Reading aloud', text, () => fetchRendered('/api/tts/speak', { text, voice: prefs.voice, speed: prefs.speed ?? 1 }), prefs);
}
