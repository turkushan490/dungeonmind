import { useEffect, useState } from 'react';
import type { GameDetail } from '@dungeonmind/shared';
import { api } from './api';
import { getSocket } from './socket';

/** Loads a game and keeps it live over Socket.IO (game:update). */
export function useGame(id: string) {
  const [g, setG] = useState<GameDetail | null>();
  const reload = () =>
    api<GameDetail>(`/api/games/${id}`, { quiet: true })
      .then(setG)
      .catch(() => setG(null));
  useEffect(() => {
    reload();
    const s = getSocket();
    const join = () => s.emit('game:join', id);
    join();
    s.on('connect', join);
    const onUpdate = (u: Partial<GameDetail> & { id: string }) => u.id === id && setG((g) => (g ? { ...g, ...u } : g));
    s.on('game:update', onUpdate);
    return () => {
      s.emit('game:leave', id);
      s.off('connect', join);
      s.off('game:update', onUpdate);
    };
  }, [id]);
  return { g, setG, reload };
}
