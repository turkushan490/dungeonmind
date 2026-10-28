import { createReadStream, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireUser } from '../auth/index.js';
import { db, setSetting } from '../db.js';
import { addTurnHooks } from '../game/turn.js';
import { loadGame, saveGame } from '../game/store.js';
import { castVoice, segments, type Casting, type Speaker } from '../tts/cast.js';
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

/** Ready parts get their audio; missing ones are made in the background (the client polls). */
function render(parts: Part[], speed: number) {
  const clips = parts.map((p) => cachedClip(p.text, p.voice, speed, p.fx));
  const missing = parts.filter((_, i) => !clips[i]);
  if (missing.length) {
    (async () => {
      for (const p of missing) await speak(p.text, p.voice, speed, p.fx).catch(() => {});
    })();
  }
  return {
    ready: !missing.length,
    progress: parts.length ? (parts.length - missing.length) / parts.length : 1,
    parts: parts.map((p, i) => ({ speaker: p.speaker, voice: p.voice, fx: p.fx, text: p.text, clip: clips[i] as Clip | undefined })),
  };
}

let hooked = false;

export function ttsRoutes(app: FastifyInstance) {
  if (!hooked) {
    hooked = true;
    // Pre-speak every new narration in the default narrator voice, so most listeners get it instantly.
  addTurnHooks({
    afterTurn: (g, narration, state) => {
      const s = ttsSettings();
      if (s.engine === 'off') return;
      const parts = partsFor(g.id, narration, (state.speakers ?? []) as Speaker[], s.narrator);
      render(parts, 1);
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
    const parts = partsFor(r.g.id, row.text, speakersOf(row.data ? JSON.parse(row.data) : {}), narrator);
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
