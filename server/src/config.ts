import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dataDir = process.env.DATA_DIR || (existsSync('/data') ? '/data' : './data');
mkdirSync(dataDir, { recursive: true });

/** SECRET_KEY encrypts the stored HiveMind token; without it one is generated once and kept in the data dir. */
function secretKey(): Buffer {
  const env = process.env.SECRET_KEY;
  if (env) return createHash('sha256').update(env).digest();
  const file = join(dataDir, 'secret.key');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
}

export type AuthMode = 'builtin' | 'header';

export const config = {
  port: Number(process.env.PORT || 4830),
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  secretKey: secretKey(),
  /** builtin: username + password accounts in the app. header: a forward-auth proxy sets X-Auth-User / X-Auth-Email. */
  authMode: (process.env.AUTH_MODE === 'header' ? 'header' : 'builtin') as AuthMode,
  /** header mode: only trust the headers from these proxy IPs (comma separated). Empty = trust every caller. */
  headerTrustedIps: (process.env.AUTH_HEADER_TRUSTED_IPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** header mode: where "Log out" sends you (e.g. the auth portal's logout page). */
  headerLogoutUrl: process.env.AUTH_LOGOUT_URL || '',
  /** Set to true behind HTTPS so cookies get the Secure flag. */
  secureCookies: process.env.SECURE_COOKIES === 'true',
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
