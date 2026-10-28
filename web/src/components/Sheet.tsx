import { useEffect, useRef, useState } from 'react';
import { ABILITIES, SKILLS, type Character, type Counter, type Derived } from '@dungeonmind/shared';
import { signed, titleCase } from '../rules';

export function Pips({ c }: { c: Counter }) {
  if (c.max > 10)
    return (
      <span className="font-mono text-xs">
        {c.current}/{c.max}
      </span>
    );
  return (
    <span className="tracking-widest" aria-label={`${c.current} of ${c.max}`}>
      {Array.from({ length: c.max }, (_, i) => (
        <span key={i} className={`dm-pip ${i < c.current ? 'text-indigo-300' : 'text-slate-600 dm-pip-spent'}`}>
          {i < c.current ? '●' : '○'}
        </span>
      ))}
      <span className="ml-1 font-mono text-[10px] text-slate-500">
        {c.current}/{c.max}
      </span>
    </span>
  );
}

const RECHARGE: Record<string, string> = { short: 'short rest', long: 'long rest', dawn: 'dawn', turn: 'each turn', none: '' };

/** "hit" when the value drops, "heal" when it rises (for a moment). */
function useChange(value: number): '' | 'hit' | 'heal' {
  const prev = useRef(value);
  const [fx, setFx] = useState<'' | 'hit' | 'heal'>('');
  useEffect(() => {
    if (value === prev.current) return;
    setFx(value < prev.current ? 'hit' : 'heal');
    prev.current = value;
    const t = setTimeout(() => setFx(''), 900);
    return () => clearTimeout(t);
  }, [value]);
  return fx;
}

export function HpBar({ hp, max, temp = 0 }: { hp: number; max: number; temp?: number }) {
  const fx = useChange(hp);
  const pct = Math.max(0, Math.min(100, (hp / Math.max(1, max)) * 100));
  const color = pct > 50 ? 'bg-emerald-500' : pct > 25 ? 'bg-amber-500' : 'bg-red-600';
  return (
    <div className={fx === 'hit' ? 'dm-hp-hit' : fx === 'heal' ? 'dm-hp-heal' : ''}>
      <div className="flex items-baseline justify-between text-sm">
        <span className="label mb-0">Hit points</span>
        <span className="font-mono">
          <span className="dm-hp-value text-lg font-semibold">{hp}</span>/{max}
          {temp > 0 && <span className="ml-1 text-sky-300">+{temp} temp</span>}
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded bg-[#0d1117]">
        <div className={`dm-hp-bar h-full ${color} transition-all duration-700`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** The character sheet: used in the library and at the table (left pane). */
export function Sheet({ c, d, compact, children }: { c: Character; d: Derived; compact?: boolean; children?: React.ReactNode }) {
  const lvl = useChange(c.level);
  return (
    <div className="relative space-y-3 text-sm">
      {lvl === 'heal' && <div className="dm-levelup-burst" aria-hidden />}
      <div className="flex gap-3">
        {c.portrait ? (
          <img src={c.portrait} alt="" className="h-20 w-16 shrink-0 rounded-md border border-[#30363d] object-cover" />
        ) : (
          <div className="flex h-20 w-16 shrink-0 items-center justify-center rounded-md border border-[#30363d] bg-[#0d1117] font-serif text-2xl text-indigo-300">{c.name[0]}</div>
        )}
        <div className="min-w-0">
          <h3 className="truncate font-serif text-lg font-semibold text-indigo-100">{c.name}</h3>
          <p className="text-xs text-slate-400">
            {titleCase(c.subspecies ?? c.species)} {titleCase(c.class)} {c.level}
            {c.subclass && ` · ${titleCase(c.subclass)}`}
          </p>
          <p className="text-xs text-slate-500">
            {titleCase(c.background)} · {c.xp} XP{d.nextLevelXp ? ` / ${d.nextLevelXp}` : ''}
          </p>
          {c.levelUpPending && <span className="chip mt-1 border-amber-600 text-amber-300">Level up ready</span>}
        </div>
      </div>
      <HpBar hp={c.hp} max={c.maxHp} temp={c.tempHp} />
      <div className="grid grid-cols-5 gap-1 text-center">
        {(
          [
            ['AC', d.ac],
            ['Init', signed(d.initiative)],
            ['Speed', d.speed],
            ['Prof', signed(d.profBonus)],
            ['Pass.', d.passivePerception],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="rounded-md border border-[#30363d] bg-[#0d1117] py-1">
            <div className="text-[10px] uppercase text-slate-500">{k}</div>
            <div className="font-semibold">{v}</div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-6 gap-1 text-center">
        {ABILITIES.map((a) => (
          <div key={a} className={`rounded-md border bg-[#0d1117] py-1 ${c.saves.includes(a) ? 'border-indigo-700' : 'border-[#30363d]'}`} title={`Save ${signed(d.saveBonus[a])}`}>
            <div className="text-[10px] uppercase text-slate-500">{a}</div>
            <div className="font-semibold">{signed(d.mods[a])}</div>
            <div className="text-[10px] text-slate-500">{c.abilities[a]}</div>
          </div>
        ))}
      </div>
      {d.spellDc && (
        <p className="text-xs text-slate-400">
          Spell save DC <b className="text-slate-200">{d.spellDc}</b> · spell attack <b className="text-slate-200">{signed(d.spellAttack!)}</b>
        </p>
      )}
      {c.counters.length > 0 && (
        <div>
          <h4 className="label">Resources</h4>
          <ul className="space-y-0.5">
            {c.counters.map((k) => (
              <li key={k.name} className="dm-counter flex items-center justify-between gap-2" data-name={k.name}>
                <span className="truncate" title={RECHARGE[k.recharge] ? `Recharges on a ${RECHARGE[k.recharge]}` : undefined}>
                  {k.name}
                </span>
                <Pips c={k} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {(c.conditions.length > 0 || c.concentration || c.exhaustion > 0) && (
        <div className="flex flex-wrap gap-1">
          {c.concentration && <span className="chip border-violet-700 text-violet-300">Concentrating: {c.concentration}</span>}
          {c.exhaustion > 0 && <span className="chip border-amber-700 text-amber-300">Exhaustion {c.exhaustion}</span>}
          {c.conditions.map((x) => (
            <span key={x.name} className="chip border-red-800 text-red-300">
              {titleCase(x.name)}
              {x.rounds !== undefined && ` (${x.rounds})`}
            </span>
          ))}
        </div>
      )}
      {children}
      {!compact && (
        <>
          <div>
            <h4 className="label">Skills</h4>
            <ul className="grid grid-cols-2 gap-x-3 text-xs">
              {Object.keys(SKILLS).map((s) => (
                <li key={s} className={`flex justify-between ${c.skills.includes(s) ? 'text-slate-100' : 'text-slate-500'}`}>
                  <span>
                    {c.skills.includes(s) ? '◆ ' : '◇ '}
                    {titleCase(s)}
                  </span>
                  <span>{signed(d.skillBonus[s])}</span>
                </li>
              ))}
            </ul>
          </div>
          {(c.cantrips?.length || c.spells?.length) && (
            <div>
              <h4 className="label">Spells</h4>
              <p className="text-xs text-slate-300">
                {[...(c.cantrips ?? []).map((s) => `${titleCase(s)} (cantrip)`), ...(c.spells ?? []).map(titleCase)].join(', ')}
              </p>
            </div>
          )}
        </>
      )}
      <div>
        <h4 className="label">Inventory · {c.gold} gp</h4>
        <ul className="text-xs text-slate-300">
          {c.inventory.map((i) => (
            <li key={i.name}>
              {i.equipped ? '⚔ ' : '· '}
              {i.qty > 1 ? `${i.qty}× ` : ''}
              {i.name}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
