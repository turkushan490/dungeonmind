import type { GameCharacter, GameDetail, GameMember, GameSettings, GameState, GameStatus, GameSummary, Ruleset } from '@dungeonmind/shared';
import type { User } from '../auth/index.js';
import { db, json } from '../db.js';
import { emitToGame, isOnline } from '../realtime.js';
import { rules } from '../rules/index.js';
import { derive } from './character.js';

export interface GameRow {
  id: string;
  hostId: string;
  name: string;
  ruleset: Ruleset;
  status: GameStatus;
  visibility: 'public' | 'private';
  settings: GameSettings;
  state: GameState;
  updatedAt: string;
}

export const DEFAULT_SETTINGS: GameSettings = {
  startLevel: 1,
  endLevel: 5,
  maxPlayers: 4,
  multiChars: false,
  rerolls: 3,
  xpMode: 'xp',
  allowManualScores: false,
  approvalXp: 2000,
  approvalGold: 500,
};

export const freshState = (rerolls: number): GameState => ({
  phase: 'lobby',
  turn: 0,
  choices: {},
  actions: {},
  rolls: [],
  spent: [],
  refused: [],
  npcs: [],
  zones: [],
  positions: {},
  approvals: [],
  rerollsLeft: rerolls,
});

const toRow = (r: Record<string, any>): GameRow => ({
  id: r.id,
  hostId: r.host_id,
  name: r.name,
  ruleset: r.ruleset,
  status: r.status,
  visibility: r.visibility,
  settings: { ...DEFAULT_SETTINGS, ...json<Partial<GameSettings>>(r.settings, {}) },
  state: json<GameState>(r.state, freshState(0)),
  updatedAt: r.updated_at,
});

export function loadGame(id: string): GameRow | undefined {
  const r = db.prepare('SELECT * FROM games WHERE id = ?').get(id) as Record<string, any> | undefined;
  return r ? toRow(r) : undefined;
}

export function saveGame(g: GameRow) {
  db.prepare("UPDATE games SET name = ?, status = ?, visibility = ?, settings = ?, state = ?, updated_at = datetime('now') WHERE id = ?").run(
    g.name,
    g.status,
    g.visibility,
    JSON.stringify(g.settings),
    JSON.stringify(g.state),
    g.id,
  );
}

export function members(gameId: string): GameMember[] {
  return (
    db.prepare('SELECT m.user_id, u.username, m.role, m.status FROM game_members m JOIN users u ON u.id = m.user_id WHERE m.game_id = ? ORDER BY m.role DESC, m.created_at').all(gameId) as Record<
      string,
      string
    >[]
  ).map((m) => ({ userId: m.user_id, username: m.username, role: m.role as 'host' | 'player', status: m.status as 'invited' | 'joined', online: isOnline(m.user_id) }));
}

export function gameCharacters(gameId: string): GameCharacter[] {
  return (db.prepare('SELECT data FROM game_characters WHERE game_id = ? ORDER BY position, rowid').all(gameId) as { data: string }[]).map((r) => JSON.parse(r.data) as GameCharacter);
}

export function saveGameCharacter(gameId: string, c: GameCharacter) {
  c.updatedAt = new Date().toISOString();
  db.prepare('UPDATE game_characters SET data = ? WHERE id = ? AND game_id = ?').run(JSON.stringify(c), c.id, gameId);
}

export type GameRole = GameDetail['myRole'];

/** host / player (joined) / invited / spectator (public game, or anyone for a game they can see) / undefined = no access. */
export function roleIn(g: GameRow, user: User): GameRole | undefined {
  const m = db.prepare('SELECT role, status FROM game_members WHERE game_id = ? AND user_id = ?').get(g.id, user.id) as { role: string; status: string } | undefined;
  if (m?.status === 'joined') return m.role as 'host' | 'player';
  if (m?.status === 'invited') return 'invited';
  if (g.visibility === 'public' && g.status !== 'setup') return 'spectator';
  return undefined;
}

export const derivedOf = (g: GameRow, chars: GameCharacter[]) => Object.fromEntries(chars.map((c) => [c.id, derive(rules(g.ruleset), c)]));

export function detail(g: GameRow, role: GameRole): GameDetail {
  const characters = gameCharacters(g.id);
  return {
    id: g.id,
    name: g.name,
    ruleset: g.ruleset,
    status: g.status,
    visibility: g.visibility,
    hostId: g.hostId,
    settings: g.settings,
    members: members(g.id),
    characters,
    state: g.state,
    derived: derivedOf(g, characters),
    myRole: role,
  };
}

/** Everyone at the table (and spectators) gets the new state. */
export function broadcast(g: GameRow) {
  const characters = gameCharacters(g.id);
  emitToGame(g.id, 'game:update', { id: g.id, status: g.status, state: g.state, characters, derived: derivedOf(g, characters), members: members(g.id), settings: g.settings, name: g.name, visibility: g.visibility });
}

export function summaries(where: string, ...args: (string | number)[]): GameSummary[] {
  return (
    db
      .prepare(
        `SELECT g.id, g.name, g.ruleset, g.status, g.visibility, g.updated_at, u.username AS host,
          (SELECT COUNT(*) FROM game_members m WHERE m.game_id = g.id AND m.status = 'joined') AS players
         FROM games g JOIN users u ON u.id = g.host_id WHERE ${where} ORDER BY g.updated_at DESC LIMIT 100`,
      )
      .all(...args) as Record<string, any>[]
  ).map((r) => ({ id: r.id, name: r.name, ruleset: r.ruleset, status: r.status, visibility: r.visibility, host: r.host, players: r.players, updatedAt: r.updated_at }));
}
