import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Me } from '@dungeonmind/shared';
import { config } from '../config.js';
import { sha256 } from '../crypto.js';
import { db, getSetting, json, setSetting } from '../db.js';
import { builtinRoutes, userBySession, SESSION_COOKIE } from './builtin.js';
import { userFromHeaders } from './header.js';

export interface User {
  id: string;
  username: string;
  role: 'admin' | 'user';
  /** When the 18+ question was answered; until then only the age gate works. */
  adultAt?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

export interface AuthInput {
  headers: Record<string, string | string[] | undefined>;
  ip: string;
  cookies: Record<string, string | undefined>;
}

export const userCount = () => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;

export function userById(id: string): User | undefined {
  const r = db.prepare('SELECT id, username, role, adult_at FROM users WHERE id = ?').get(id) as Record<string, string> | undefined;
  return r ? toUser(r) : undefined;
}

export const toUser = (r: Record<string, any>): User => ({ id: r.id, username: r.username, role: r.role, adultAt: r.adult_at ?? undefined });

function userByApiToken(token: string): User | undefined {
  const row = db
    .prepare('SELECT u.id, u.username, u.role, u.adult_at, t.id AS tid FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?')
    .get(sha256(token)) as Record<string, any> | undefined;
  if (!row) return;
  db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.tid);
  return toUser(row);
}

/** Works for HTTP requests and Socket.IO handshakes alike. */
export function authenticateInput(input: AuthInput): User | undefined {
  const auth = input.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer dm_')) return userByApiToken(auth.slice(7).trim());
  if (config.authMode === 'header') return userFromHeaders(input.headers, input.ip);
  const cookie = input.cookies[SESSION_COOKIE];
  return cookie ? userBySession(cookie) : undefined;
}

export const authenticate = (req: FastifyRequest) => authenticateInput({ headers: req.headers, ip: req.ip, cookies: req.cookies });

/** Logged in AND answered the 18+ question. Every game route uses this. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  req.user = authenticate(req);
  if (!req.user) return reply.code(401).send({ error: 'Not logged in' });
  if (!req.user.adultAt) return reply.code(451).send({ error: 'Confirm that you are 18 or older first' });
  db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(req.user.id);
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  await requireUser(req, reply);
  if (reply.sent) return;
  if (req.user!.role !== 'admin') return reply.code(403).send({ error: 'Admins only' });
}

export const registrationOpen = () => (getSetting('registration') ?? 'open') === 'open';

export function prefsOf(userId: string): Record<string, unknown> {
  const r = db.prepare('SELECT prefs FROM users WHERE id = ?').get(userId) as { prefs: string } | undefined;
  return json(r?.prefs, {});
}

export function authRoutes(app: FastifyInstance) {
  /** What the login page needs to know before anyone is logged in. */
  app.get('/api/auth/config', async () => ({
    mode: config.authMode,
    needsSetup: config.authMode === 'builtin' && userCount() === 0,
    registration: registrationOpen(),
  }));

  app.get('/api/auth/me', async (req, reply): Promise<Me | void> => {
    const user = authenticate(req);
    if (!user) return reply.code(401).send({ error: 'Not logged in' });
    return { id: user.id, username: user.username, role: user.role, adult: !!user.adultAt, authMode: config.authMode, logoutUrl: config.headerLogoutUrl || undefined, prefs: prefsOf(user.id) };
  });

  /** The 18+ gate: asked once, at registration (builtin) or at the first visit (header mode). */
  app.post('/api/auth/adult', async (req, reply) => {
    const user = authenticate(req);
    if (!user) return reply.code(401).send({ error: 'Not logged in' });
    if ((req.body as { confirm?: boolean } | undefined)?.confirm !== true) return reply.code(400).send({ error: 'DungeonMind is for adults (18+) only' });
    db.prepare("UPDATE users SET adult_at = datetime('now') WHERE id = ? AND adult_at IS NULL").run(user.id);
    return { ok: true };
  });

  app.put('/api/me/prefs', async (req, reply) => {
    const user = authenticate(req);
    if (!user) return reply.code(401).send({ error: 'Not logged in' });
    const patch = (req.body ?? {}) as Record<string, unknown>;
    if (JSON.stringify(patch).length > 20_000) return reply.code(413).send({ error: 'Too big' });
    const next = { ...prefsOf(user.id), ...patch };
    db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(next), user.id);
    return next;
  });

  // ---- Admin: users and registration ----
  app.get('/api/admin/users', { preHandler: requireAdmin }, async () =>
    (db.prepare('SELECT id, username, email, role, created_at, last_seen_at FROM users ORDER BY created_at').all() as Record<string, any>[]).map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email ?? undefined,
      role: u.role,
      createdAt: u.created_at,
      lastSeenAt: u.last_seen_at ?? undefined,
    })),
  );

  app.put('/api/admin/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { role } = (req.body ?? {}) as { role?: string };
    if (role !== 'admin' && role !== 'user') return reply.code(400).send({ error: 'Role is admin or user' });
    if (id === req.user!.id && role !== 'admin') return reply.code(400).send({ error: "You can't remove your own admin role" });
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    return { ok: true };
  });

  app.delete('/api/admin/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === req.user!.id) return reply.code(400).send({ error: "You can't delete yourself" });
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { ok: true };
  });

  app.put('/api/admin/registration', { preHandler: requireAdmin }, async (req) => {
    setSetting('registration', (req.body as { open?: boolean })?.open ? 'open' : 'closed');
    return { registration: registrationOpen() };
  });

  if (config.authMode === 'builtin') builtinRoutes(app);
}
