import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { hashPassword, newId, randomToken, sha256, verifyPassword } from '../crypto.js';
import { db } from '../db.js';
import { registrationOpen, toUser, userCount, type User } from './index.js';

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
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters';
}

function startSession(reply: FastifyReply, userId: string) {
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, Date.now() + SESSION_DAYS * 86400_000);
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: SESSION_DAYS * 86400 });
}

export function builtinRoutes(app: FastifyInstance) {
  /** Registration; the very first account becomes the admin. The 18+ checkbox is part of the form. */
  app.post('/api/auth/register', async (req, reply) => {
    const { username, password, adult } = (req.body ?? {}) as Record<string, unknown>;
    const first = userCount() === 0;
    if (!first && !registrationOpen()) return reply.code(403).send({ error: 'Registration is closed. Ask the admin for an account.' });
    const bad = validCredentials(username, password);
    if (bad) return reply.code(400).send({ error: bad });
    if (adult !== true) return reply.code(400).send({ error: 'DungeonMind is for adults (18+) only' });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username as string)) return reply.code(409).send({ error: 'That name is taken' });
    const id = newId();
    db.prepare("INSERT INTO users (id, username, pw_hash, role, adult_at) VALUES (?, ?, ?, ?, datetime('now'))").run(
      id,
      username as string,
      await hashPassword(password as string),
      first ? 'admin' : 'user',
    );
    startSession(reply, id);
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (tooMany(req.ip)) return reply.code(429).send({ error: 'Too many attempts, try again later' });
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    const row = db.prepare('SELECT id, pw_hash FROM users WHERE username = ?').get(String(username ?? '')) as { id: string; pw_hash: string | null } | undefined;
    if (!row?.pw_hash || !(await verifyPassword(String(password ?? ''), row.pw_hash))) {
      noteFailure(req.ip);
      return reply.code(401).send({ error: 'Wrong username or password' });
    }
    startSession(reply, row.id);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
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
