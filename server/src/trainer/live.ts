import { emitToAdmins } from '../realtime.js';

/**
 * "Watch the AI" (M9 §4): what every AI types and thinks, relayed through Socket.IO to the admins' room.
 * Only content travels: the HiveMind token stays on the server. Each stream keeps a short backlog so a panel
 * opened mid-run catches up.
 */
export interface LiveEvent {
  stream: string;
  /** e.g. player, dm-token, dm-thinking, bookkeeper, judge, counters, loss, log, step, report-token, done. */
  type: string;
  text?: string;
  data?: unknown;
  at: number;
}

const backlog = new Map<string, LiveEvent[]>();
const KEEP = 2000;

export function live(stream: string, type: string, text?: string, data?: unknown) {
  const ev: LiveEvent = { stream, type, text, data, at: Date.now() };
  const list = backlog.get(stream) ?? [];
  list.push(ev);
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
  backlog.set(stream, list);
  if (backlog.size > 50) backlog.delete(backlog.keys().next().value!);
  emitToAdmins('trainer:live', ev);
}

export const liveBacklog = (stream: string) => backlog.get(stream) ?? [];
export const liveStreams = () => [...backlog.entries()].map(([stream, list]) => ({ stream, last: list.at(-1)?.at ?? 0, done: list.at(-1)?.type === 'done' }));
