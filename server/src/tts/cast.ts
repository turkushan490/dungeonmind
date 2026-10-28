import { createHash } from 'node:crypto';
import { sameName } from '../game/text.js';
import { DEFAULT_NARRATOR, VOICES, voiceById, type Fx, type Voice } from './voices.js';

export interface Speaker {
  name: string;
  kind?: string;
  gender?: string;
  age?: string;
}
export interface Casting {
  voice: string;
  fx: Fx;
}
export interface Segment {
  /** "narrator" or an NPC name. */
  speaker: string;
  text: string;
}

const GRADE = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F+', 'F'];
const byGrade = (a: Voice, b: Voice) => GRADE.indexOf(a.grade) - GRADE.indexOf(b.grade);

export function fxFor(s: Speaker): Fx {
  const n = `${s.name} ${s.kind ?? ''}`.toLowerCase();
  if (/ghost|spirit|wraith|specter|spectre|banshee|shade|phantom|lich/.test(n)) return 'ghost';
  if (/giant|troll|ogre|golem|titan|dragon/.test(n)) return 'giant';
  if (/imp|sprite|pixie|faerie|fairy|homunculus|kobold/.test(n)) return 'small';
  if (s.kind === 'monster' || /demon|devil|fiend|hag|ghoul|abomination|beast|horror|aberration/.test(n)) return 'monster';
  return 'none';
}

/**
 * Gives an NPC a voice from the library that fits (gender, age, monster) and that no one else at the table
 * has yet, then remembers it. The same NPC always keeps the same voice.
 */
export function castVoice(cast: Record<string, Casting>, s: Speaker, narrator = DEFAULT_NARRATOR): Casting {
  const known = Object.entries(cast).find(([k]) => sameName(k, s.name));
  if (known) return known[1];
  const fx = fxFor(s);
  const gender = s.gender === 'male' || s.gender === 'female' ? s.gender : undefined;
  const age = s.age ?? '';
  const want = (v: Voice) =>
    (age === 'child' ? v.tags.includes('child') || v.tags.includes('young') : age === 'old' ? v.tags.includes('old') || v.tags.includes('mature') : age === 'young' ? v.tags.includes('young') : true) &&
    (fx === 'monster' || fx === 'giant' ? v.tags.includes('deep') || v.tags.includes('rough') || v.gender === 'female' : true);
  const pool = VOICES.filter((v) => (!gender || v.gender === gender) && v.id !== narrator).sort(byGrade);
  const used = new Set(Object.values(cast).map((c) => c.voice));
  const pick =
    pool.find((v) => want(v) && !used.has(v.id)) ??
    pool.find((v) => !used.has(v.id)) ??
    pool[parseInt(createHash('sha1').update(s.name).digest('hex').slice(0, 6), 16) % pool.length] ??
    VOICES[0];
  const c: Casting = { voice: pick.id, fx };
  cast[s.name] = c;
  return c;
}

/**
 * Splits a narration into narrator text and quoted speech, and works out who speaks each quote:
 * a speaker named just before (or right after) the quote, else the only NPC speaking, else the narrator.
 */
export function segments(text: string, speakers: Speaker[]): Segment[] {
  const npcs = speakers.filter((s) => s.kind !== 'narrator' && s.name.toLowerCase() !== 'narrator');
  const out: Segment[] = [];
  const re = /["“]([^"”]{2,})["”]/g;
  let last = 0;
  let lastSpeaker: string | undefined;
  const push = (speaker: string, t: string) => {
    const clean = t.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const prev = out.at(-1);
    if (prev && prev.speaker === speaker) prev.text += ` ${clean}`;
    else out.push({ speaker, text: clean });
  };
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(last, m.index! - 160), m.index);
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 60);
    const named = (s: string) => {
      let best: { name: string; at: number } | undefined;
      for (const n of npcs) {
        for (const word of [n.name, n.name.replace(/^the\s+/i, ''), ...n.name.split(/[\s-]+/).filter((w) => !/^(the|a|an|of)$/i.test(w))]) {
          const at = s.toLowerCase().lastIndexOf(word.toLowerCase());
          if (word.length > 2 && at >= 0 && (!best || at > best.at)) best = { name: n.name, at };
        }
      }
      return best?.name;
    };
    const speaker = named(before) ?? named(after) ?? (npcs.length === 1 ? npcs[0].name : lastSpeaker) ?? 'narrator';
    push('narrator', text.slice(last, m.index));
    push(speaker, m[1]);
    if (speaker !== 'narrator') lastSpeaker = speaker;
    last = m.index! + m[0].length;
  }
  push('narrator', text.slice(last));
  return out;
}

export const voiceName = (id: string) => voiceById(id)?.name ?? id;
