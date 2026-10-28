import { getSetting } from '../db.js';

/**
 * DungeonMind's own queue in front of HiveMind: at most N tables think at once (admin setting),
 * so one busy GPU isn't flooded. Waiting tables see their place ("#2 in queue").
 */
const waiting: { gameId: string; start: () => void; onPosition?: (n: number) => void }[] = [];
let running = 0;

export const maxThinking = () => Math.max(1, Math.min(16, Number(getSetting('maxThinking') ?? 2)));

function pump() {
  waiting.forEach((w, i) => w.onPosition?.(i + 1));
  while (running < maxThinking() && waiting.length) {
    const next = waiting.shift()!;
    running++;
    next.start();
    waiting.forEach((w, i) => w.onPosition?.(i + 1));
  }
}

export async function think<T>(gameId: string, fn: () => Promise<T>, onPosition?: (n: number) => void): Promise<T> {
  await new Promise<void>((start) => {
    waiting.push({ gameId, start, onPosition });
    pump();
  });
  onPosition?.(0);
  try {
    return await fn();
  } finally {
    running--;
    pump();
  }
}

export const queueLength = () => waiting.length;
