import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { register } from './helpers.js';

let app: FastifyInstance;
let url: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dm-presence-'));
  process.env.AUTH_MODE = 'builtin';
  const { buildApp } = await import('../src/app.js');
  app = await buildApp({ logger: false, web: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  url = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  sockets.forEach((s) => s.close());
  await app?.close();
});

const open = (cookie?: string) =>
  new Promise<Socket>((ok, fail) => {
    const s = connect(url, { path: '/socket.io', transports: ['websocket'], extraHeaders: cookie ? { cookie } : {}, reconnection: false });
    sockets.push(s);
    s.on('connect', () => ok(s));
    s.on('connect_error', fail);
  });

describe('lobby presence', () => {
  it('refuses sockets without a login', async () => {
    await expect(open()).rejects.toThrow(/Not logged in/);
  });

  it('lists everyone online and where they are', async () => {
    const a = await register(app, 'alice');
    const b = await register(app, 'bobby');
    const sa = await open(a);
    const seen = new Promise<{ username: string; where: string }[]>((ok) =>
      sa.on('presence', (list: { username: string; where: string }[]) => list.some((u) => u.username === 'bobby' && u.where === 'characters') && ok(list)),
    );
    const sb = await open(b);
    sb.emit('where', 'characters');
    const list = await seen;
    expect(list.map((u) => u.username)).toEqual(['alice', 'bobby']);
    sb.close();
    await new Promise<void>((ok) => sa.on('presence', (l: unknown[]) => l.length === 1 && ok()));
  });
});
