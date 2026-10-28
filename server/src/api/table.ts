import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/index.js';
import { db } from '../db.js';
import { applyPatches, currentCampaign, parseSections, saveCampaign, SECTIONS, withParty } from '../game/campaign.js';
import { addLog, readLog } from '../game/log.js';
import { campaignFor, partyJson, recentTurns } from '../game/prompt.js';
import { think } from '../game/queue.js';
import { broadcast, gameCharacters, saveGame, saveGameCharacter } from '../game/store.js';
import { playersOf, resolveLater, retry, startGame, submitAction, activeCharacters } from '../game/turn.js';
import { HiveMindError, outputText, runCanvas, withRetry } from '../hivemind.js';
import { emitToGame } from '../realtime.js';
import { gameFor } from './games.js';

/** Per-user rate limit for writes at the table (cheat-proofing and spam). */
const hits = new Map<string, number[]>();
function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}

export function tableRoutes(app: FastifyInstance) {
  app.post('/api/games/:id/start', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'host');
    if (!r) return;
    if (r.g.status !== 'setup') return reply.code(400).send({ error: 'Already started' });
    if (!r.g.settings.pitch) return reply.code(400).send({ error: 'Pick a pitch first' });
    try {
      await startGame(r.g);
      return { ok: true };
    } catch (err) {
      return reply.code((err as HiveMindError).status || 500).send({ error: (err as Error).message });
    }
  });

  app.post('/api/games/:id/actions', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'member');
    if (!r) return;
    if (rateLimited(`act:${req.user!.id}`, 20, 60_000)) return reply.code(429).send({ error: 'Slow down a little' });
    const res = submitAction(r.g, req.user!.id, (req.body ?? {}) as { characterId: string; choice?: number; text?: string }, r.role === 'host');
    if (res.error) return reply.code(400).send({ error: res.error });
    return res;
  });

  /** Take back a declared action while the DM still waits. */
  app.delete('/api/games/:id/actions/:cid', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'member');
    if (!r) return;
    const { cid } = req.params as { cid: string };
    const c = gameCharacters(r.g.id).find((x) => x.id === cid);
    if (!c || (c.userId !== req.user!.id && r.role !== 'host')) return reply.code(403).send({ error: "That's not your character" });
    if (r.g.state.phase !== 'collect') return reply.code(400).send({ error: 'Too late, the DM is already at work' });
    delete r.g.state.actions[cid];
    saveGame(r.g);
    broadcast(r.g);
    return { ok: true };
  });

  app.post('/api/games/:id/retry', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'member');
    if (!r) return;
    if (!retry(r.g)) return reply.code(400).send({ error: 'Nothing to retry' });
    return { ok: true };
  });

  /** Host: pause (nobody can act), resume, or end the game. */
  app.post('/api/games/:id/status', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'host');
    if (!r) return;
    const { g } = r;
    const to = (req.body as { status?: string })?.status;
    if (g.status === 'setup' || g.status === 'ended') return reply.code(400).send({ error: 'The game is not running' });
    if (to === 'paused' && g.status === 'playing') {
      g.status = 'paused';
      addLog(g.id, g.state.turn, 'system', 'The host paused the game.');
    } else if (to === 'playing' && g.status === 'paused') {
      g.status = 'playing';
      addLog(g.id, g.state.turn, 'system', 'The game continues.');
    } else if (to === 'ended') {
      g.status = 'ended';
      g.state.phase = 'ended';
      addLog(g.id, g.state.turn, 'system', 'The host closed the game. The story is kept and can be read and downloaded.');
    } else return reply.code(400).send({ error: 'Status is playing, paused or ended' });
    saveGame(g);
    broadcast(g);
    // Resuming a game whose actions were all in: resolve now.
    if (g.status === 'playing' && g.state.phase === 'collect') {
      const chars = gameCharacters(g.id);
      if (activeCharacters(chars).length && activeCharacters(chars).every((c) => g.state.actions[c.id])) resolveLater(g.id);
    }
    return { ok: true };
  });

  /** Host: mark a character away (skipped, stays quietly with the group) or back; seat or unseat. */
  app.patch('/api/games/:id/characters/:cid/seat', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'member');
    if (!r) return;
    const { cid } = req.params as { cid: string };
    const c = gameCharacters(r.g.id).find((x) => x.id === cid);
    if (!c) return reply.code(404).send({ error: 'No such character' });
    if (r.role !== 'host' && c.userId !== req.user!.id) return reply.code(403).send({ error: 'Only the host or the owner can do that' });
    const { absent, seated } = (req.body ?? {}) as { absent?: boolean; seated?: boolean };
    if (absent !== undefined) c.absent = !!absent;
    if (seated !== undefined) c.seated = !!seated;
    saveGameCharacter(r.g.id, c);
    if (c.absent || !c.seated) delete r.g.state.actions[c.id];
    addLog(r.g.id, r.g.state.turn, 'system', c.absent ? `${c.name} stays quietly with the group while their player is away.` : !c.seated ? `${c.name} sits this one out.` : `${c.name} is back in the action.`);
    saveGame(r.g);
    broadcast(r.g);
    // Skipping the last player we waited for resolves the turn.
    const chars = gameCharacters(r.g.id);
    if (r.g.status === 'playing' && r.g.state.phase === 'collect' && activeCharacters(chars).length && activeCharacters(chars).every((x) => r.g.state.actions[x.id])) resolveLater(r.g.id);
    return c;
  });

  // ---- The story log ----
  app.get('/api/games/:id/log', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply);
    if (!r) return;
    const { before, limit } = req.query as { before?: string; limit?: string };
    return readLog(r.g.id, { before: Number(before) || undefined, limit: Number(limit) || 300 });
  });

  // ---- Ask the DM (out of turn, never blocks the turn) ----
  app.post('/api/games/:id/ask', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'member');
    if (!r) return;
    const q = String((req.body as { question?: string })?.question ?? '').trim();
    if (!q || q.length > 800) return reply.code(400).send({ error: 'Ask a question (max 800 characters)' });
    if (rateLimited(`ask:${req.user!.id}`, 6, 60_000)) return reply.code(429).send({ error: 'One question at a time, please' });
    const { g } = r;
    addLog(g.id, g.state.turn, 'ask', q, req.user!.username);
    const chars = gameCharacters(g.id);
    void think(g.id, () =>
      withRetry(() =>
        runCanvas('dnd-ask', q, {
          vars: {
            asker: req.user!.username,
            tableId: g.id,
            ruleset: g.ruleset,
            campaign: campaignFor(g, chars),
            party: partyJson(g.ruleset, chars, g.state, playersOf(g.id)),
            recent: recentTurns(g.id, 6000, 4),
          },
        }),
      ),
    )
      .then((res) => addLog(g.id, g.state.turn, 'answer', outputText(res, 'answer'), 'DM', { to: req.user!.username }))
      .catch((err) => addLog(g.id, g.state.turn, 'answer', `The DM couldn't answer right now (${(err as Error).message}). Ask again in a moment.`, 'DM', { to: req.user!.username, failed: true }));
    return { ok: true };
  });

  // ---- campaign.md: everyone reads, the host edits ----
  app.get('/api/games/:id/campaign', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply);
    if (!r) return;
    const versions = db.prepare('SELECT id, author, turn, at FROM campaign_versions WHERE game_id = ? ORDER BY id DESC LIMIT 200').all(r.g.id);
    const { version } = req.query as { version?: string };
    const md = version
      ? ((db.prepare('SELECT md FROM campaign_versions WHERE game_id = ? AND id = ?').get(r.g.id, Number(version)) as { md: string } | undefined)?.md ?? '')
      : withParty(currentCampaign(r.g.id), gameCharacters(r.g.id), r.g.state.npcs);
    return { md, versions, sections: SECTIONS };
  });

  app.put('/api/games/:id/campaign', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'host');
    if (!r) return;
    const md = String((req.body as { md?: string })?.md ?? '');
    if (!md.trim() || md.length > 400_000) return reply.code(400).send({ error: 'The campaign file is empty or too big' });
    // Keep the fixed sections: the host's text is merged section by section.
    const sec = parseSections(md);
    const merged = applyPatches(
      currentCampaign(r.g.id),
      Object.entries(sec).map(([section, text]) => ({ section, op: 'replace' as const, text })),
    ).md;
    saveCampaign(r.g.id, merged, 'host', r.g.state.turn);
    emitToGame(r.g.id, 'game:campaign', { gameId: r.g.id });
    return { ok: true };
  });

  /** The save file: campaign.md plus the whole story log, as Markdown. */
  app.get('/api/games/:id/export.md', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply);
    if (!r) return;
    const log = readLog(r.g.id, { limit: 1000000 });
    const lines = log.map((e) =>
      e.kind === 'narration' ? `\n${e.text}\n` : e.kind === 'action' ? `> **${e.actor}:** ${e.text}` : e.kind === 'ask' ? `> _${e.actor} asks:_ ${e.text}` : `- _${e.text}_`,
    );
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${r.g.name.replace(/[^\w -]/g, '').trim() || 'dungeonmind'}.md"`);
    return `${withParty(currentCampaign(r.g.id), gameCharacters(r.g.id), r.g.state.npcs)}\n---\n\n# The story\n${lines.join('\n')}\n`;
  });
}
