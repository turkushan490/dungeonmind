import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/** A fresh app on a fresh data dir. Call once per test file (modules keep state per file). */
export async function freshApp(env: Record<string, string> = {}): Promise<FastifyInstance> {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dm-test-'));
  Object.assign(process.env, env);
  const { buildApp } = await import('../src/app.js');
  const app = await buildApp({ logger: false, web: false, realtime: false });
  await app.ready();
  return app;
}

/** Registers (builtin mode) and returns the session cookie header. */
export async function register(app: FastifyInstance, username: string, password = 'password123'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password, adult: true } });
  if (res.statusCode !== 200) throw new Error(`register ${username}: ${res.body}`);
  const c = res.cookies.find((c) => c.name === 'dm_session')!;
  return `dm_session=${c.value}`;
}
