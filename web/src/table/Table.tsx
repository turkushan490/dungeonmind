import { useEffect, useRef, useState } from 'react';
import type { GameDetail } from '@dungeonmind/shared';
import { api } from '../api';
import { Sheet } from '../components/Sheet';
import { useMe } from '../me';
import { navigate } from '../router';
import { useGame } from '../useGame';
import { CampaignModal } from './CampaignModal';
import { AskBox, ChoiceBox } from './ChoiceBox';
import { StoryLog } from './StoryLog';
import { useLog } from './useLog';
import { tableExtras } from './extras';
import { NowPlayingBar, ReadSelection } from './Narration';
import { DiceOverlay } from './DiceOverlay';

const PHASE: Record<string, string> = {
  opening: 'The DM is setting the scene…',
  adjudicating: 'The DM weighs your actions…',
  rolling: 'Roll the dice!',
  narrating: 'The DM is telling what happens…',
  approval: 'Waiting for the host to approve a change…',
};

export function PhaseBanner({ g }: { g: GameDetail }) {
  if (g.status === 'paused') return <div className="bg-amber-900/60 px-3 py-1 text-center text-sm">The host paused the game.</div>;
  if (g.status === 'ended') return <div className="bg-slate-800 px-3 py-1 text-center text-sm">This game has ended. The story stays readable.</div>;
  if (g.state.phase === 'error')
    return (
      <div className="flex flex-wrap items-center justify-center gap-2 bg-red-950 px-3 py-1 text-center text-sm text-red-100">
        {g.state.error}
        {(g.myRole === 'host' || g.myRole === 'player') && (
          <button className="btn py-0.5" onClick={() => api(`/api/games/${g.id}/retry`, { method: 'POST' })}>
            Retry
          </button>
        )}
      </div>
    );
  const msg = PHASE[g.state.phase];
  if (!msg) return null;
  return (
    <div className="dm-breathe bg-indigo-950/70 px-3 py-1 text-center text-sm text-indigo-100">
      {g.state.queue ? `The DM is thinking… (#${g.state.queue} in queue)` : msg}
    </div>
  );
}

function SheetPane({ g }: { g: GameDetail }) {
  const me = useMe();
  const mineFirst = [...g.characters].sort((a, b) => Number(b.userId === me.id) - Number(a.userId === me.id));
  const [sel, setSel] = useState(mineFirst[0]?.id);
  const c = g.characters.find((x) => x.id === sel) ?? mineFirst[0];
  const Extra = tableExtras.sheet;
  if (!c) return <p className="text-sm text-slate-500">No characters yet.</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {mineFirst.map((x) => (
          <button key={x.id} onClick={() => setSel(x.id)} className={`rounded-md px-2 py-1 text-xs ${x.id === c.id ? 'bg-[#21262d] text-white' : 'text-slate-400 hover:text-white'}`}>
            {x.name}
            {x.absent && ' (away)'}
          </button>
        ))}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pr-1">
        <Sheet c={c} d={g.derived[c.id]}>
          {Extra && <Extra g={g} c={c} />}
        </Sheet>
        {(g.myRole === 'host' || c.userId === me.id) && g.status !== 'ended' && (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-[#30363d] pt-2">
            <button className="btn-ghost text-xs" onClick={() => api(`/api/games/${g.id}/characters/${c.id}/seat`, { method: 'PATCH', body: { absent: !c.absent } })}>
              {c.absent ? 'Back at the table' : g.myRole === 'host' && c.userId !== me.id ? 'Skip (player away)' : "I'm away"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function BoardPane({ g }: { g: GameDetail }) {
  const Board = tableExtras.board;
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      {g.state.sceneImage && <img src={g.state.sceneImage} alt="The scene" className="dm-pop w-full rounded-lg border border-[#30363d] object-cover" />}
      {Board ? (
        <Board g={g} />
      ) : (
        <ul className="space-y-1 text-sm">
          {g.state.npcs
            .filter((n) => n.status !== 'dead' && n.status !== 'fled')
            .map((n) => (
              <li key={n.name}>
                {n.name} {n.hp !== undefined && <span className="text-xs text-slate-400">{n.hp}/{n.maxHp} HP</span>}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

type Pane = 'sheet' | 'board' | 'story';
const PANES: [Pane, string][] = [
  ['sheet', 'Sheet'],
  ['board', 'Board'],
  ['story', 'Story'],
];

export function Table({ id }: { id: string }) {
  const { g } = useGame(id);
  const { log, streaming, loadOlder } = useLog(id);
  const [pane, setPane] = useState<Pane>('story');
  const [campaign, setCampaign] = useState(false);
  const touch = useRef<{ x: number; y: number } | undefined>(undefined);
  useEffect(() => {
    if (g && g.status === 'setup' && g.myRole !== 'spectator') navigate(`/games/${id}`);
  }, [g?.status]);
  if (g === null) return <p className="p-4 text-slate-400">This table doesn't exist, or it's private.</p>;
  if (!g) return null;
  const host = g.myRole === 'host';
  const Narr = tableExtras.narration;
  const Top = tableExtras.top;

  // Swipe between panes on phones.
  const onTouchStart = (e: React.TouchEvent) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY });
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touch.current) return;
    const dx = e.changedTouches[0].clientX - touch.current.x;
    const dy = e.changedTouches[0].clientY - touch.current.y;
    touch.current = undefined;
    if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx)) return;
    const i = PANES.findIndex(([p]) => p === pane);
    const next = PANES[Math.max(0, Math.min(PANES.length - 1, i + (dx < 0 ? 1 : -1)))][0];
    setPane(next);
  };

  return (
    <div className="flex h-[100dvh] flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-[#30363d] px-3 py-2">
        <button onClick={() => navigate('/')} title="Back to the lobby">
          <img src="/icon.svg" className="h-7 w-7" alt="Lobby" />
        </button>
        <h1 className="min-w-0 flex-1 truncate font-serif text-lg text-indigo-100">{g.name}</h1>
        {g.myRole === 'spectator' && <span className="chip">spectating</span>}
        {Top && <Top g={g} />}
        <button className="btn-ghost text-xs" onClick={() => setCampaign(true)}>
          Campaign
        </button>
        {host && g.status !== 'ended' && (
          <>
            <button className="btn-ghost text-xs" onClick={() => api(`/api/games/${g.id}/status`, { body: { status: g.status === 'paused' ? 'playing' : 'paused' } })}>
              {g.status === 'paused' ? 'Resume' : 'Pause'}
            </button>
            <button className="btn-danger text-xs" onClick={() => confirm('End this game for everyone? The story stays readable.') && api(`/api/games/${g.id}/status`, { body: { status: 'ended' } })}>
              End
            </button>
          </>
        )}
      </header>
      <PhaseBanner g={g} />
      <nav className="flex border-b border-[#30363d] lg:hidden">
        {PANES.map(([p, label]) => (
          <button key={p} onClick={() => setPane(p)} className={`flex-1 py-2 text-sm ${pane === p ? 'border-b-2 border-indigo-400 text-white' : 'text-slate-400'}`}>
            {label}
          </button>
        ))}
      </nav>
      <main className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[320px_1fr_minmax(360px,34%)]" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <section className={`card min-h-0 flex-col p-3 ${pane === 'sheet' ? 'flex' : 'hidden'} lg:flex`}>
          <SheetPane g={g} />
        </section>
        <section className={`card min-h-0 flex-col p-3 ${pane === 'board' ? 'flex' : 'hidden'} lg:flex`}>
          <BoardPane g={g} />
        </section>
        <section className={`card min-h-0 flex-col gap-2 p-3 ${pane === 'story' ? 'flex' : 'hidden'} lg:flex`}>
          <StoryLog log={log} streaming={streaming} onOlder={loadOlder} renderNarration={Narr ? (e, last) => <Narr g={g} e={e} last={last} /> : undefined} />
          {g.myRole !== 'spectator' && (
            <>
              <ChoiceBox g={g} />
              <AskBox g={g} />
            </>
          )}
        </section>
      </main>
      {campaign && <CampaignModal g={g} onClose={() => setCampaign(false)} />}
      <NowPlayingBar />
      <DiceOverlay gameId={g.id} />
      <ReadSelection />
    </div>
  );
}
