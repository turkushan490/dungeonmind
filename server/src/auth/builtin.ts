import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { hashPassword, newId, randomToken, sha256, verifyPassword } from '../crypto.js';
import { db } from '../db.js';
import { registrationOpen, toUser, TRAINING_REQUIRED, type User } from './index.js';

export const SESSION_COOKIE = 'dm_session';
const SESSION_DAYS = 30;

export function userBySession(token: string): User | undefined {
  const r = db
    .prepare('SELECT u.id, u.username, u.role, u.adult_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
    .get(sha256(token), Date.now()) as Record<string, any> | undefined;
  return r ? toUser(r) : undefined;
}

// In-memory brute-force guard: 10 failed logins per IP per 15 minutes.
const failures = new Map<string, { n: number; until: number }>();
const tooMany = (ip: string) => {
  const f = failures.get(ip);
  return !!f && f.until > Date.now() && f.n >= 10;
};
function noteFailure(ip: string) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) failures.set(ip, { n: 1, until: Date.now() + 15 * 60_000 });
  else f.n++;
}

export function validCredentials(username: unknown, password: unknown): string | undefined {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return 'Username: 3-32 letters, digits, _ . -';
  if (typeof password !== 'string' || password.length < 5 || !/[A-Z]/.test(password) || !/[^A-Za-z0-9]/.test(password))
    return 'Password: at least 5 characters, with 1 capital and 1 symbol';
}

/** HTTPS as the browser sees it (the proxy's X-Forwarded-Proto, trusted via trustProxy). */
const isHttps = (req: FastifyRequest) => req.protocol === 'https';

function startSession(req: FastifyRequest, reply: FastifyReply, userId: string) {
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, Date.now() + SESSION_DAYS * 86400_000);
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: isHttps(req), maxAge: SESSION_DAYS * 86400 });
}

async function checkPassword(req: FastifyRequest, reply: FastifyReply, username: string, password: unknown): Promise<string | undefined> {
  if (tooMany(req.ip)) {
    reply.code(429).send({ error: 'Too many attempts, try again later' });
    return;
  }
  const row = db.prepare('SELECT id, pw_hash FROM users WHERE username = ?').get(username) as { id: string; pw_hash: string | null } | undefined;
  if (!row?.pw_hash || !(await verifyPassword(String(password ?? ''), row.pw_hash))) {
    noteFailure(req.ip);
    reply.code(401).send({ error: 'Wrong username or password' });
    return;
  }
  return row.id;
}

/** Both modes: log out, and the admin login. In portal mode its session wins over the portal headers until it is dropped. */
export function sessionRoutes(app: FastifyInstance) {
  app.post('/api/auth/admin-login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    if (!config.adminUsername) return reply.code(404).send({ error: 'No admin account set up (ADMIN_USERNAME / ADMIN_PASSWORD in Docker)' });
    if (String(username ?? '').toLowerCase() !== config.adminUsername.toLowerCase()) {
      noteFailure(req.ip);
      return reply.code(401).send({ error: 'Wrong username or password' });
    }
    const id = await checkPassword(req, reply, config.adminUsername, password);
    if (!id) return;
    startSession(req, reply, id);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}

export function builtinRoutes(app: FastifyInstance) {
  /** Registration; the 18+ checkbox is part of the form. Admins come from Docker (ADMIN_USERNAME) or Settings → Users. */
  app.post('/api/auth/register', async (req, reply) => {
    const { username, password, adult, training } = (req.body ?? {}) as Record<string, unknown>;
    if (!registrationOpen()) return reply.code(403).send({ error: 'Registration is closed. Ask the admin for an account.' });
    const bad = validCredentials(username, password);
    if (bad) return reply.code(400).send({ error: bad });
    if (adult !== true) return reply.code(400).send({ error: 'DungeonMind is for adults (18+) only' });
    if (training !== true) return reply.code(400).send({ error: TRAINING_REQUIRED });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username as string)) return reply.code(409).send({ error: 'That name is taken' });
    const id = newId();
    db.prepare("INSERT INTO users (id, username, pw_hash, role, adult_at, training_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))").run(
      id,
      username as string,
      await hashPassword(password as string),
      'user',
    );
    startSession(req, reply, id);
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    const id = await checkPassword(req, reply, String(username ?? ''), password);
    if (!id) return;
    startSession(req, reply, id);
    return { ok: true };
  });

  app.post('/api/auth/password', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? userBySession(token) : undefined;
    if (!user) return reply.code(401).send({ error: 'Not logged in' });
    const { current, next } = (req.body ?? {}) as Record<string, string>;
    const row = db.prepare('SELECT pw_hash FROM users WHERE id = ?').get(user.id) as { pw_hash: string };
    if (!(await verifyPassword(String(current ?? ''), row.pw_hash))) return reply.code(401).send({ error: 'Current password is wrong' });
    const bad = validCredentials(user.username, next);
    if (bad) return reply.code(400).send({ error: bad });
    db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(await hashPassword(next), user.id);
    return { ok: true };
  });
}
