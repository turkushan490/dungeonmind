import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { config } from './config.js';

// Each entry runs once, in order; never edit an old one, add a new one.
const MIGRATIONS = [
  // M1: accounts, sessions, settings
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT,
    pw_hash TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    adult_at TEXT,
    prefs TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // M3: character library
  `
  CREATE TABLE characters (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ruleset TEXT NOT NULL,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX characters_owner ON characters(owner_id, updated_at);
  CREATE TABLE ability_rolls (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vals TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // M4: games, members (invites), characters in games
  `
  CREATE TABLE games (
    id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    ruleset TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'setup',
    visibility TEXT NOT NULL DEFAULT 'public',
    settings TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE game_members (
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (game_id, user_id)
  );
  CREATE INDEX game_members_user ON game_members(user_id);
  CREATE TABLE game_characters (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_id TEXT,
    data TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX game_characters_game ON game_characters(game_id);
  `,
  // M5: the story log, campaign.md versions, per-turn snapshots (rerolls, rollback)
  `
  CREATE TABLE game_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    turn INTEGER NOT NULL,
    kind TEXT NOT NULL,
    actor TEXT,
    text TEXT NOT NULL,
    data TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX game_log_game ON game_log(game_id, id);
  CREATE TABLE campaign_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    md TEXT NOT NULL,
    author TEXT NOT NULL,
    turn INTEGER NOT NULL DEFAULT 0,
    at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX campaign_versions_game ON campaign_versions(game_id, id);
  CREATE TABLE turn_snapshots (
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    turn INTEGER NOT NULL,
    state TEXT NOT NULL,
    characters TEXT NOT NULL,
    log_from INTEGER NOT NULL,
    PRIMARY KEY (game_id, turn)
  );
  `,
  // M10: homebrew
  `
  CREATE TABLE homebrew (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ruleset TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX homebrew_ruleset ON homebrew(ruleset, kind);
  `,
  // M13: what the DM was asked and answered, for opted-in games (training data for HiveMind's Lab)
  `
  CREATE TABLE lab_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    turn INTEGER NOT NULL,
    canvas TEXT NOT NULL,
    question TEXT NOT NULL,
    vars TEXT NOT NULL,
    outputs TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX lab_records_game ON lab_records(game_id, id);
  `,
  // Auth portal info (X-Auth-Groups, X-Auth-Admin, X-Auth-Discord-Roles), shown in Settings → Users
  `
  ALTER TABLE users ADD COLUMN portal_groups TEXT;
  ALTER TABLE users ADD COLUMN portal_admin INTEGER;
  ALTER TABLE users ADD COLUMN discord_roles TEXT;
  `,
  // M9: the AI Trainer. Every DM call is recorded (games can opt out), labelled, reviewed and pushed to HiveMind.
  `
  ALTER TABLE lab_records ADD COLUMN node TEXT;
  ALTER TABLE lab_records ADD COLUMN messages TEXT;
  ALTER TABLE lab_records ADD COLUMN output TEXT;
  ALTER TABLE lab_records ADD COLUMN label TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE lab_records ADD COLUMN source TEXT NOT NULL DEFAULT 'game';
  ALTER TABLE lab_records ADD COLUMN corrected TEXT;
  ALTER TABLE lab_records ADD COLUMN signals TEXT;
  ALTER TABLE lab_records ADD COLUMN judge TEXT;
  ALTER TABLE lab_records ADD COLUMN sim_id TEXT;
  ALTER TABLE lab_records ADD COLUMN model TEXT;
  ALTER TABLE lab_records ADD COLUMN pushed_at TEXT;
  CREATE INDEX lab_records_label ON lab_records(label, source);
  CREATE INDEX lab_records_sim ON lab_records(sim_id);
  ALTER TABLE users ADD COLUMN training_at TEXT;
  ALTER TABLE games ADD COLUMN sim INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE narration_votes (
    log_id INTEGER NOT NULL REFERENCES game_log(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    up INTEGER NOT NULL,
    PRIMARY KEY (log_id, user_id)
  );
  CREATE TABLE trainer_scenarios (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    game_id TEXT,
    turn INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX trainer_scenarios_outcome ON trainer_scenarios(game_id, turn) WHERE source = 'outcome';
  CREATE TABLE trainer_sims (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'sim',
    status TEXT NOT NULL,
    settings TEXT NOT NULL,
    results TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE TABLE trainer_reports (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    md TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    sim_ids TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE trainer_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
];

export const db = new DatabaseSync(join(config.dataDir, 'dungeonmind.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

{
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Runs fn in one transaction: everything or nothing. Nested calls join the outer one. */
let depth = 0;
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

export function getSetting(key: string): string | undefined {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
