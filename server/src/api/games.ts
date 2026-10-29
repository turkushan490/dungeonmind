import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { GameCharacter, GameSettings, Pitch, SetupField } from '@dungeonmind/shared';
import { requireUser } from '../auth/index.js';
import { newId } from '../crypto.js';
import { db, tx } from '../db.js';
import { validateBuild } from '../game/character.js';
import { broadcast, DEFAULT_SETTINGS, detail, freshState, gameCharacters, loadGame, roleIn, saveGame, summaries, type GameRow } from '../game/store.js';
import { HiveMindError, outputJson, runCanvas, withRetry } from '../hivemind.js';
import { background } from '../jobs.js';
import { emitToLobby, emitToUser, onGameJoin } from '../realtime.js';
import { isRuleset, rules } from '../rules/index.js';
import { loadCharacter, rolledValues } from './characters.js';
import { buildCharacter } from '../game/character.js';
import { startGame } from '../game/turn.js';

const int = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

/** Validates and clamps host-editable settings. */
export function cleanSettings(input: Partial<GameSettings>, base: GameSettings = DEFAULT_SETTINGS): GameSettings {
  const s: GameSettings = { ...base };
  if (input.startLevel !== undefined) s.startLevel = int(input.startLevel, 1, 20, base.startLevel);
  if (input.endLevel !== undefined) s.endLevel = int(input.endLevel, 1, 20, base.endLevel);
  if (s.endLevel < s.startLevel) s.endLevel = s.startLevel;
  if (input.maxPlayers !== undefined) s.maxPlayers = int(input.maxPlayers, 1, 8, base.maxPlayers);
  if (input.multiChars !== undefined) s.multiChars = !!input.multiChars;
  if (input.rerolls !== undefined) s.rerolls = int(input.rerolls, 0, 99, base.rerolls);
  if (input.xpMode !== undefined) s.xpMode = input.xpMode === 'milestone' ? 'milestone' : 'xp';
  if (input.allowManualScores !== undefined) s.allowManualScores = !!input.allowManualScores;
  if (input.approvalXp !== undefined) s.approvalXp = int(input.approvalXp, 0, 1_000_000, base.approvalXp);
  if (input.approvalGold !== undefined) s.approvalGold = int(input.approvalGold, 0, 1_000_000, base.approvalGold);
  if (typeof input.wishes === 'string') s.wishes = input.wishes.slice(0, 4000);
  if (typeof input.houseRules === 'string') s.houseRules = input.houseRules.slice(0, 4000);
  if (input.sceneImages !== undefined) s.sceneImages = !!input.sceneImages;
  if (input.labExport !== undefined) s.labExport = !!input.labExport;
  if (input.formValues && typeof input.formValues === 'object') s.formValues = JSON.parse(JSON.stringify(input.formValues).slice(0, 20_000));
  if (input.pitch && typeof input.pitch === 'object') s.pitch = { title: String(input.pitch.title ?? '').slice(0, 200), hook: String(input.pitch.hook ?? '').slice(0, 2000), tone: input.pitch.tone?.slice(0, 200) };
  return s;
}

/** Loads the game and the caller's role; replies 404/403 itself. */
export async function gameFor(req: FastifyRequest, reply: FastifyReply, need: 'any' | 'member' | 'host' = 'any') {
  const g = loadGame((req.params as { id: string }).id);
  const role = g && roleIn(g, req.user!);
  if (!g || !role) {
    reply.code(404).send({ error: 'Game not found' });
    return;
  }
  if (need === 'host' && role !== 'host') {
    reply.code(403).send({ error: 'Only the host can do that' });
    return;
  }
  if (need === 'member' && role !== 'host' && role !== 'player') {
    reply.code(403).send({ error: 'Only players at this table can do that' });
    return;
  }
  return { g, role };
}

function cleanFields(fields: unknown): SetupField[] {
  if (!Array.isArray(fields)) return [];
  return fields
    .filter((f) => f && typeof f === 'object' && typeof f.id === 'string' && typeof f.label === 'string')
    .slice(0, 12)
    .map((f) => ({
      id: String(f.id).slice(0, 40),
      label: String(f.label).slice(0, 120),
      type: ['select', 'slider', 'text', 'multi'].includes(f.type) ? f.type : 'text',
      options: Array.isArray(f.options) ? f.options.map(String).slice(0, 10) : undefined,
      min: typeof f.min === 'number' ? f.min : undefined,
      max: typeof f.max === 'number' ? f.max : undefined,
      default: f.default,
      help: typeof f.help === 'string' ? f.help.slice(0, 300) : undefined,
    }));
}

const setupVars = (g: GameRow) => ({
  ruleset: g.ruleset,
  startLevel: String(g.settings.startLevel),
  endLevel: String(g.settings.endLevel),
  maxPlayers: String(g.settings.maxPlayers),
});

export function gameRoutes(app: FastifyInstance) {
  onGameJoin((_socket, user, gameId) => {
    const g = loadGame(gameId);
    return !!g && !!roleIn(g, user) && roleIn(g, user) !== 'invited';
  });

  /** The lobby: my games, my invites, and running public games to spectate. */
  app.get('/api/games', { preHandler: requireUser }, async (req) => {
    const uid = req.user!.id;
    return {
      mine: summaries("g.id IN (SELECT game_id FROM game_members WHERE user_id = ? AND status = 'joined')", uid),
      invites: summaries("g.id IN (SELECT game_id FROM game_members WHERE user_id = ? AND status = 'invited')", uid),
      spectate: summaries(
        "g.visibility = 'public' AND g.status IN ('playing','paused') AND g.id NOT IN (SELECT game_id FROM game_members WHERE user_id = ?)",
        uid,
      ),
    };
  });

  app.post('/api/games', { preHandler: requireUser }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<GameSettings> & { name?: string; ruleset?: string; visibility?: string };
    if (!isRuleset(body.ruleset)) return reply.code(400).send({ error: 'Pick a ruleset' });
    const own = (db.prepare("SELECT COUNT(*) AS n FROM games WHERE host_id = ? AND status != 'ended'").get(req.user!.id) as { n: number }).n;
    if (own >= 20) return reply.code(400).send({ error: 'You host 20 open games already; end one first' });
    const settings = cleanSettings(body);
    const id = newId();
    tx(() => {
      db.prepare('INSERT INTO games (id, host_id, name, ruleset, visibility, settings, state) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id,
        req.user!.id,
        (body.name?.trim() || 'Untitled adventure').slice(0, 80),
        body.ruleset as string,
        body.visibility === 'private' ? 'private' : 'public',
        JSON.stringify(settings),
        JSON.stringify(freshState(settings.rerolls)),
      );
      db.prepare("INSERT INTO game_members (game_id, user_id, role, status) VALUES (?, ?, 'host', 'joined')").run(id, req.user!.id);
    });
    return { id };
  });

  /** The tutorial: a private solo game with a scripted DM (no HiveMind needed), with your character or a ready-made one. */
  app.post('/api/tutorial', { preHandler: requireUser }, async (req, reply) => {
    const src = (req.body as { characterId?: string })?.characterId ? loadCharacter((req.body as { characterId: string }).characterId) : undefined;
    if (src && src.ownerId !== req.user!.id) return reply.code(404).send({ error: 'Character not found' });
    const ruleset = src?.ruleset ?? 'srd51';
    const base =
      src ??
      buildCharacter(
        rules('srd51'),
        {
          ruleset: 'srd51',
          name: 'Rook',
          species: 'human',
          class: 'fighter',
          background: 'acolyte',
          level: 1,
          abilityMethod: 'standard',
          baseAbilities: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 },
          skills: ['athletics', 'perception'],
          equipment: ['Chain Mail', 'Longsword', 'Shield', '10 gp'],
          appearance: 'a weathered human sellsword',
        },
        { id: 'tutorial', ownerId: req.user!.id },
      );
    const id = newId();
    const settings = cleanSettings({ startLevel: base.level, endLevel: Math.min(20, base.level + 1), rerolls: 1, sceneImages: false }, DEFAULT_SETTINGS);
    settings.tutorial = true;
    settings.pitch = { title: 'The Old Mill (tutorial)', hook: 'Learn the table: choices, dice, a short fight, XP and a level-up.' };
    const c: GameCharacter = { ...base, id: newId(), userId: req.user!.id, seated: true, absent: false };
    tx(() => {
      db.prepare("INSERT INTO games (id, host_id, name, ruleset, visibility, settings, state) VALUES (?, ?, 'Tutorial: The Old Mill', ?, 'private', ?, ?)").run(id, req.user!.id, ruleset, JSON.stringify(settings), JSON.stringify(freshState(1)));
      db.prepare("INSERT INTO game_members (game_id, user_id, role, status) VALUES (?, ?, 'host', 'joined')").run(id, req.user!.id);
      db.prepare('INSERT INTO game_characters (id, game_id, user_id, source_id, data) VALUES (?, ?, ?, ?, ?)').run(c.id, id, req.user!.id, src?.id ?? null, JSON.stringify(c));
    });
    await startGame(loadGame(id)!);
    return { id };
  });

  app.get('/api/games/:id', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply);
    if (r) return detail(r.g, r.role);
  });

  /** Host changes settings (levels, players, rerolls…) before the game starts; visibility and name any time. */
  app.put('/api/games/:id', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'host');
    if (!r) return;
    const body = (req.body ?? {}) as Partial<GameSettings> & { name?: string; visibility?: string };
    const { g } = r;
    if (body.name?.trim()) g.name = body.name.trim().slice(0, 80);
    if (body.visibility === 'public' || body.visibility === 'private') g.visibility = body.visibility;
    if (g.status === 'setup') {
      const before = g.settings.rerolls;
      g.settings = cleanSettings(body, g.settings);
      if (g.settings.rerolls !== before) g.state.rerollsLeft = g.settings.rerolls;
    } else {
      // During play only the approval thresholds and house rules can change.
      g.settings = cleanSettings({ approvalXp: body.approvalXp, approvalGold: body.approvalGold, houseRules: body.houseRules, sceneImages: body.sceneImages, labExport: body.labExport }, g.settings);
    }
    saveGame(g);
    broadcast(g);
    return detail(g, r.role);
  });

  app.delete('/api/games/:id', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'host');
    if (!r) return;
    db.prepare('DELETE FROM games WHERE id = ?').run(r.g.id);
    emitToLobby('games:changed', {});
    return { ok: true };
  });

  // ---- Setup with the AI: pitches, then a form for the chosen pitch ----
  app.post('/api/games/:id/pitches', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'host');
    if (!r) return;
    const { g } = r;
    const wishes = String((req.body as { wishes?: string })?.wishes ?? g.settings.wishes ?? '').slice(0, 4000);
    return background(req, reply, async () => {
      const out = await withRetry(() => runCanvas('dnd-setup', wishes || 'Surprise me: a dark fantasy adventure.', { vars: { ...setupVars(g), stage: 'pitches', pitch: '' } }));
      const pitches = (outputJson<{ pitches?: Pitch[] }>(out, 'pitch').pitches ?? [])
        .filter((p) => p?.title)
        .slice(0, 6)
        .map((p) => ({ title: String(p.title).slice(0, 200), hook: String(p.hook ?? '').slice(0, 2000), tone: p.tone ? String(p.tone).slice(0, 200) : undefined, themes: Array.isArray(p.themes) ? p.themes.map(String).slice(0, 6) : undefined }));
      if (!pitches.length) throw new HiveMindError('The DM had no pitches; try again');
      g.settings.wishes = wishes;
      g.settings.pitches = pitches;
      saveGame(g);
      return { pitches };
    });
  });

  app.post('/api/games/:id/form', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'host');
    if (!r) return;
    const { g } = r;
    const p = (req.body as { pitch?: Pitch })?.pitch;
    if (!p?.title) return reply.code(400).send({ error: 'Pick or write a pitch' });
    g.settings = cleanSettings({ pitch: p }, g.settings);
    return background(req, reply, async () => {
      const out = await withRetry(() =>
        runCanvas('dnd-setup', g.settings.wishes || p.title, { vars: { ...setupVars(g), stage: 'form', pitch: `${g.settings.pitch!.title}: ${g.settings.pitch!.hook}` } }),
      );
      const f = outputJson<{ title?: string; summary?: string; fields?: unknown }>(out, 'pitch');
      g.settings.form = { title: f.title ? String(f.title).slice(0, 120) : undefined, summary: f.summary ? String(f.summary).slice(0, 2000) : undefined, fields: cleanFields(f.fields) };
      g.settings.formValues = Object.fromEntries(g.settings.form.fields.map((x) => [x.id, x.default ?? (x.type === 'multi' ? [] : x.type === 'slider' ? (x.min ?? 0) : '')]));
      if (f.title && g.name === 'Untitled adventure') g.name = String(f.title).slice(0, 80);
      saveGame(g);
      return { form: g.settings.form, formValues: g.settings.formValues, name: g.name };
    });
  });

  // ---- Invites ----
  app.post('/api/games/:id/invites', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'host');
    if (!r) return;
    const name = String((req.body as { username?: string })?.username ?? '').trim();
    const u = db.prepare('SELECT id, username FROM users WHERE username = ?').get(name) as { id: string; username: string } | undefined;
    if (!u) return reply.code(404).send({ error: `No user called "${name}"` });
    const joined = (db.prepare("SELECT COUNT(*) AS n FROM game_members WHERE game_id = ? AND role = 'player'").get(r.g.id) as { n: number }).n;
    if (joined >= r.g.settings.maxPlayers) return reply.code(400).send({ error: `The table is full (${r.g.settings.maxPlayers} players)` });
    db.prepare("INSERT INTO game_members (game_id, user_id, role, status) VALUES (?, ?, 'player', 'invited') ON CONFLICT DO NOTHING").run(r.g.id, u.id);
    emitToUser(u.id, 'invite', { gameId: r.g.id, name: r.g.name, from: req.user!.username });
    broadcast(r.g);
    return detail(r.g, r.role);
  });

  app.post('/api/games/:id/accept', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply);
    if (!r) return;
    if (r.role !== 'invited') return reply.code(400).send({ error: 'No invite to accept' });
    db.prepare("UPDATE game_members SET status = 'joined' WHERE game_id = ? AND user_id = ?").run(r.g.id, req.user!.id);
    broadcast(r.g);
    return detail(r.g, 'player');
  });

  /** Decline an invite, leave a game, or (host) remove a player. */
  app.delete('/api/games/:id/members/:userId', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply);
    if (!r) return;
    const { userId } = req.params as { userId: string };
    if (userId !== req.user!.id && r.role !== 'host') return reply.code(403).send({ error: 'Only the host can remove players' });
    if (userId === r.g.hostId) return reply.code(400).send({ error: 'The host can end the game instead of leaving it' });
    tx(() => {
      db.prepare('DELETE FROM game_members WHERE game_id = ? AND user_id = ?').run(r.g.id, userId);
      if (r.g.status === 'setup') db.prepare('DELETE FROM game_characters WHERE game_id = ? AND user_id = ?').run(r.g.id, userId);
    });
    broadcast(r.g);
    return { ok: true };
  });

  // ---- Characters at the table ----
  app.post('/api/games/:id/characters', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'member');
    if (!r) return;
    const { g } = r;
    if (g.status === 'ended') return reply.code(400).send({ error: 'This game has ended' });
    const src = loadCharacter(String((req.body as { characterId?: string })?.characterId ?? ''));
    if (!src || src.ownerId !== req.user!.id) return reply.code(404).send({ error: 'Character not found' });
    if (src.ruleset !== g.ruleset) return reply.code(400).send({ error: `This game uses ${g.ruleset}; ${src.name} is a ${src.ruleset} character` });
    if (src.level !== g.settings.startLevel) return reply.code(400).send({ error: `Characters join this game at level ${g.settings.startLevel} (${src.name} is ${src.level}). Change the level in the builder.` });
    if (src.abilityMethod === 'manual' && !g.settings.allowManualScores) return reply.code(400).send({ error: 'This game only allows standard array, point buy or server-rolled scores' });
    const errors = validateBuild(rules(g.ruleset), src, { rolled: rolledValues(src.rollId, req.user!.id), minLevel: g.settings.startLevel, maxLevel: g.settings.endLevel });
    if (errors.length) return reply.code(400).send({ error: `${src.name} isn't legal: ${errors[0]}`, errors });
    const mine = gameCharacters(g.id).filter((c) => c.userId === req.user!.id);
    if (mine.length && !g.settings.multiChars) return reply.code(400).send({ error: 'One character per player at this table' });
    if (mine.some((c) => c.name === src.name)) return reply.code(400).send({ error: `${src.name} is already at the table` });
    const c: GameCharacter = { ...src, id: newId(), userId: req.user!.id, seated: true, absent: false };
    db.prepare('INSERT INTO game_characters (id, game_id, user_id, source_id, data, position) VALUES (?, ?, ?, ?, ?, ?)').run(
      c.id,
      g.id,
      req.user!.id,
      src.id,
      JSON.stringify(c),
      gameCharacters(g.id).length,
    );
    broadcast(g);
    return c;
  });

  app.delete('/api/games/:id/characters/:cid', { preHandler: requireUser }, async (req, reply) => {
    const r = await gameFor(req, reply, 'member');
    if (!r) return;
    const { cid } = req.params as { cid: string };
    if (r.g.status !== 'setup') return reply.code(400).send({ error: 'Characters can only leave before the game starts (seat them out instead)' });
    const own = r.role === 'host' ? '' : ' AND user_id = ?';
    db.prepare(`DELETE FROM game_characters WHERE game_id = ? AND id = ?${own}`).run(...[r.g.id, cid, ...(own ? [req.user!.id] : [])]);
    broadcast(r.g);
    return { ok: true };
  });
}
