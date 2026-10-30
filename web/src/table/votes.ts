import { useEffect, useState } from 'react';
import { api } from '../api';
import { getSocket } from '../socket';

/** 👍/👎 per narration log id, with my own vote (M9 training labels). One fetch per table, then live. */
type Votes = Record<number, { up: number; down: number; mine?: boolean }>;
const cache = new Map<string, Votes>();
const subs = new Map<string, Set<() => void>>();
const notify = (gameId: string) => subs.get(gameId)?.forEach((f) => f());

export function useVotes(gameId: string): [Votes, (logId: number, up: boolean | null) => Promise<void>] {
  const [, setN] = useState(0);
  useEffect(() => {
    const rerender = () => setN((n) => n + 1);
    const set = subs.get(gameId) ?? new Set();
    set.add(rerender);
    subs.set(gameId, set);
    if (!cache.has(gameId)) {
      cache.set(gameId, {});
      api<Votes>(`/api/games/${gameId}/votes`, { quiet: true })
        .then((v) => (cache.set(gameId, v), notify(gameId)))
        .catch(() => {});
      getSocket().on('game:votes', (m: { gameId: string; logId: number; up: number; down: number }) => {
        if (m.gameId !== gameId) return;
        const v = cache.get(gameId) ?? {};
        v[m.logId] = { ...v[m.logId], up: m.up, down: m.down };
        notify(gameId);
      });
    }
    return () => void set.delete(rerender);
  }, [gameId]);
  const vote = async (logId: number, up: boolean | null) => {
    const r = await api<{ up: number; down: number }>(`/api/games/${gameId}/log/${logId}/vote`, { body: { up } });
    const v = cache.get(gameId) ?? {};
    v[logId] = { ...r, mine: up ?? undefined };
    cache.set(gameId, v);
    notify(gameId);
  };
  return [cache.get(gameId) ?? {}, vote];
}
