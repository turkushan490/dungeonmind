import { useEffect, useState } from 'react';
import { RULESET_NAMES, type Ruleset } from '@dungeonmind/shared';
import { api } from '../api';
import { Markdown } from '../components/Markdown';
import { navigate } from '../router';

interface Hit {
  kind: string;
  id: string;
  name: string;
  text: string;
}

const BROWSE: [string, string][] = [
  ['rules', 'Rules'],
  ['conditions', 'Conditions'],
  ['spells', 'Spells'],
  ['monsters', 'Monsters'],
  ['items', 'Items'],
  ['feats', 'Feats'],
];

/** Per-ruleset rules pages: search everything, or browse a list. */
export function RulesPage({ ruleset }: { ruleset: Ruleset }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [kind, setKind] = useState('rules');
  const [list, setList] = useState<{ id: string; name: string; desc?: string; level?: number; cr?: number; homebrew?: boolean }[]>([]);
  const [open, setOpen] = useState<string>();
  useEffect(() => {
    const t = setTimeout(() => (q.trim() ? api<Hit[]>(`/api/rules/${ruleset}/search?q=${encodeURIComponent(q)}&limit=20`).then(setHits) : setHits([])), 250);
    return () => clearTimeout(t);
  }, [q, ruleset]);
  useEffect(() => {
    api(`/api/rules/${ruleset}/${kind}`).then(setList);
  }, [kind, ruleset]);
  return (
    <div className="space-y-4">
      <section className="card space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="rune-title">Rules · {RULESET_NAMES[ruleset]}</h2>
          <button className="btn-ghost ml-auto text-xs" onClick={() => navigate(`/rules/${ruleset === 'srd51' ? 'srd52' : 'srd51'}`)}>
            Switch to {RULESET_NAMES[ruleset === 'srd51' ? 'srd52' : 'srd51']}
          </button>
        </div>
        <input className="input" placeholder="Search: grapple, fireball, prone, goblin…" value={q} onChange={(e) => setQ(e.target.value)} />
        {hits.length > 0 && (
          <ul className="space-y-2">
            {hits.map((h) => (
              <li key={`${h.kind}-${h.id}`} className="rounded-md border border-[#30363d] bg-[#0d1117] p-2">
                <Markdown text={h.text.length > 1500 ? `${h.text.slice(0, 1500)}…` : h.text} className="readable text-sm" />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card space-y-2">
        <div className="flex flex-wrap gap-1">
          {BROWSE.map(([k, label]) => (
            <button key={k} className={kind === k ? 'btn py-1' : 'btn-ghost py-1'} onClick={() => setKind(k)}>
              {label}
            </button>
          ))}
        </div>
        <ul className="divide-y divide-[#30363d] text-sm">
          {list.slice(0, 400).map((e) => (
            <li key={e.id} className="py-1.5">
              <button className="w-full text-left hover:text-white" onClick={() => setOpen(open === e.id ? undefined : e.id)}>
                {e.name}
                {e.level !== undefined && <span className="ml-2 text-xs text-slate-500">{e.level ? `level ${e.level}` : 'cantrip'}</span>}
                {e.cr !== undefined && <span className="ml-2 text-xs text-slate-500">CR {e.cr}</span>}
                {e.homebrew && <span className="chip ml-2">homebrew</span>}
              </button>
              {open === e.id && (
                <div className="readable mt-1 whitespace-pre-wrap rounded-md bg-[#0d1117] p-2 text-xs text-slate-300">{e.desc ?? JSON.stringify(e, null, 1)}</div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
