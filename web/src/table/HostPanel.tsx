import { useState } from 'react';
import type { GameCharacter, GameDetail } from '@dungeonmind/shared';
import { api } from '../api';
import { Modal } from '../components/Modal';
import { useMe } from '../me';

export function Approvals({ g }: { g: GameDetail }) {
  if (!g.state.approvals.length) return null;
  const host = g.myRole === 'host';
  return (
    <div className="rounded-md border border-amber-700 bg-amber-950/30 p-2">
      <h3 className="label text-amber-300">Waiting for the host</h3>
      <ul className="space-y-1 text-sm">
        {g.state.approvals.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2">
            <span className="flex-1">
              <b>{a.name}</b>: {a.reason} ({a.kind === 'delta' ? `${a.amount > 0 ? '+' : ''}${a.amount} HP` : `${a.amount} ${a.kind === 'xp' ? 'XP' : 'gp'}`})
            </span>
            {host && (
              <>
                <button className="btn py-0.5" onClick={() => api(`/api/games/${g.id}/approvals/${a.id}`, { body: { approve: true } })}>
                  Allow
                </button>
                <button className="btn-ghost py-0.5" onClick={() => api(`/api/games/${g.id}/approvals/${a.id}`, { body: { approve: false } })}>
                  Reject
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Host tools between turns: rests (with hit dice), milestones, moving on. */
export function HostTools({ g }: { g: GameDetail }) {
  const [shortRest, setShortRest] = useState(false);
  const [hd, setHd] = useState<Record<string, number>>({});
  if (g.myRole !== 'host' || g.status !== 'playing' || g.state.phase !== 'collect') return null;
  return (
    <div className="flex flex-wrap gap-1.5 border-t border-[#30363d] pt-2">
      <button className="btn-ghost text-xs" disabled={!!g.state.combat} onClick={() => setShortRest(true)}>
        Short rest
      </button>
      <button className="btn-ghost text-xs" disabled={!!g.state.combat} onClick={() => confirm('Take a long rest (8 hours)?') && api(`/api/games/${g.id}/rest`, { body: { kind: 'long' } })}>
        Long rest
      </button>
      {g.settings.xpMode === 'milestone' && (
        <button className="btn-ghost text-xs" onClick={() => confirm('Milestone: let everyone level up?') && api(`/api/games/${g.id}/milestone`, { method: 'POST' })}>
          Milestone level-up
        </button>
      )}
      <button className="btn-ghost text-xs" title="Don't wait for the remaining players this turn" onClick={() => api(`/api/games/${g.id}/continue`, { method: 'POST' })}>
        Move on
      </button>
      {shortRest && (
        <Modal title="Short rest (1 hour)" onClose={() => setShortRest(false)}>
          <p className="mb-2 text-sm text-slate-400">How many Hit Dice does each character spend? The server rolls them (+ CON each).</p>
          <ul className="space-y-1">
            {g.characters.map((c) => {
              const k = c.counters.find((x) => x.name.startsWith('Hit Dice'));
              return (
                <li key={c.id} className="flex items-center gap-2 text-sm">
                  <span className="flex-1">
                    {c.name} <span className="text-xs text-slate-500">{c.hp}/{c.maxHp} HP · {k?.current}/{k?.max} {k?.name}</span>
                  </span>
                  <input className="input w-16 py-1" type="number" min={0} max={k?.current ?? 0} value={hd[c.id] ?? 0} onChange={(e) => setHd({ ...hd, [c.id]: Number(e.target.value) })} />
                </li>
              );
            })}
          </ul>
          <button
            className="btn mt-3"
            onClick={async () => {
              await api(`/api/games/${g.id}/rest`, { body: { kind: 'short', hitDice: hd } });
              setShortRest(false);
            }}
          >
            Rest
          </button>
        </Modal>
      )}
    </div>
  );
}

export function RerollBar({ g }: { g: GameDetail }) {
  const me = useMe();
  const v = g.state.rerollVote;
  const player = g.myRole === 'host' || g.myRole === 'player';
  if (!player || g.status !== 'playing') return null;
  if (v)
    return (
      <span className="flex items-center gap-1 text-xs">
        <span className="text-amber-300">Reroll? ({v.by})</span>
        {v.votes[me.id] === undefined ? (
          <>
            <button className="btn py-0.5 text-xs" onClick={() => api(`/api/games/${g.id}/reroll/vote`, { body: { yes: true } })}>
              Yes
            </button>
            <button className="btn-ghost py-0.5 text-xs" onClick={() => api(`/api/games/${g.id}/reroll/vote`, { body: { yes: false } })}>
              No
            </button>
          </>
        ) : (
          <span className="text-slate-400">voted</span>
        )}
      </span>
    );
  return (
    <button
      className="btn-ghost text-xs"
      disabled={g.state.rerollsLeft <= 0 || g.state.turn < 2 || !['collect', 'approval'].includes(g.state.phase)}
      title="Ask the table to have the last narration told again (the dice stay as they fell)"
      onClick={() => api(`/api/games/${g.id}/reroll`, { method: 'POST' })}
    >
      ↻ Reroll ({g.state.rerollsLeft})
    </button>
  );
}

/** On the sheet: the level-up step, and the host's override. */
export function SheetActions({ g, c }: { g: GameDetail; c: GameCharacter }) {
  const me = useMe();
  const [level, setLevel] = useState(false);
  const [override, setOverride] = useState(false);
  return (
    <div className="flex flex-wrap gap-1.5">
      {c.levelUpPending && c.userId === me.id && (
        <button className="btn dm-levelup text-xs" onClick={() => setLevel(true)}>
          ★ Level up to {c.level + 1}
        </button>
      )}
      {g.myRole === 'host' && (
        <button className="btn-ghost text-xs" onClick={() => setOverride(true)}>
          Host override
        </button>
      )}
      {level && <LevelUp g={g} c={c} onClose={() => setLevel(false)} />}
      {override && <Override g={g} c={c} onClose={() => setOverride(false)} />}
    </div>
  );
}

function LevelUp({ g, c, onClose }: { g: GameDetail; c: GameCharacter; onClose: () => void }) {
  const [hp, setHp] = useState<'fixed' | 'roll' | 'manual'>('fixed');
  const [die, setDie] = useState('');
  const [subclass, setSubclass] = useState(c.subclass ?? '');
  const [spells, setSpells] = useState((c.spells ?? []).join(', '));
  const [cantrips, setCantrips] = useState((c.cantrips ?? []).join(', '));
  const [asi, setAsi] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const list = (s: string) => s.split(',').map((x) => x.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean);
  return (
    <Modal title={`${c.name}: level ${c.level + 1}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div>
          <span className="label">Hit points</span>
          <div className="flex flex-wrap gap-2">
            <label className="chip cursor-pointer">
              <input type="radio" checked={hp === 'fixed'} onChange={() => setHp('fixed')} /> Fixed ({c.hitDie / 2 + 1})
            </label>
            <label className="chip cursor-pointer">
              <input type="radio" checked={hp === 'roll'} onChange={() => setHp('roll')} /> 🎲 Server rolls d{c.hitDie}
            </label>
            <label className="chip cursor-pointer">
              <input type="radio" checked={hp === 'manual'} onChange={() => setHp('manual')} /> I roll myself
            </label>
            {hp === 'manual' && <input className="input w-20 py-1" placeholder={`d${c.hitDie}`} value={die} onChange={(e) => setDie(e.target.value.replace(/\D/g, ''))} />}
          </div>
          <p className="mt-1 text-xs text-slate-500">Plus your Constitution modifier.</p>
        </div>
        <label className="block">
          <span className="label">Subclass (if this level gives one)</span>
          <input className="input" value={subclass} onChange={(e) => setSubclass(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">Ability Score Improvement (e.g. "str 2" or "dex 1, con 1"), if this level has one</span>
          <input className="input" value={asi} onChange={(e) => setAsi(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">Cantrips</span>
          <input className="input" value={cantrips} onChange={(e) => setCantrips(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">Spells</span>
          <textarea className="input h-16" value={spells} onChange={(e) => setSpells(e.target.value)} />
        </label>
        {errors.length > 0 && (
          <ul className="text-amber-300">
            {errors.map((e) => (
              <li key={e}>• {e}</li>
            ))}
          </ul>
        )}
        <button
          className="btn"
          onClick={async () => {
            const extra: Record<string, number> = {};
            for (const m of asi.matchAll(/(str|dex|con|int|wis|cha)\s*\+?(\d)/gi)) extra[m[1].toLowerCase()] = Number(m[2]);
            const merged = { ...(c.asi ?? {}) } as Record<string, number>;
            for (const [k, v] of Object.entries(extra)) merged[k] = (merged[k] ?? 0) + v;
            try {
              await api(`/api/games/${g.id}/characters/${c.id}/level-up`, {
                body: { hp: hp === 'manual' ? Number(die) : hp, subclass: subclass || undefined, spells: list(spells), cantrips: list(cantrips), asi: merged },
                quiet: true,
              });
              onClose();
            } catch (err) {
              setErrors([(err as Error).message]);
            }
          }}
        >
          Level up
        </button>
      </div>
    </Modal>
  );
}

function Override({ g, c, onClose }: { g: GameDetail; c: GameCharacter; onClose: () => void }) {
  const [v, setV] = useState({ hp: c.hp, tempHp: c.tempHp, xp: c.xp, gold: c.gold, exhaustion: c.exhaustion });
  const [counters, setCounters] = useState(Object.fromEntries(c.counters.map((k) => [k.name, k.current])));
  const [conds, setConds] = useState(c.conditions.map((x) => x.name).join(', '));
  return (
    <Modal title={`Override: ${c.name}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
        {(Object.keys(v) as (keyof typeof v)[]).map((k) => (
          <label key={k}>
            <span className="label">{k}</span>
            <input className="input py-1" type="number" value={v[k]} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} />
          </label>
        ))}
      </div>
      <h3 className="label mt-3">Resources</h3>
      <div className="grid grid-cols-2 gap-2 text-sm">
        {c.counters.map((k) => (
          <label key={k.name} className="flex items-center gap-2">
            <span className="flex-1 truncate">{k.name}</span>
            <input className="input w-16 py-1" type="number" min={0} max={k.max} value={counters[k.name]} onChange={(e) => setCounters({ ...counters, [k.name]: Number(e.target.value) })} />
            <span className="text-xs text-slate-500">/{k.max}</span>
          </label>
        ))}
      </div>
      <label className="mt-3 block">
        <span className="label">Conditions (comma separated)</span>
        <input className="input" value={conds} onChange={(e) => setConds(e.target.value)} />
      </label>
      <button
        className="btn mt-3"
        onClick={async () => {
          await api(`/api/games/${g.id}/characters/${c.id}/override`, {
            method: 'PATCH',
            body: { ...v, counters, conditions: conds.split(',').map((x) => x.trim()).filter(Boolean).map((name) => ({ name })) },
          });
          onClose();
        }}
      >
        Save (logged for everyone)
      </button>
    </Modal>
  );
}
