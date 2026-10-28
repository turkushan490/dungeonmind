import { useState } from 'react';
import type { GameDetail, PendingRoll } from '@dungeonmind/shared';
import { api } from '../api';
import { useMe } from '../me';

/** How many physical dice a roll needs: "2d6+1d4" → [6,6,4]; d20 tests with advantage need two d20s. */
export function diceNeeded(r: PendingRoll): number[] {
  if (r.kind !== 'damage' && r.kind !== 'heal' && r.kind !== 'hitdie') return r.adv && r.adv !== 'none' ? [20, 20] : [20];
  const out: number[] = [];
  for (const m of r.dice.matchAll(/(\d*)d(\d+)/g)) for (let i = 0; i < (Number(m[1]) || 1) * (r.crit ? 2 : 1); i++) out.push(Number(m[2]));
  return out;
}

const parentOf = (r: PendingRoll, all: PendingRoll[]) => all.find((x) => x.id === (r.onHit ?? r.onFail));
const canRoll = (r: PendingRoll, all: PendingRoll[]) => !r.result && (!parentOf(r, all) || !!parentOf(r, all)!.result);

function RollRow({ g, r }: { g: GameDetail; r: PendingRoll }) {
  const me = useMe();
  const [manual, setManual] = useState(false);
  const [vals, setVals] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const owner = g.characters.find((c) => c.id === r.characterId);
  const mine = owner && (owner.userId === me.id || g.myRole === 'host');
  const need = diceNeeded(r);
  const send = async (body: object) => {
    setBusy(true);
    try {
      await api(`/api/games/${g.id}/rolls/${r.id}`, { body });
    } finally {
      setBusy(false);
    }
  };
  const ready = canRoll(r, g.state.rolls);
  return (
    <li className={`rounded-md border px-2 py-1.5 text-sm ${r.result ? 'border-[#30363d] opacity-80' : ready && mine ? 'border-indigo-500 bg-indigo-950/30' : 'border-[#30363d]'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">
          {r.label}
          {r.kind !== 'damage' && r.kind !== 'heal' && (
            <span className="ml-1 text-xs text-slate-400">
              d20 {r.bonus >= 0 ? '+' : '−'}
              {Math.abs(r.bonus)}
              {r.adv && r.adv !== 'none' && ` · ${r.adv === 'adv' ? 'advantage' : 'disadvantage'}`}
              {r.targetAc !== undefined && ` vs AC ${r.targetAc}`}
              {r.dc !== undefined && ` vs DC ${r.dc}`}
            </span>
          )}
          {(r.kind === 'damage' || r.kind === 'heal') && <span className="ml-1 font-mono text-xs text-slate-400">{r.dice}{r.crit && ' ×2 dice (crit)'}</span>}
        </span>
        {r.result ? (
          <span className={`dm-roll-result font-mono font-semibold ${r.result.skipped ? 'text-slate-500' : r.result.success === false ? 'text-red-300' : 'text-emerald-300'}`} data-total={r.result.total}>
            {r.result.skipped ? '—' : r.result.total}
            {r.result.manual && <span title="Rolled by the player" className="ml-1 text-xs">✋</span>}
          </span>
        ) : !ready ? (
          <span className="text-xs text-slate-500">waits</span>
        ) : mine ? (
          <span className="flex gap-1">
            <button className="btn py-1" disabled={busy} onClick={() => send({ mode: 'server' })}>
              🎲 Roll
            </button>
            <button className="btn-ghost py-1" disabled={busy} onClick={() => setManual(!manual)} title="Roll your own physical dice and enter the values">
              I roll myself
            </button>
          </span>
        ) : (
          <span className="text-xs text-slate-500">{owner ? `${owner.name} rolls` : 'the DM rolls'}</span>
        )}
      </div>
      {manual && !r.result && (
        <form
          className="mt-1.5 flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            send({ mode: 'manual', values: vals.map(Number) });
          }}
        >
          {need.map((s, i) => (
            <input
              key={i}
              className="input w-16 py-1 text-center"
              inputMode="numeric"
              placeholder={`d${s}`}
              value={vals[i] ?? ''}
              onChange={(e) => {
                const v = [...vals];
                v[i] = e.target.value.replace(/\D/g, '');
                setVals(v);
              }}
            />
          ))}
          <button className="btn py-1" disabled={busy || vals.filter(Boolean).length !== need.length}>
            Use these
          </button>
          <span className="text-xs text-slate-500">The server checks each value and marks the roll as yours.</span>
        </form>
      )}
    </li>
  );
}

export function DiceTray({ g }: { g: GameDetail }) {
  if (!g.state.rolls.length) return null;
  return (
    <div>
      <h3 className="label">Dice {g.state.phase === 'rolling' && <span className="dm-breathe normal-case text-indigo-300">· waiting for rolls</span>}</h3>
      <ul className="space-y-1.5">
        {g.state.rolls.map((r) => (
          <RollRow key={r.id} g={g} r={r} />
        ))}
      </ul>
    </div>
  );
}
