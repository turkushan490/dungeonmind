import { newId } from '../crypto.js';
import { config } from '../config.js';
import { db } from '../db.js';
import { toUser, userCount, type User } from './index.js';

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

/** Strips IPv6-mapped IPv4 (::ffff:10.0.0.2 → 10.0.0.2). */
const plainIp = (ip: string) => ip.replace(/^::ffff:/, '');

/**
 * Forward-auth: the proxy (e.g. turkushan-auth behind Nginx Proxy Manager) has already logged the user in
 * and passes X-Auth-User / X-Auth-Email upstream. The first user seen becomes the admin.
 */
export function userFromHeaders(headers: Record<string, string | string[] | undefined>, ip: string): User | undefined {
  if (config.headerTrustedIps.length && !config.headerTrustedIps.includes(plainIp(ip))) return;
  const raw = one(headers['x-auth-user']);
  if (!raw) return;
  const username = raw.replace(/[^a-zA-Z0-9_.@-]/g, '').slice(0, 64);
  if (!username) return;
  const email = one(headers['x-auth-email'])?.slice(0, 200);
  const row = db.prepare('SELECT id, username, role, adult_at, email FROM users WHERE username = ?').get(username) as Record<string, any> | undefined;
  if (row) {
    if (email && row.email !== email) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, row.id);
    return toUser(row);
  }
  const id = newId();
  db.prepare('INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)').run(id, username, email ?? null, userCount() === 0 ? 'admin' : 'user');
  return toUser(db.prepare('SELECT id, username, role, adult_at FROM users WHERE id = ?').get(id) as Record<string, any>);
}
