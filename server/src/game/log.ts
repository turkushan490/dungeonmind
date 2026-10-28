import type { LogEntry } from '@dungeonmind/shared';
import { db, json } from '../db.js';
import { emitToGame } from '../realtime.js';

const toEntry = (r: Record<string, any>): LogEntry => ({
  id: r.id,
  turn: r.turn,
  kind: r.kind,
  actor: r.actor ?? undefined,
  text: r.text,
  data: r.data ? json(r.data, undefined) : undefined,
  at: r.at,
});

/** Adds a story log line and pushes it to everyone at the table. */
export function addLog(gameId: string, turn: number, kind: LogEntry['kind'], text: string, actor?: string, data?: Record<string, unknown>): LogEntry {
  const r = db
    .prepare('INSERT INTO game_log (game_id, turn, kind, actor, text, data) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
    .get(gameId, turn, kind, actor ?? null, text, data ? JSON.stringify(data) : null) as Record<string, any>;
  const e = toEntry(r);
  emitToGame(gameId, 'game:log', { gameId, entry: e });
  return e;
}

export function readLog(gameId: string, opts: { before?: number; limit?: number; kinds?: string[] } = {}): LogEntry[] {
  const limit = Math.min(1000, opts.limit ?? 300);
  const rows = db
    .prepare(`SELECT * FROM game_log WHERE game_id = ? AND hidden = 0 ${opts.before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`)
    .all(...([gameId, ...(opts.before ? [opts.before] : []), limit] as (string | number)[])) as Record<string, any>[];
  return rows
    .reverse()
    .map(toEntry)
    .filter((e) => !opts.kinds || opts.kinds.includes(e.kind));
}

export const lastLogId = (gameId: string) => (db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM game_log WHERE game_id = ?').get(gameId) as { n: number }).n;

/** Hides a turn's entries after a reroll (kept in the DB, out of the story). */
export function hideLogFrom(gameId: string, fromId: number, kinds: string[]) {
  db.prepare(`UPDATE game_log SET hidden = 1 WHERE game_id = ? AND id > ? AND kind IN (${kinds.map(() => '?').join(',')})`).run(gameId, fromId, ...kinds);
  emitToGame(gameId, 'game:log-hidden', { gameId, fromId, kinds });
}
