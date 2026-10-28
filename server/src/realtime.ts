import type { FastifyInstance } from 'fastify';
import { Server, type Socket } from 'socket.io';
import type { PresenceUser } from '@dungeonmind/shared';
import { authenticateInput, type User } from './auth/index.js';

let io: Server | undefined;

/** Who is online and where: one entry per user, counting their open tabs. */
const online = new Map<string, { user: User; sockets: Set<string>; where: string }>();

export function presenceList(): PresenceUser[] {
  return [...online.values()].map((p) => ({ id: p.user.id, username: p.user.username, where: p.where })).sort((a, b) => a.username.localeCompare(b.username));
}

const broadcastPresence = () => io?.to('lobby').emit('presence', presenceList());

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

type JoinHandler = (socket: Socket, user: User, gameId: string) => boolean;
let canJoinGame: JoinHandler = () => false;
/** Game code decides who may watch a table (players, invitees, spectators of public games). */
export const onGameJoin = (fn: JoinHandler) => (canJoinGame = fn);

type MessageHandler = (user: User, event: string, payload: unknown, ack?: (res: unknown) => void) => void;
const handlers = new Map<string, MessageHandler>();
/** Register a client → server socket event (e.g. reroll votes); HTTP stays the main write path. */
export const onSocket = (event: string, fn: MessageHandler) => handlers.set(event, fn);

export function attachRealtime(app: FastifyInstance) {
  io = new Server(app.server, { path: '/socket.io', serveClient: false, cors: { origin: false } });
  io.use((socket, next) => {
    const req = socket.request;
    const user = authenticateInput({ headers: req.headers, cookies: parseCookies(req.headers.cookie) });
    if (!user) return next(new Error('Not logged in'));
    if (!user.adultAt) return next(new Error('Confirm that you are 18 or older first'));
    socket.data.user = user;
    next();
  });
  io.on('connection', (socket) => {
    const user = socket.data.user as User;
    socket.join('lobby');
    socket.join(`user:${user.id}`);
    const entry = online.get(user.id) ?? { user, sockets: new Set(), where: 'lobby' };
    entry.sockets.add(socket.id);
    online.set(user.id, entry);
    broadcastPresence();

    socket.on('where', (where: unknown) => {
      if (typeof where !== 'string' || where.length > 80) return;
      entry.where = where;
      broadcastPresence();
    });
    socket.on('game:join', (gameId: unknown, ack?: (ok: boolean) => void) => {
      if (typeof gameId !== 'string') return ack?.(false);
      const ok = canJoinGame(socket, user, gameId);
      if (ok) socket.join(`game:${gameId}`);
      ack?.(ok);
    });
    socket.on('game:leave', (gameId: unknown) => typeof gameId === 'string' && socket.leave(`game:${gameId}`));
    for (const [event, fn] of handlers) socket.on(event, (payload: unknown, ack?: (res: unknown) => void) => fn(user, event, payload, ack));
    socket.on('disconnect', () => {
      entry.sockets.delete(socket.id);
      if (!entry.sockets.size) online.delete(user.id);
      broadcastPresence();
    });
  });
  app.addHook('onClose', async () => {
    await io?.close();
    io = undefined;
    online.clear();
  });
  return io;
}

export const emitToGame = (gameId: string, event: string, payload: unknown) => io?.to(`game:${gameId}`).emit(event, payload);
export const emitToUser = (userId: string, event: string, payload: unknown) => io?.to(`user:${userId}`).emit(event, payload);
export const emitToLobby = (event: string, payload: unknown) => io?.to('lobby').emit(event, payload);
export const isOnline = (userId: string) => online.has(userId);
