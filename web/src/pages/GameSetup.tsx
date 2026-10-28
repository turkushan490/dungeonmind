import { useEffect, useState } from 'react';
import { RULESET_NAMES, type GameDetail, type Pitch, type SetupField } from '@dungeonmind/shared';
import { api } from '../api';
import { useMe } from '../me';
import { navigate } from '../router';
import { titleCase } from '../rules';
import { useGame } from '../useGame';
import { CharacterCard } from './Characters';
import { SettingsFields } from './NewAdventure';

function FieldInput({ f, value, onChange, disabled }: { f: SetupField; value: any; onChange: (v: any) => void; disabled?: boolean }) {
  if (f.type === 'select')
    return (
      <select className="input" disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {(f.options ?? []).map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  if (f.type === 'slider')
    return (
      <div className="flex items-center gap-3">
        <input type="range" className="w-full accent-indigo-500" disabled={disabled} min={f.min ?? 0} max={f.max ?? 10} value={Number(value ?? f.min ?? 0)} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="w-8 text-right font-mono">{value}</span>
      </div>
    );
  if (f.type === 'multi') {
    const list: string[] = Array.isArray(value) ? value : [];
    return (
      <div className="flex flex-wrap gap-2">
        {(f.options ?? []).map((o) => (
          <label key={o} className="chip cursor-pointer">
            <input type="checkbox" className="accent-indigo-500" disabled={disabled} checked={list.includes(o)} onChange={() => onChange(list.includes(o) ? list.filter((x) => x !== o) : [...list, o])} />
            {o}
          </label>
        ))}
      </div>
    );
  }
  return <input className="input" disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}

function Pitches({ g, onChanged }: { g: GameDetail; onChanged: () => void }) {
  const [wishes, setWishes] = useState(g.settings.wishes ?? '');
  const [busy, setBusy] = useState('');
  const [own, setOwn] = useState<Pitch>({ title: '', hook: '' });
  const pick = async (p: Pitch) => {
    setBusy('form');
    try {
      await api(`/api/games/${g.id}/form`, { body: { pitch: p } });
      onChanged();
    } finally {
      setBusy('');
    }
  };
  return (
    <section className="card space-y-3">
      <h2 className="rune-title">1 · The idea</h2>
      <textarea className="input h-20" placeholder="What do you want? A setting, a genre, a feeling. e.g. “Plague-ridden river city, a cult, political intrigue, grim but with hope.”" value={wishes} onChange={(e) => setWishes(e.target.value)} />
      <button
        className="btn"
        disabled={!!busy}
        onClick={async () => {
          setBusy('pitch');
          try {
            await api(`/api/games/${g.id}/pitches`, { body: { wishes } });
            onChanged();
          } finally {
            setBusy('');
          }
        }}
      >
        {busy === 'pitch' ? <span className="dm-breathe">The DM is dreaming up pitches…</span> : 'Suggest pitches'}
      </button>
      {g.settings.pitches && (
        <div className="grid gap-2 sm:grid-cols-2">
          {g.settings.pitches.map((p) => (
            <button key={p.title} disabled={!!busy} onClick={() => pick(p)} className={`card text-left hover:border-indigo-500 ${g.settings.pitch?.title === p.title ? 'border-indigo-400' : ''}`}>
              <span className="block font-serif text-base text-indigo-100">{p.title}</span>
              <span className="story block text-sm">{p.hook}</span>
              {p.tone && <span className="mt-1 block text-xs text-slate-500">{p.tone}</span>}
            </button>
          ))}
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-sm text-indigo-300">…or write your own pitch</summary>
        <div className="mt-2 space-y-2">
          <input className="input" placeholder="Title" value={own.title} onChange={(e) => setOwn({ ...own, title: e.target.value })} />
          <textarea className="input h-16" placeholder="The hook" value={own.hook} onChange={(e) => setOwn({ ...own, hook: e.target.value })} />
          <button className="btn-ghost" disabled={!own.title || !!busy} onClick={() => pick(own)}>
            Use this pitch
          </button>
        </div>
      </details>
      {busy === 'form' && <p className="dm-breathe text-sm text-slate-300">The DM is preparing the setup questions…</p>}
    </section>
  );
}

function SetupForm({ g, host }: { g: GameDetail; host: boolean }) {
  const [vals, setVals] = useState(g.settings.formValues ?? {});
  useEffect(() => setVals(g.settings.formValues ?? {}), [g.settings.formValues]);
  if (!g.settings.form) return null;
  return (
    <section className="card space-y-3">
      <h2 className="rune-title">2 · {g.settings.form.title ?? g.settings.pitch?.title}</h2>
      {g.settings.form.summary && <p className="story text-sm">{g.settings.form.summary}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {g.settings.form.fields.map((f) => (
          <label key={f.id} className="block">
            <span className="label">{f.label}</span>
            <FieldInput f={f} value={vals[f.id]} disabled={!host} onChange={(v) => setVals({ ...vals, [f.id]: v })} />
            {f.help && <span className="text-xs text-slate-500">{f.help}</span>}
          </label>
        ))}
      </div>
      {host && (
        <label className="block">
          <span className="label">House rules & tone notes (optional)</span>
          <textarea className="input h-16" defaultValue={g.settings.houseRules} onBlur={(e) => api(`/api/games/${g.id}`, { method: 'PUT', body: { houseRules: e.target.value } })} />
        </label>
      )}
      {host && (
        <button className="btn-ghost" onClick={() => api(`/api/games/${g.id}`, { method: 'PUT', body: { formValues: vals } })}>
          Save answers
        </button>
      )}
    </section>
  );
}

function Table({ g, reload }: { g: GameDetail; reload: () => void }) {
  const me = useMe();
  const host = g.myRole === 'host';
  const [invite, setInvite] = useState('');
  const [library, setLibrary] = useState<any[]>([]);
  useEffect(() => {
    api<any[]>('/api/characters').then(setLibrary);
  }, []);
  const fits = library.filter((c) => c.ruleset === g.ruleset);
  return (
    <section className="card space-y-3">
      <h2 className="rune-title">3 · The table</h2>
      <ul className="space-y-1 text-sm">
        {g.members.map((m) => (
          <li key={m.userId} className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${m.online ? 'bg-emerald-400' : 'bg-slate-600'}`} />
            {m.username}
            <span className="text-xs text-slate-500">{m.role === 'host' ? 'host' : m.status === 'invited' ? 'invited' : 'player'}</span>
            {host && m.role !== 'host' && (
              <button className="ml-auto text-xs text-red-300 hover:underline" onClick={() => api(`/api/games/${g.id}/members/${m.userId}`, { method: 'DELETE' }).then(reload)}>
                remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {host && (
        <div className="flex gap-2">
          <input className="input" placeholder="Invite by username" value={invite} onChange={(e) => setInvite(e.target.value)} />
          <button className="btn" disabled={!invite.trim()} onClick={() => api(`/api/games/${g.id}/invites`, { body: { username: invite.trim() } }).then(() => (setInvite(''), reload()))}>
            Invite
          </button>
        </div>
      )}
      <h3 className="label pt-2">Characters at the table</h3>
      <ul className="space-y-1 text-sm">
        {g.characters.map((c) => (
          <li key={c.id} className="flex items-center gap-2">
            <span className="font-medium">{c.name}</span>
            <span className="text-xs text-slate-400">
              {titleCase(c.species)} {titleCase(c.class)} {c.level} · {g.members.find((m) => m.userId === c.userId)?.username}
            </span>
            {(host || c.userId === me.id) && g.status === 'setup' && (
              <button className="ml-auto text-xs text-red-300 hover:underline" onClick={() => api(`/api/games/${g.id}/characters/${c.id}`, { method: 'DELETE' }).then(reload)}>
                remove
              </button>
            )}
          </li>
        ))}
        {g.characters.length === 0 && <li className="text-slate-500">Nobody yet.</li>}
      </ul>
      {(g.myRole === 'host' || g.myRole === 'player') && (
        <div>
          <h3 className="label">Bring a character (level {g.settings.startLevel}, {RULESET_NAMES[g.ruleset]})</h3>
          {fits.length === 0 && (
            <p className="text-xs text-slate-500">
              No {g.ruleset} characters in your library.{' '}
              <button className="underline" onClick={() => navigate('/characters/new')}>
                Build one
              </button>
            </p>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            {fits.map((c) => (
              <CharacterCard key={c.id} c={c} onClick={() => api(`/api/games/${g.id}/characters`, { body: { characterId: c.id } }).then(reload)} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function GameSetup({ id }: { id: string }) {
  const { g, reload } = useGame(id);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (g && g.status !== 'setup') navigate(`/table/${id}`);
  }, [g?.status]);
  if (g === null) return <p className="text-slate-400">This game doesn't exist or you weren't invited.</p>;
  if (!g) return null;
  const host = g.myRole === 'host';
  const set = (p: Record<string, unknown>) => api(`/api/games/${g.id}`, { method: 'PUT', body: p }).then(reload);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-serif text-2xl text-indigo-100">{g.name}</h1>
          <span className="chip">{RULESET_NAMES[g.ruleset]}</span>
          <span className="chip">
            level {g.settings.startLevel} → {g.settings.endLevel}
          </span>
        </div>
        {g.myRole === 'invited' && (
          <div className="card flex items-center gap-2 border-indigo-600">
            You're invited to this table.
            <button className="btn ml-auto" onClick={() => api(`/api/games/${g.id}/accept`, { method: 'POST' }).then(reload)}>
              Join
            </button>
          </div>
        )}
        {host ? <Pitches g={g} onChanged={reload} /> : g.settings.pitch && (
          <section className="card">
            <h2 className="rune-title">{g.settings.pitch.title}</h2>
            <p className="story text-sm">{g.settings.pitch.hook}</p>
          </section>
        )}
        <SetupForm g={g} host={host} />
        {host && (
          <section className="card space-y-3">
            <h2 className="rune-title">Rules of the table</h2>
            <SettingsFields v={{ ...g.settings, visibility: g.visibility }} set={set} />
          </section>
        )}
      </div>
      <aside className="space-y-4">
        <Table g={g} reload={reload} />
        {host && (
          <section className="card space-y-2">
            <button
              className="btn w-full"
              disabled={starting || !g.characters.length || !g.settings.pitch}
              onClick={async () => {
                setStarting(true);
                try {
                  await api(`/api/games/${g.id}/start`, { method: 'POST' });
                  navigate(`/table/${g.id}`);
                } finally {
                  setStarting(false);
                }
              }}
            >
              {starting ? <span className="dm-breathe">Writing the campaign…</span> : 'Begin the adventure'}
            </button>
            <p className="text-xs text-slate-500">Needs a pitch and at least one character. More players can join later.</p>
            <button className="btn-danger w-full" onClick={() => confirm('Delete this adventure?') && api(`/api/games/${g.id}`, { method: 'DELETE' }).then(() => navigate('/'))}>
              Delete adventure
            </button>
          </section>
        )}
      </aside>
    </div>
  );
}
