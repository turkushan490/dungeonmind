import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await freshApp({ AUTH_MODE: 'header', ADMIN_USERNAME: 'dmadmin', ADMIN_PASSWORD: 'Secret!9' });
  await (await import('../src/auth/index.js')).ensureAdmin(() => {});
});
afterAll(() => app?.close());

const as = (user: string, extra: Record<string, string> = {}) => ({ 'x-auth-user': user, 'x-auth-email': `${user}@example.com`, ...extra });
const me = (headers: Record<string, string>) => app.inject({ url: '/api/auth/me', headers });

describe('portal mode', () => {
  it('treats the old name "header" as portal', async () => {
    expect((await app.inject({ url: '/api/auth/config' })).json().mode).toBe('portal');
  });

  it('creates the user from X-Auth-User as a plain user, also the first one', async () => {
    expect((await me(as('turkushan'))).json()).toMatchObject({ username: 'turkushan', role: 'user', adult: false, authMode: 'portal' });
  });

  it('blocks game routes until the 18+ question is answered', async () => {
    expect((await app.inject({ url: '/api/presence', headers: as('turkushan') })).statusCode).toBe(451);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/adult', headers: as('turkushan'), payload: { confirm: true } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/presence', headers: as('turkushan') })).statusCode).toBe(200);
  });

  it('has no login or register without the header', async () => {
    expect((await app.inject({ url: '/api/auth/me' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/auth/register', method: 'POST', payload: {} })).statusCode).toBe(404);
  });

  it('passes the portal logout URL from X-Auth-Logout', async () => {
    expect((await me(as('turkushan', { 'x-auth-logout': 'https://auth.example.com/logout' }))).json().logoutUrl).toBe('https://auth.example.com/logout');
    expect((await me(as('turkushan', { 'x-auth-logout': 'javascript:alert(1)' }))).json().logoutUrl).toBeUndefined();
    expect((await me(as('turkushan'))).json().logoutUrl).toBeUndefined();
  });
});

describe('admin login in portal mode', () => {
  let cookie: string;

  it('refuses anyone but the Docker admin', async () => {
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/admin-login', payload: { username: 'dmadmin', password: 'nope' } });
    expect(wrong.statusCode).toBe(401);
    const other = await app.inject({ method: 'POST', url: '/api/auth/admin-login', payload: { username: 'turkushan', password: 'Secret!9' } });
    expect(other.statusCode).toBe(401);
  });

  it('wins over the portal headers while the session exists', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/admin-login', headers: as('turkushan'), payload: { username: 'dmadmin', password: 'Secret!9' } });
    expect(res.statusCode).toBe(200);
    cookie = `dm_session=${res.cookies.find((c) => c.name === 'dm_session')!.value}`;
    expect((await me({ ...as('turkushan'), cookie })).json()).toMatchObject({ username: 'dmadmin', role: 'admin', adminSession: true });
  });

  it('"Back to my account" drops the admin session and the portal account is back', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...as('turkushan'), cookie } });
    const back = (await me({ ...as('turkushan'), cookie })).json();
    expect(back).toMatchObject({ username: 'turkushan', role: 'user' });
    expect(back.adminSession).toBeUndefined();
  });
});

describe('portal groups and roles', () => {
  it('without the extra headers nothing changes', async () => {
    expect((await me(as('quiet'))).json().role).toBe('user');
  });

  it('X-Auth-Admin: true gives the admin role', async () => {
    expect((await me(as('chief', { 'x-auth-admin': 'false' }))).json().role).toBe('user');
    expect((await me(as('chief', { 'x-auth-admin': 'true' }))).json().role).toBe('admin');
  });

  it('a listed admin group gives the admin role, and Settings → Users shows the portal info', async () => {
    const admin = { ...as('chief') };
    await app.inject({ method: 'POST', url: '/api/auth/adult', headers: admin, payload: { confirm: true } });
    expect((await me(as('gm', { 'x-auth-groups': 'players, Game Masters', 'x-auth-discord-roles': 'DM,Veteran' }))).json().role).toBe('user');
    const put = await app.inject({ method: 'PUT', url: '/api/admin/admin-groups', headers: admin, payload: { groups: 'game masters, staff' } });
    expect(put.json().groups).toEqual(['game masters', 'staff']);
    expect((await me(as('gm', { 'x-auth-groups': 'players, Game Masters' }))).json().role).toBe('admin');
    // Not in a listed group: stays a user.
    expect((await me(as('newbie', { 'x-auth-groups': 'players' }))).json().role).toBe('user');

    const users = (await app.inject({ url: '/api/admin/users', headers: admin })).json() as Record<string, any>[];
    expect(users.find((u) => u.username === 'gm')).toMatchObject({ groups: ['players', 'Game Masters'], discordRoles: ['DM', 'Veteran'], role: 'admin' });
    expect(users.find((u) => u.username === 'chief')).toMatchObject({ portalAdmin: true });
    expect(users.find((u) => u.username === 'quiet')).not.toHaveProperty('groups');
  });
});
