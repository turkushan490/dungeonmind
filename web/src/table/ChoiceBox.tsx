import { useState } from 'react';
import type { GameCharacter, GameDetail } from '@dungeonmind/shared';
import { api } from '../api';
import { useMe } from '../me';

/** 4 choices + Other for each of my characters; shows who we still wait for. */
export function ChoiceBox({ g }: { g: GameDetail }) {
  const me = useMe();
  const host = g.myRole === 'host';
  const active = g.characters.filter((c) => c.seated && !c.absent && (!g.state.combat || g.state.combat.order.some((o) => o.characterId === c.id)));
  const mine = active.filter((c) => c.userId === me.id || (host && c.absent));
  const waiting = active.filter((c) => !g.state.actions[c.id]);
  if (g.status !== 'playing' || g.state.phase !== 'collect') return null;
  return (
    <div className="space-y-2 border-t border-[#30363d] pt-2">
      {g.state.refused
        .filter((r) => mine.some((c) => c.id === r.characterId))
        .map((r) => (
          <p key={r.characterId} className="rounded-md border border-red-800 bg-red-950/40 px-2 py-1 text-sm text-red-200">
            ⛔ {g.characters.find((c) => c.id === r.characterId)?.name}: {r.reason} Pick again.
          </p>
        ))}
      {mine.map((c) => (
        <CharacterChoices key={c.id} g={g} c={c} />
      ))}
      {waiting.length > 0 && <p className="text-xs text-slate-500">Waiting for: {waiting.map((c) => c.name).join(', ')}</p>}
    </div>
  );
}

function CharacterChoices({ g, c }: { g: GameDetail; c: GameCharacter }) {
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const done = g.state.actions[c.id];
  const send = async (body: { choice?: number; text?: string }) => {
    setBusy(true);
    try {
      await api(`/api/games/${g.id}/actions`, { body: { characterId: c.id, ...body } });
      setOther('');
    } finally {
      setBusy(false);
    }
  };
  if (done)
    return (
      <div className="flex items-center gap-2 rounded-md border border-[#30363d] bg-[#0d1117] px-2 py-1.5 text-sm">
        <span className="text-emerald-400">✓</span>
        <span className="min-w-0 flex-1 truncate">
          <b>{c.name}:</b> {done.text}
        </span>
        <button className="text-xs text-slate-400 hover:underline" onClick={() => api(`/api/games/${g.id}/actions/${c.id}`, { method: 'DELETE' })}>
          change
        </button>
      </div>
    );
  const choices = g.state.choices[c.id] ?? [];
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-indigo-300">What does {c.name} do?</p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {choices.map((x, i) => (
          <button key={i} disabled={busy} className="dm-choice rounded-md border border-[#30363d] bg-[#0d1117] px-2 py-1.5 text-left text-sm hover:border-indigo-500 hover:bg-indigo-950/40" onClick={() => send({ choice: i })}>
            <span className="mr-1 text-indigo-400">{i + 1}.</span>
            {x}
          </button>
        ))}
      </div>
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (other.trim()) send({ text: other });
        }}
      >
        <input className="input" placeholder="Other: write your own action…" maxLength={600} value={other} onChange={(e) => setOther(e.target.value)} />
        <button className="btn" disabled={busy || !other.trim()}>
          Go
        </button>
      </form>
    </div>
  );
}

export function AskBox({ g }: { g: GameDetail }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  if (g.myRole !== 'host' && g.myRole !== 'player') return null;
  if (!open)
    return (
      <button className="text-xs text-indigo-300 hover:underline" onClick={() => setOpen(true)}>
        ☾ Ask the DM (rules, what you know) — never blocks the turn
      </button>
    );
  return (
    <form
      className="flex gap-1.5"
      onSubmit={async (e) => {
        e.preventDefault();
        await api(`/api/games/${g.id}/ask`, { body: { question: q } });
        setQ('');
        setOpen(false);
      }}
    >
      <input autoFocus className="input" placeholder="Can I grapple while holding a shield?" value={q} maxLength={800} onChange={(e) => setQ(e.target.value)} />
      <button className="btn-ghost" disabled={!q.trim()}>
        Ask
      </button>
    </form>
  );
}
