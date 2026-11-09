import { createReadStream, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { prefsOf, requireAdmin, requireUser } from '../auth/index.js';
import { db, setSetting } from '../db.js';
import { addTurnHooks } from '../game/turn.js';
import { loadGame, saveGame } from '../game/store.js';
import { textFor } from '../game/hidden.js';
import { isOnline } from '../realtime.js';
import { logProblem } from '../problems.js';
import { simContext } from '../trainer/context.js';
import { castVoice, narratorSentences, segments, type Casting, type Speaker } from '../tts/cast.js';
import { sentences } from '../tts/engine.js';
import { hasFfmpeg } from '../tts/fx.js';
import { audioDir, cachedClip, cleanupAudio, speak, ttsSettings, type Clip } from '../tts/index.js';
import { FX, VOICES, voiceById, type Fx } from '../tts/voices.js';
import { gameFor } from './games.js';

interface Part {
  speaker: string;
  text: string;
  voice: string;
  fx: Fx;
}

/** The narration as parts: narrator text in the listener's voice, NPC lines in their cast voices. */
function partsFor(gameId: string, text: string, speakers: Speaker[], narrator: string): Part[] {
  const g = loadGame(gameId)!;
  const cast: Record<string, Casting> = { ...((g.state.voices ?? {}) as Record<string, Casting>) };
  const before = JSON.stringify(cast);
  const parts = segments(text, speakers).map((s) => {
    if (s.speaker === 'narrator') return { ...s, voice: narrator, fx: 'none' as Fx };
    const c = castVoice(cast, speakers.find((x) => x.name === s.speaker) ?? { name: s.speaker, kind: 'npc' }, narrator);
    return { ...s, voice: c.voice, fx: c.fx };
  });
  if (JSON.stringify(cast) !== before) {
    const fresh = loadGame(gameId)!;
    fresh.state.voices = { ...cast, ...(fresh.state.voices ?? {}) };
    saveGame(fresh);
  }
  return parts;
}

const speakersOf = (data: unknown): Speaker[] => (Array.isArray((data as { speakers?: unknown })?.speakers) ? ((data as { speakers: Speaker[] }).speakers ?? []) : []);

/** Who audio is made for up front: everyone at the table who is online, in their own voice and speed. */
function listeners(gameId: string) {
  const s = ttsSettings();
  const out = new Map<string, { voice: string; speed: number }>();
  for (const m of db.prepare("SELECT user_id FROM game_members WHERE game_id = ? AND status = 'joined'").all(gameId) as { user_id: string }[]) {
    if (!isOnline(m.user_id)) continue;
    const n = (prefsOf(m.user_id).narrator ?? {}) as { voice?: string; speed?: number };
    const voice = voiceById(n.voice) ? n.voice! : s.narrator;
    const speed = Number(n.speed) || 1;
    out.set(`${voice}|${speed}`, { voice, speed });
  }
  if (!out.size) out.set('default', { voice: s.narrator, speed: 1 });
  return [...out.values()];
}

/**
 * Sentence by sentence: the listener hears the first one as soon as it's made, while the rest follow.
 * Ready sentences get their audio; missing ones are made in the background (the client polls).
 */
function render(whole: Part[], speed: number) {
  const parts = whole.flatMap((p) => sentences(p.text).map((text) => ({ ...p, text })));
  const clips = parts.map((p) => cachedClip(p.text, p.voice, speed, p.fx));
  const missing = parts.filter((_, i) => !clips[i]);
  if (missing.length) {
    (async () => {
      for (const p of missing) await speak(p.text, p.voice, speed, p.fx).catch((err) => logProblem('voice', err, `${p.voice}: ${p.text}`));
    })();
  }
  return {
    ready: !missing.length,
    progress: parts.length ? (parts.length - missing.length) / parts.length : 1,
    parts: parts.map((p, i) => ({ speaker: p.speaker, voice: p.voice, fx: p.fx, text: p.text, clip: clips[i] as Clip | undefined })),
  };
}

let hooked = false;
/** How many sentences of the narration coming in now were already sent off to be spoken, per game. */
const streamed = new Map<string, number>();

export function ttsRoutes(app: FastifyInstance) {
  if (!hooked) {
    hooked = true;
    // Speak the narration while it comes in, for the people listening, so ▶ has it ready.
  addTurnHooks({
    onNarrationText: (g, text) => {
      if (ttsSettings().engine === 'off') return;
      const list = narratorSentences(text);
      const done = streamed.get(g.id) ?? 0;
      const from = list.length < done ? 0 : done;
      if (list.length === from) return;
      streamed.set(g.id, list.length);
      for (const l of listeners(g.id)) for (const s of list.slice(from)) speak(s, l.voice, l.speed).catch(() => {});
    },
    // Now the speakers are known: the quotes get their voices, and whatever is still missing is made.
    afterTurn: (g, narration, state) => {
      streamed.delete(g.id);
      if (simContext() || ttsSettings().engine === 'off') return;
      for (const l of listeners(g.id)) render(partsFor(g.id, narration, (state.speakers ?? []) as Speaker[], l.voice), l.speed);
    },
  });
  }
  const t = setInterval(() => cleanupAudio(), 6 * 3600_000);
  t.unref();
  app.addHook('onClose', async () => clearInterval(t));

  app.get('/api/tts/status', { preHandler: requireUser }, async () => ({ ...ttsSettings(), voices: VOICES, effects: FX, ffmpeg: hasFfmpeg() }));

  app.put('/api/settings/tts', { preHandler: requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { engine?: string; narrator?: string; retentionDays?: number };
    if (b.engine && !['kokoro', 'chatterbox', 'off'].includes(b.engine)) return reply.code(400).send({ error: 'Engine is kokoro, chatterbox or off' });
    if (b.narrator && !voiceById(b.narrator)) return reply.code(400).send({ error: 'Unknown voice' });
    if (b.engine) setSetting('tts.engine', b.engine);
    if (b.narrator) setSetting('tts.narrator', b.narrator);
    if (b.retentionDays !== undefined) setSetting('tts.retentionDays', String(Math.max(0, Math.min(3650, Math.round(b.retentionDays)))));
    return ttsSettings();
  });

  /** The voiced narration of one log entry. */
  app.get('/api/games/:id/narration/:logId', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply);
    if (!r) return;
    const { logId } = req.params as { logId: string };
    const q = req.query as { voice?: string; speed?: string };
    const row = db.prepare("SELECT text, data FROM game_log WHERE id = ? AND game_id = ? AND kind IN ('narration', 'answer')").get(Number(logId), r.g.id) as { text: string; data: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: 'No such narration' });
    if (ttsSettings().engine === 'off') return reply.code(409).send({ error: 'The narrator voice is turned off' });
    const narrator = voiceById(q.voice) ? q.voice! : ttsSettings().narrator;
    const parts = partsFor(r.g.id, textFor(r.g, r.role, row.text), speakersOf(row.data ? JSON.parse(row.data) : {}), narrator);
    return render(parts, Number(q.speed) || 1);
  });

  /** "Read this aloud": any selected text, in the listener's voice. */
  app.post('/api/tts/speak', { preHandler: requireUser }, async (req, reply) => {
    const b = (req.body ?? {}) as { text?: string; voice?: string; speed?: number };
    const text = String(b.text ?? '').trim();
    if (!text || text.length > 3000) return reply.code(400).send({ error: 'Select up to 3000 characters' });
    if (ttsSettings().engine === 'off') return reply.code(409).send({ error: 'The narrator voice is turned off' });
    const voice = voiceById(b.voice) ? b.voice! : ttsSettings().narrator;
    return render([{ speaker: 'narrator', text, voice, fx: 'none' }], Number(b.speed) || 1);
  });

  app.get('/api/audio/:file', { preHandler: requireUser }, async (req, reply) => {
    const { file } = req.params as { file: string };
    if (!/^[a-f0-9]{32}\.(ogg|wav)$/.test(file)) return reply.code(404).send({ error: 'Not found' });
    const p = join(audioDir(), file);
    if (!existsSync(p)) return reply.code(404).send({ error: 'Not found' });
    const now = new Date();
    try {
      utimesSync(p, now, now); // played = kept longer
    } catch {}
    reply.header('content-type', file.endsWith('.ogg') ? 'audio/ogg' : 'audio/wav');
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(createReadStream(p));
  });
}
