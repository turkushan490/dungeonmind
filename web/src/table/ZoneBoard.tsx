import { useState } from 'react';
import type { GameDetail } from '@dungeonmind/shared';
import { useMe } from '../me';

function rangeBetween(g: GameDetail, a: string, b: string): number | undefined {
  const zoneOf = (n: string) => Object.entries(g.state.positions).find(([, l]) => l.includes(n))?.[0];
  const za = zoneOf(a);
  const zb = zoneOf(b);
  if (!za || !zb) return;
  if (za === zb) return 5;
  return g.state.zones.find((z) => z.name === za)?.distances[zb] ?? g.state.zones.find((z) => z.name === zb)?.distances[za];
}

/** Named zones with distances in feet; who stands where; ranges from your character. */
export function ZoneBoard({ g }: { g: GameDetail }) {
  const me = useMe();
  const mine = g.characters.find((c) => c.userId === me.id);
  const [from, setFrom] = useState(mine?.name);
  const pcs = new Set(g.characters.map((c) => c.name));
  const npc = (n: string) => g.state.npcs.find((x) => x.name === n);
  if (!g.state.zones.length) return <p className="text-sm text-slate-500">No zone board for this scene yet.</p>;
  const others = Object.values(g.state.positions).flat().filter((n) => n !== from);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {g.state.zones.map((z) => (
          <div key={z.name} className="dm-zone rounded-lg border border-[#30363d] bg-[#0d1117] p-2">
            <div className="font-serif text-sm text-indigo-200">{z.name}</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {(g.state.positions[z.name] ?? []).map((n) => {
                const x = npc(n);
                return (
                  <button key={n} onClick={() => pcs.has(n) && setFrom(n)} className={`chip ${pcs.has(n) ? 'border-indigo-600 text-indigo-100' : x?.status === 'hostile' ? 'border-red-800 text-red-200' : 'text-slate-300'}`}>
                    {n}
                    {x?.hp !== undefined && <span className="text-[10px] text-slate-400">{x.hp}/{x.maxHp}</span>}
                  </button>
                );
              })}
            </div>
            {Object.keys(z.distances).length > 0 && (
              <div className="mt-1 text-[10px] text-slate-500">
                {Object.entries(z.distances)
                  .map(([k, v]) => `${k} ${v} ft`)
                  .join(' · ')}
              </div>
            )}
          </div>
        ))}
      </div>
      {from && others.length > 0 && (
        <p className="text-xs text-slate-400">
          Range from <b className="text-slate-200">{from}</b>:{' '}
          {others
            .map((o) => {
              const r = rangeBetween(g, from, o);
              return `${o} ${r === undefined ? '?' : r === 5 ? 'melee' : `${r} ft`}`;
            })
            .join(' · ')}
        </p>
      )}
    </div>
  );
}

export function Initiative({ g }: { g: GameDetail }) {
  if (!g.state.combat) return null;
  return (
    <div>
      <h3 className="label">Initiative · round {g.state.combat.round}</h3>
      <ol className="flex flex-wrap gap-1">
        {g.state.combat.order.map((o) => {
          const n = g.state.npcs.find((x) => x.name === o.name);
          const c = g.characters.find((x) => x.id === o.characterId);
          return (
            <li key={o.name} className={`chip ${o.characterId ? 'border-indigo-600' : 'border-red-800'}`}>
              <b>{o.total}</b> {o.name}
              {c && <span className="text-[10px] text-slate-400">{c.hp}/{c.maxHp}</span>}
              {n?.hp !== undefined && <span className="text-[10px] text-slate-400">{n.hp}/{n.maxHp}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
