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
export async function register(app: FastifyInstance, username: string, password = 'Password!23'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password, adult: true } });
  if (res.statusCode !== 200) throw new Error(`register ${username}: ${res.body}`);
  const c = res.cookies.find((c) => c.name === 'dm_session')!;
  return `dm_session=${c.value}`;
}

/** Registers and makes the account an admin (admins come from ADMIN_USERNAME or Settings → Users). */
export async function registerAdmin(app: FastifyInstance, username: string): Promise<string> {
  const cookie = await register(app, username);
  const { db } = await import('../src/db.js');
  db.prepare("UPDATE users SET role = 'admin' WHERE username = ?").run(username);
  return cookie;
}

export const CANVASES = ['dnd-setup', 'dnd-adjudicate', 'dnd-narrate', 'dnd-chronicle', 'dnd-ask', 'dnd-sheet', 'dnd-portrait', 'dnd-scene'];

export const fighterBuild = (name: string, over: Record<string, unknown> = {}) => ({
  ruleset: 'srd51',
  name,
  species: 'human',
  class: 'fighter',
  background: 'acolyte',
  level: 1,
  abilityMethod: 'standard',
  baseAbilities: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
  skills: ['athletics', 'perception'],
  equipment: ['Chain Mail', 'Longsword', 'Shield', '20 Arrows', '10 gp'],
  ...over,
});

export const clericBuild = (name: string) => ({
  ruleset: 'srd51',
  name,
  species: 'human',
  class: 'cleric',
  subclass: 'life',
  background: 'acolyte',
  level: 1,
  abilityMethod: 'standard',
  baseAbilities: { str: 13, dex: 10, con: 14, int: 8, wis: 15, cha: 12 },
  skills: ['medicine', 'persuasion'],
  cantrips: ['sacred-flame', 'guidance', 'light'],
  spells: ['cure-wounds', 'bless', 'guiding-bolt'],
  equipment: ['Chain Mail', 'Mace', 'Shield'],
});

/** A started-ready game: host + one more player, one character each, a pitch picked. */
export async function setupGame(app: FastifyInstance, opts: { rerolls?: number; endLevel?: number; builds?: [object, object] } = {}) {
  const host = await register(app, `host${Math.random().toString(36).slice(2, 7)}`);
  const pl = await register(app, `pl${Math.random().toString(36).slice(2, 7)}`);
  const as = (cookie: string, method: string, url: string, payload?: unknown) => app.inject({ method: method as 'GET', url, headers: { cookie }, payload: payload as object });
  const id = (await as(host, 'POST', '/api/games', { ruleset: 'srd51', name: 'Test Tale', rerolls: opts.rerolls ?? 2, endLevel: opts.endLevel ?? 5 })).json().id as string;
  const plName = (await as(pl, 'GET', '/api/auth/me')).json().username;
  await as(host, 'POST', `/api/games/${id}/invites`, { username: plName });
  await as(pl, 'POST', `/api/games/${id}/accept`);
  const [b1, b2] = opts.builds ?? [fighterBuild('Turks'), clericBuild('Esva')];
  const c1 = (await as(host, 'POST', '/api/characters', b1)).json();
  const c2 = (await as(pl, 'POST', '/api/characters', b2)).json();
  if (!c1.id || !c2.id) throw new Error(`character: ${JSON.stringify(c1.errors ?? c2.errors)}`);
  const g1 = (await as(host, 'POST', `/api/games/${id}/characters`, { characterId: c1.id })).json();
  const g2 = (await as(pl, 'POST', `/api/games/${id}/characters`, { characterId: c2.id })).json();
  const { db } = await import('../src/db.js');
  const row = db.prepare('SELECT settings FROM games WHERE id = ?').get(id) as { settings: string };
  db.prepare('UPDATE games SET settings = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.settings), pitch: { title: 'Drowned Bells', hook: 'Bells ring underwater.' } }), id);
  return { id, host, pl, as, hostChar: g1.id as string, plChar: g2.id as string };
}
