import { newId } from '../crypto.js';
import { db, getSetting } from '../db.js';
import { toUser, type User } from './index.js';

type Headers = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

/** "a, b,,c" → ["a", "b", "c"]; undefined when the header is missing. */
const list = (v: string | string[] | undefined) => {
  const s = one(v);
  return s === undefined ? undefined : s.split(',').map((x) => x.trim().slice(0, 100)).filter(Boolean).slice(0, 50);
};

/** Settings → Users → Admin groups: portal groups whose members get the admin role. */
export const adminGroups = (): string[] => list(getSetting('admin_groups')) ?? [];

/** The portal's logout page (X-Auth-Logout), http(s) only. */
export const portalLogoutUrl = (headers: Headers) => {
  const url = one(headers['x-auth-logout']);
  return url && /^https?:\/\//i.test(url) ? url.slice(0, 500) : undefined;
};

/**
 * Portal mode: the auth portal (e.g. turkushan-auth behind Nginx Proxy Manager) has already logged the user in
 * and passes X-Auth-User / X-Auth-Email upstream, optionally X-Auth-Groups, X-Auth-Admin and X-Auth-Discord-Roles.
 */
export function userFromHeaders(headers: Headers): User | undefined {
  const raw = one(headers['x-auth-user']);
  if (!raw) return;
  const username = raw.replace(/[^a-zA-Z0-9_.@-]/g, '').slice(0, 64);
  if (!username) return;
  const email = one(headers['x-auth-email'])?.slice(0, 200);
  let row = db.prepare('SELECT id, username, role, adult_at, email, portal_groups, portal_admin, discord_roles FROM users WHERE username = ?').get(username) as
    | Record<string, any>
    | undefined;
  if (!row) {
    const id = newId();
    db.prepare("INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, 'user')").run(id, username, email ?? null);
    row = { id, username, role: 'user', email: email ?? null, portal_groups: null, portal_admin: null, discord_roles: null };
  } else if (email && row.email !== email) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, row.id);

  // Optional portal info: only what the portal sends is stored; without these headers nothing changes.
  const groups = list(headers['x-auth-groups']);
  const adminHeader = one(headers['x-auth-admin'])?.toLowerCase();
  const isAdmin = adminHeader === undefined ? undefined : adminHeader === 'true' || adminHeader === '1';
  const roles = list(headers['x-auth-discord-roles']);
  if (groups && JSON.stringify(groups) !== row.portal_groups) db.prepare('UPDATE users SET portal_groups = ? WHERE id = ?').run(JSON.stringify(groups), row.id);
  if (isAdmin !== undefined && Number(isAdmin) !== row.portal_admin) db.prepare('UPDATE users SET portal_admin = ? WHERE id = ?').run(Number(isAdmin), row.id);
  if (roles && JSON.stringify(roles) !== row.discord_roles) db.prepare('UPDATE users SET discord_roles = ? WHERE id = ?').run(JSON.stringify(roles), row.id);

  const wanted = adminGroups().map((g) => g.toLowerCase());
  if (row.role !== 'admin' && (isAdmin || groups?.some((g) => wanted.includes(g.toLowerCase())))) {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(row.id);
    row.role = 'admin';
  }
  return toUser(row);
}
