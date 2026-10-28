import { useEffect, useState } from 'react';
import type { PresenceUser } from '@dungeonmind/shared';
import { api } from '../api';
import { useMe } from '../me';
import { getSocket } from '../socket';

function where(w: string) {
  if (w === 'lobby') return 'in the lobby';
  if (w.startsWith('game:')) return 'at a table';
  return `in ${w}`;
}

export function Presence() {
  const me = useMe();
  const [list, setList] = useState<PresenceUser[]>([]);
  useEffect(() => {
    api<PresenceUser[]>('/api/presence', { quiet: true }).then(setList).catch(() => {});
    const s = getSocket();
    s.on('presence', setList);
    return () => void s.off('presence', setList);
  }, []);
  return (
    <section className="card">
      <h2 className="rune-title mb-2">Online now</h2>
      {list.length === 0 && <p className="text-sm text-slate-500">Nobody yet.</p>}
      <ul className="space-y-1.5">
        {list.map((u) => (
          <li key={u.id} className="flex items-center gap-2 text-sm">
            <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
            <span className={u.id === me.id ? 'text-indigo-200' : ''}>{u.username}</span>
            <span className="text-xs text-slate-500">{where(u.where)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Lobby() {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
      <div className="space-y-4">
        <section className="card">
          <h2 className="rune-title">Your games</h2>
          <div className="rune-rule my-2" />
          <p className="text-sm text-slate-400">No adventures yet.</p>
        </section>
      </div>
      <aside className="space-y-4">
        <Presence />
      </aside>
    </div>
  );
}
