import { useEffect, useState } from 'react';
import { RULESET_NAMES, type GameSummary, type PresenceUser } from '@dungeonmind/shared';
import { api } from '../api';
import { useMe } from '../me';
import { toast } from '../notify';
import { navigate } from '../router';
import { getSocket } from '../socket';
import { TRAINING_DISCLAIMER } from './Login';

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

const STATUS: Record<string, string> = { setup: 'setting up', playing: 'playing', paused: 'paused', ended: 'ended' };

export function GameRow({ g, children }: { g: GameSummary; children?: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <button className="min-w-0 text-left" onClick={() => navigate(g.status === 'setup' ? `/games/${g.id}` : `/table/${g.id}`)}>
        <span className="block truncate font-serif text-base text-indigo-100 hover:underline">{g.name}</span>
        <span className="block text-xs text-slate-500">
          {RULESET_NAMES[g.ruleset]} · host {g.host} · {g.players} player{g.players === 1 ? '' : 's'} · {STATUS[g.status]}
          {g.visibility === 'private' && ' · private'}
        </span>
      </button>
      <span className="ml-auto flex gap-2">{children}</span>
    </li>
  );
}

function HiveMindWarning() {
  const me = useMe();
  const [h, setH] = useState<{ ok: boolean; missing: string[] }>();
  useEffect(() => {
    api('/api/hivemind/health', { quiet: true }).then(setH).catch(() => {});
  }, []);
  if (!h || (h.ok && !h.missing.length)) return null;
  return (
    <div className="rounded-md border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-200">
      The Dungeon Master can't think right now: {h.ok ? `HiveMind is missing ${h.missing.join(', ')}` : 'HiveMind is not reachable'}.{' '}
      {me.role === 'admin' ? (
        <button className="underline" onClick={() => navigate('/settings')}>
          Open Settings
        </button>
      ) : (
        'Tell your admin.'
      )}
    </div>
  );
}

export function Lobby() {
  const [games, setGames] = useState<{ mine: GameSummary[]; invites: GameSummary[]; spectate: GameSummary[] }>();
  const load = () => api('/api/games').then(setGames);
  useEffect(() => {
    load();
    const s = getSocket();
    const onInvite = (i: { name: string; from: string }) => {
      toast(`${i.from} invited you to “${i.name}”`, 'info');
      load();
    };
    s.on('invite', onInvite);
    s.on('games:changed', load);
    return () => {
      s.off('invite', onInvite);
      s.off('games:changed', load);
    };
  }, []);
  const me = useMe();

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
      <div className="space-y-4">
        <HiveMindWarning />
        {games && games.invites.length > 0 && (
          <section className="card border-indigo-600">
            <h2 className="rune-title">Invitations</h2>
            <ul className="divide-y divide-[#30363d]">
              {games.invites.map((g) => (
                <GameRow key={g.id} g={g}>
                  <button className="btn" onClick={() => api(`/api/games/${g.id}/accept`, { method: 'POST' }).then(() => navigate(`/games/${g.id}`))}>
                    Join
                  </button>
                  <button className="btn-ghost" onClick={() => api(`/api/games/${g.id}/members/${me.id}`, { method: 'DELETE' }).then(load)}>
                    Decline
                  </button>
                </GameRow>
              ))}
            </ul>
          </section>
        )}
        <section className="card">
          <div className="flex items-center gap-2">
            <h2 className="rune-title">Your games</h2>
            <button className="btn ml-auto" onClick={() => navigate('/adventures/new')}>
              New adventure
            </button>
          </div>
          <div className="rune-rule my-2" />
          {games?.mine.length === 0 && <p className="text-sm text-slate-400">No adventures yet. Start one, or wait for an invite.</p>}
          <ul className="divide-y divide-[#30363d]">
            {games?.mine.map((g) => (
              <GameRow key={g.id} g={g} />
            ))}
          </ul>
        </section>
        <section className="card">
          <h2 className="rune-title">Spectate</h2>
          <p className="text-xs text-slate-500">Running public games. Watch the story unfold (read only).</p>
          {games?.spectate.length === 0 && <p className="mt-2 text-sm text-slate-500">Nothing running right now.</p>}
          <ul className="divide-y divide-[#30363d]">
            {games?.spectate.map((g) => (
              <GameRow key={g.id} g={g}>
                <button className="btn-ghost" onClick={() => navigate(`/table/${g.id}`)}>
                  Watch
                </button>
              </GameRow>
            ))}
          </ul>
        </section>
      </div>
      <aside className="space-y-4">
        <Presence />
        <section className="card space-y-2">
          <h2 className="rune-title">New here?</h2>
          <p className="text-xs text-slate-400">A five-minute scripted adventure that shows the whole table. No AI needed.</p>
          <button className="btn w-full" onClick={async () => navigate(`/table/${(await api<{ id: string }>('/api/tutorial', { body: {} })).id}`)}>
            Play the tutorial
          </button>
          <button className="btn-ghost w-full" onClick={() => navigate('/guide')}>
            Read the guide
          </button>
        </section>
        <p className="px-1 text-xs text-slate-500">{TRAINING_DISCLAIMER} Hosts can switch it off per game.</p>
        <section className="card">
          <h2 className="rune-title mb-2">Characters</h2>
          <button className="btn-ghost w-full" onClick={() => navigate('/characters')}>
            Open your library
          </button>
        </section>
      </aside>
    </div>
  );
}
