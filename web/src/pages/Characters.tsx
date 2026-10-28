import { useEffect, useState } from 'react';
import { RULESET_NAMES, type Character, type CharacterBuild, type Derived, type Ruleset } from '@dungeonmind/shared';
import { api } from '../api';
import { Sheet } from '../components/Sheet';
import { navigate } from '../router';
import { titleCase } from '../rules';
import { Builder, emptyBuild } from './Builder';

interface Summary {
  id: string;
  name: string;
  ruleset: Ruleset;
  class: string;
  subclass?: string;
  species: string;
  level: number;
  portrait?: string;
}

const DRAFT = 'dm-builder-draft';

/** AI and import results open in the builder as a draft (they're not saved until you click Create). */
function openDraft(build: CharacterBuild, errors: string[]) {
  sessionStorage.setItem(DRAFT, JSON.stringify({ build, errors }));
  navigate('/characters/new?draft=1');
}

function AiForm() {
  const [ruleset, setRuleset] = useState<Ruleset>('srd51');
  const [level, setLevel] = useState(1);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <section className="card space-y-2">
      <h2 className="rune-title">AI builds the sheet</h2>
      <p className="text-xs text-slate-400">Describe who they are. The DM builds a legal sheet you can then change in the builder.</p>
      <div className="flex gap-2">
        <select className="input" value={ruleset} onChange={(e) => setRuleset(e.target.value as Ruleset)}>
          {Object.entries(RULESET_NAMES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <input className="input w-24" type="number" min={1} max={20} value={level} onChange={(e) => setLevel(Number(e.target.value) || 1)} title="Level" />
      </div>
      <textarea className="input h-24" placeholder="A disgraced temple guard who still hears her god whisper, handy with a mace…" value={text} onChange={(e) => setText(e.target.value)} />
      <button
        className="btn w-full"
        disabled={busy || !text.trim()}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await api<{ build: CharacterBuild; errors: string[] }>('/api/characters/ai', { body: { ruleset, level, description: text } });
            openDraft(r.build, r.errors);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <span className="dm-breathe">The DM is thinking…</span> : 'Build it'}
      </button>
    </section>
  );
}

function ImportForm() {
  const [ruleset, setRuleset] = useState<Ruleset>('srd51');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <section className="card space-y-2">
      <h2 className="rune-title">Import a sheet</h2>
      <p className="text-xs text-slate-400">Paste a DungeonMind export, any JSON sheet, or plain text (the AI reads text).</p>
      <select className="input" value={ruleset} onChange={(e) => setRuleset(e.target.value as Ruleset)}>
        {Object.entries(RULESET_NAMES).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
      <textarea className="input h-24 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex gap-2">
        <label className="btn-ghost cursor-pointer">
          Open file…
          <input type="file" accept=".json,.txt,.md" className="hidden" onChange={async (e) => e.target.files?.[0] && setText(await e.target.files[0].text())} />
        </label>
        <button
          className="btn ml-auto"
          disabled={busy || !text.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ build: CharacterBuild; errors: string[] }>('/api/characters/import', { body: { ruleset, text } });
              openDraft(r.build, r.errors);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Reading…' : 'Import'}
        </button>
      </div>
    </section>
  );
}

export function CharacterCard({ c, onClick, selected }: { c: Summary; onClick?: () => void; selected?: boolean }) {
  return (
    <button onClick={onClick} className={`card flex w-full items-center gap-3 p-3 text-left hover:border-indigo-500 ${selected ? 'border-indigo-400' : ''}`}>
      {c.portrait ? (
        <img src={c.portrait} className="h-12 w-10 rounded object-cover" alt="" />
      ) : (
        <span className="flex h-12 w-10 items-center justify-center rounded bg-[#0d1117] font-serif text-xl text-indigo-300">{c.name[0]}</span>
      )}
      <span className="min-w-0">
        <span className="block truncate font-medium">{c.name}</span>
        <span className="block text-xs text-slate-400">
          {titleCase(c.species)} {titleCase(c.class)} {c.level}
        </span>
        <span className="block text-[10px] text-slate-500">{RULESET_NAMES[c.ruleset]}</span>
      </span>
    </button>
  );
}

export function CharacterLibrary() {
  const [list, setList] = useState<Summary[]>();
  useEffect(() => {
    api<Summary[]>('/api/characters').then(setList);
  }, []);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="rune-title">Your characters</h2>
          <button className="btn ml-auto" onClick={() => navigate('/characters/new')}>
            New character
          </button>
        </div>
        {list?.length === 0 && <p className="text-sm text-slate-400">No characters yet. Build one step by step, let the AI do it, or import one.</p>}
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {list?.map((c) => (
            <CharacterCard key={c.id} c={c} onClick={() => navigate(`/characters/${c.id}`)} />
          ))}
        </div>
      </section>
      <aside className="space-y-4">
        <AiForm />
        <ImportForm />
      </aside>
    </div>
  );
}

export function NewCharacter() {
  const draft = new URLSearchParams(location.search).get('draft') ? JSON.parse(sessionStorage.getItem(DRAFT) ?? 'null') : null;
  return (
    <div className="space-y-3">
      {draft?.errors?.length > 0 && (
        <div className="rounded-md border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-200">
          The sheet needs a few fixes before it's legal. They're listed on the right.
        </div>
      )}
      <Builder initial={draft?.build ?? emptyBuild()} />
    </div>
  );
}

export function CharacterView({ id, edit }: { id: string; edit?: boolean }) {
  const [r, setR] = useState<{ character: Character; derived: Derived; build: CharacterBuild }>();
  const load = () => api(`/api/characters/${id}`).then(setR);
  useEffect(() => {
    load();
  }, [id]);
  if (!r) return null;
  if (edit) return <Builder initial={r.build} characterId={id} onSaved={() => navigate(`/characters/${id}`)} />;
  const c = r.character;
  return (
    <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
      <div className="card">
        <Sheet c={c} d={r.derived} />
      </div>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <button className="btn" onClick={() => navigate(`/characters/${id}/edit`)}>
            Edit in builder
          </button>
          <a className="btn-ghost" href={`/api/characters/${id}/export`}>
            Export JSON
          </a>
          <button className="btn-danger ml-auto" onClick={async () => confirm(`Delete ${c.name}?`) && (await api(`/api/characters/${id}`, { method: 'DELETE' }), navigate('/characters'))}>
            Delete
          </button>
        </div>
        <StoryFields c={c} onSaved={load} />
      </div>
    </div>
  );
}

function StoryFields({ c, onSaved }: { c: Character; onSaved: () => void }) {
  const [f, setF] = useState({ appearance: c.appearance ?? '', personality: c.personality ?? '', backstory: c.backstory ?? '', notes: c.notes ?? '' });
  return (
    <section className="card space-y-2">
      <h2 className="rune-title">Story</h2>
      {(['appearance', 'personality', 'backstory', 'notes'] as const).map((k) => (
        <label key={k} className="block">
          <span className="label">{k}</span>
          <textarea className="input readable h-20" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
        </label>
      ))}
      <button className="btn" onClick={() => api(`/api/characters/${c.id}`, { method: 'PATCH', body: f }).then(onSaved)}>
        Save story
      </button>
    </section>
  );
}
