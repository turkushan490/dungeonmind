import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshApp, register } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => (app = await freshApp({ AUTH_MODE: 'builtin' })));
afterAll(() => app?.close());

describe('builtin auth', () => {
  it('reports setup needed before the first account', async () => {
    const res = await app.inject({ url: '/api/auth/config' });
    expect(res.json()).toMatchObject({ mode: 'builtin', needsSetup: true });
  });

  it('refuses registration without the 18+ confirmation', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'kid', password: 'password123' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/18/);
  });

  it('makes the first user admin and later users plain users', async () => {
    const admin = await register(app, 'turks');
    const me = await app.inject({ url: '/api/auth/me', headers: { cookie: admin } });
    expect(me.json()).toMatchObject({ username: 'turks', role: 'admin', adult: true });
    const user = await register(app, 'esva');
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: user } })).json().role).toBe('user');
  });

  it('logs in with the right password only', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'turks', password: 'nope-nope' } });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'turks', password: 'password123' } });
    expect(good.statusCode).toBe(200);
  });

  it('closes registration when the admin says so', async () => {
    const admin = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'turks', password: 'password123' } })).cookies[0];
    const cookie = `dm_session=${admin.value}`;
    await app.inject({ method: 'PUT', url: '/api/admin/registration', headers: { cookie }, payload: { open: false } });
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'late', password: 'password123', adult: true } });
    expect(res.statusCode).toBe(403);
  });

  it('requires login for game routes', async () => {
    expect((await app.inject({ url: '/api/presence' })).statusCode).toBe(401);
  });
});
