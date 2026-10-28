import { io, type Socket } from 'socket.io-client';

let socket: Socket | undefined;

/** One shared connection per tab; it logs in with the session cookie (or the proxy headers). */
export function getSocket(): Socket {
  if (!socket) socket = io({ path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'] });
  return socket;
}

export function closeSocket() {
  socket?.close();
  socket = undefined;
}
