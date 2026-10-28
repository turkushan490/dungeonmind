import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dataDir = process.env.DATA_DIR || (existsSync('/data') ? '/data' : './data');
mkdirSync(dataDir, { recursive: true });

/** Encrypts the stored HiveMind token: generated once and kept in the data dir. */
function secretKey(): Buffer {
  const file = join(dataDir, 'secret.key');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
}

export type AuthMode = 'login' | 'portal';

/** login: DungeonMind's own login page. portal: a forward-auth portal sets X-Auth-User. Old names builtin / header still work. */
export const parseAuthMode = (v: string | undefined): AuthMode => (v === 'portal' || v === 'header' ? 'portal' : 'login');

export const config = {
  port: Number(process.env.PORT || 4830),
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  secretKey: secretKey(),
  authMode: parseAuthMode(process.env.AUTH_MODE),
  /** The admin account from Docker: created or updated on every start. */
  adminUsername: process.env.ADMIN_USERNAME?.trim() || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  webDir: resolve(process.env.WEB_DIR || 'web'),
  /** Seeds the HiveMind connection on the first start; change it later in Settings. */
  hivemindUrl: process.env.HIVEMIND_URL || '',
  hivemindToken: process.env.HIVEMIND_TOKEN || '',
  /** Where the SRD rules JSON lives (server/data in dev, /app/server/data in the image). */
  rulesDir: resolve(process.env.RULES_DIR || (existsSync('server/data') ? 'server/data' : 'data')),
};

export const dataPath = (...parts: string[]) => {
  const p = join(config.dataDir, ...parts);
  return p;
};
