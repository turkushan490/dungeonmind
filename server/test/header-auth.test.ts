import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => (app = await freshApp({ AUTH_MODE: 'header', AUTH_HEADER_TRUSTED_IPS: '' })));
afterAll(() => app?.close());

const as = (user: string, email = `${user}@example.com`) => ({ 'x-auth-user': user, 'x-auth-email': email });

describe('header auth', () => {
  it('creates the user from X-Auth-User, first one admin', async () => {
    const me = await app.inject({ url: '/api/auth/me', headers: as('turkushan') });
    expect(me.json()).toMatchObject({ username: 'turkushan', role: 'admin', adult: false, authMode: 'header' });
  });

  it('blocks game routes until the 18+ question is answered', async () => {
    expect((await app.inject({ url: '/api/presence', headers: as('turkushan') })).statusCode).toBe(451);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/adult', headers: as('turkushan'), payload: { confirm: true } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/presence', headers: as('turkushan') })).statusCode).toBe(200);
  });

  it('has no login without the header', async () => {
    expect((await app.inject({ url: '/api/auth/me' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/auth/register', method: 'POST', payload: {} })).statusCode).toBe(404);
  });

  it('second header user is a plain user', async () => {
    expect((await app.inject({ url: '/api/auth/me', headers: as('friend') })).json().role).toBe('user');
  });
});
