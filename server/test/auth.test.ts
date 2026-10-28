import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshApp, register } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => (app = await freshApp({ AUTH_MODE: 'login', ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'Dragon!1' })));
afterAll(() => app?.close());

const login = (username: string, password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
const me = (cookie: string) => app.inject({ url: '/api/auth/me', headers: { cookie } });
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => `dm_session=${res.cookies.find((c) => c.name === 'dm_session')!.value}`;

describe('login mode', () => {
  it('reports the mode, no first-account setup', async () => {
    const res = await app.inject({ url: '/api/auth/config' });
    expect(res.json()).toEqual({ mode: 'login', registration: true });
  });

  it('refuses registration without the 18+ confirmation', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'kid', password: 'Password!23' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/18/);
  });

  it('never makes the first account admin', async () => {
    const first = await register(app, 'turks');
    expect((await me(first)).json()).toMatchObject({ username: 'turks', role: 'user', adult: true, authMode: 'login' });
  });

  it('logs in with the right password only', async () => {
    expect((await login('turks', 'nope-nope')).statusCode).toBe(401);
    expect((await login('turks', 'Password!23')).statusCode).toBe(200);
  });

  it('sets the Secure flag only over HTTPS (X-Forwarded-Proto)', async () => {
    const plain = await login('turks', 'Password!23');
    expect(plain.cookies[0].secure).toBeFalsy();
    const https = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-proto': 'https' }, payload: { username: 'turks', password: 'Password!23' } });
    expect(https.cookies[0].secure).toBe(true);
  });
});

describe('ensureAdmin', () => {
  it('creates the Docker admin when missing', async () => {
    const { ensureAdmin } = await import('../src/auth/index.js');
    expect(await ensureAdmin(() => {})).toBe('created');
    const res = await login('boss', 'Dragon!1');
    expect(res.statusCode).toBe(200);
    expect((await me(cookieOf(res))).json()).toMatchObject({ username: 'boss', role: 'admin' });
  });

  it('on a later start makes an existing account admin and sets the password', async () => {
    const { ensureAdmin } = await import('../src/auth/index.js');
    const { config } = await import('../src/config.js');
    const { db } = await import('../src/db.js');
    db.prepare("UPDATE users SET role = 'user' WHERE username = 'boss'").run();
    config.adminPassword = 'Wyvern#2';
    expect(await ensureAdmin(() => {})).toBe('updated');
    expect((await login('boss', 'Dragon!1')).statusCode).toBe(401);
    const res = await login('boss', 'Wyvern#2');
    expect((await me(cookieOf(res))).json().role).toBe('admin');
    // An existing player named like ADMIN_USERNAME becomes that admin too.
    config.adminUsername = 'turks';
    expect(await ensureAdmin(() => {})).toBe('updated');
    expect((await me(cookieOf(await login('turks', 'Wyvern#2')))).json().role).toBe('admin');
    config.adminUsername = 'boss';
  });

  it('only warns about a weak admin password', async () => {
    const { ensureAdmin } = await import('../src/auth/index.js');
    const { config } = await import('../src/config.js');
    const warnings: string[] = [];
    config.adminPassword = 'weak';
    expect(await ensureAdmin((m) => warnings.push(m))).toBe('updated');
    expect(warnings[0]).toMatch(/capital/);
    expect((await login('boss', 'weak')).statusCode).toBe(200);
  });

  it('lets the admin close registration', async () => {
    const cookie = cookieOf(await login('boss', 'weak'));
    await app.inject({ method: 'POST', url: '/api/auth/adult', headers: { cookie }, payload: { confirm: true } });
    await app.inject({ method: 'PUT', url: '/api/admin/registration', headers: { cookie }, payload: { open: false } });
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'late', password: 'Password!23', adult: true } });
    expect(res.statusCode).toBe(403);
  });

  it('requires login for game routes', async () => {
    expect((await app.inject({ url: '/api/presence' })).statusCode).toBe(401);
  });
});

describe('password rule', () => {
  it('needs 5+ characters, a capital and a symbol', async () => {
    const { validCredentials } = await import('../src/auth/builtin.js');
    expect(validCredentials('turks', 'Abc!1')).toBeUndefined();
    expect(validCredentials('turks', 'abcde')).toMatch(/capital/);
    expect(validCredentials('turks', 'Abcde')).toMatch(/symbol/);
    expect(validCredentials('turks', 'Ab!1')).toMatch(/5 characters/);
  });
});

describe('auth mode names', () => {
  it('login / portal, with builtin / header as old aliases', async () => {
    const { parseAuthMode } = await import('../src/config.js');
    expect(parseAuthMode('login')).toBe('login');
    expect(parseAuthMode('builtin')).toBe('login');
    expect(parseAuthMode(undefined)).toBe('login');
    expect(parseAuthMode('portal')).toBe('portal');
    expect(parseAuthMode('header')).toBe('portal');
  });
});
