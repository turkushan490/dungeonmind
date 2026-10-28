import { useEffect, useState } from 'react';
import { api } from '../api';
import { useMe } from '../me';
import { toast } from '../notify';
import { VoiceSettings } from './VoiceSettings';
import { changeServer, isNative } from '../native';

interface ModelRef {
  providerId: string;
  model: string;
}
interface HmSettings {
  url: string;
  hasToken: boolean;
  models: { story?: ModelRef; json?: ModelRef; image?: ModelRef };
  timeoutMs: number;
  installed: {
    canvasesAt?: string;
    canvases?: { id: string; ok: boolean; error?: string; needsModel?: string[] }[];
    rules?: Record<string, { count: number; at: string }>;
    importing?: { ruleset: string; done: number; total: number; error?: string };
  };
}
interface Health {
  ok: boolean;
  version?: string;
  features: string[];
  missing: string[];
  missingOptional: string[];
  error?: string;
}

export function HealthBadge({ h }: { h?: Health }) {
  if (!h) return <span className="chip">checking…</span>;
  if (!h.ok) return <span className="chip border-red-800 text-red-300">not reachable</span>;
  if (h.missing.length) return <span className="chip border-amber-700 text-amber-300">needs a HiveMind update</span>;
  return <span className="chip border-emerald-800 text-emerald-300">connected · {h.version}</span>;
}

const key = (m?: ModelRef) => (m ? `${m.providerId}::${m.model}` : '');

function HiveMindSettings() {
  const [s, setS] = useState<HmSettings>();
  const [health, setHealth] = useState<Health>();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [models, setModels] = useState<{ providerId: string; model: string }[]>([]);
  const [busy, setBusy] = useState('');

  const load = async () => {
    const x = await api<HmSettings>('/api/settings/hivemind');
    setS(x);
    setUrl((u) => u || x.url);
    return x;
  };
  const check = async () => {
    setHealth(undefined);
    const h = await api<Health>('/api/hivemind/health');
    setHealth(h);
    if (h.ok) api('/api/hivemind/models', { quiet: true }).then(setModels).catch(() => setModels([]));
  };
  useEffect(() => {
    load().then(check);
  }, []);
  // While rules are importing, poll the progress.
  useEffect(() => {
    if (!s?.installed.importing || s.installed.importing.error) return;
    const t = setTimeout(load, 1500);
    return () => clearTimeout(t);
  }, [s]);

  if (!s) return null;
  const save = async (patch: Record<string, unknown>) => {
    await api('/api/settings/hivemind', { method: 'PUT', body: patch });
    await load();
  };
  const pick = (role: 'story' | 'json' | 'image', v: string) => {
    const [providerId, model] = v.split('::');
    save({ models: { ...s.models, [role]: v ? { providerId, model } : undefined } });
  };

  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="rune-title">HiveMind</h2>
        <HealthBadge h={health} />
        <button className="btn-ghost ml-auto" onClick={check}>
          Check again
        </button>
      </div>
      <p className="text-sm text-slate-400">
        All AI runs through your HiveMind: the narrator, the rules adjudicator, the chronicler and the images. Create a token in HiveMind under Settings → API tokens (as a member, not a viewer).
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="label">HiveMind URL</span>
          <input className="input" placeholder="http://192.168.1.10:4820" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label>
          <span className="label">API token {s.hasToken && <span className="normal-case text-emerald-400">(saved)</span>}</span>
          <input className="input" type="password" placeholder={s.hasToken ? '•••••••• (leave empty to keep)' : 'hm_…'} value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
      </div>
      <button
        className="btn"
        onClick={async () => {
          await save({ url, token: token || undefined });
          setToken('');
          toast('Saved', 'info');
          check();
        }}
      >
        Save connection
      </button>

      {health && health.missing.length > 0 && health.ok && (
        <div className="rounded-md border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-200">
          This HiveMind is missing: <b>{health.missing.join(', ')}</b>. Update HiveMind (the DungeonMind changes, M0). Games can't start until then.
        </div>
      )}
      {health?.error && <p className="text-sm text-red-400">{health.error}</p>}

      <div>
        <h3 className="label">Models</h3>
        <p className="mb-2 text-xs text-slate-500">Used for new canvas blocks. Models you already picked in HiveMind are kept when you reinstall.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {(
            [
              ['story', 'Story (narrator, Ask the DM)'],
              ['json', 'Rules & state (JSON)'],
              ['image', 'Images (ComfyUI)'],
            ] as const
          ).map(([role, label]) => (
            <label key={role}>
              <span className="label">{label}</span>
              <select className="input" value={key(s.models[role])} onChange={(e) => pick(role, e.target.value)}>
                <option value="">– pick in HiveMind –</option>
                {s.models[role] && !models.some((m) => key(m) === key(s.models[role])) && <option value={key(s.models[role])}>{s.models[role]!.model}</option>}
                {models.map((m) => (
                  <option key={key(m)} value={key(m)}>
                    {m.model} ({m.providerId})
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          className="btn"
          disabled={!!busy || !health?.ok}
          onClick={async () => {
            setBusy('install');
            try {
              await api('/api/hivemind/install', { method: 'POST' });
              await load();
            } finally {
              setBusy('');
            }
          }}
        >
          {busy === 'install' ? 'Installing…' : 'Install / update canvases'}
        </button>
        <button
          className="btn-ghost"
          disabled={!!busy || !health?.ok || (!!s.installed.importing && !s.installed.importing.error)}
          onClick={async () => {
            await api('/api/hivemind/import-rules', { body: {} });
            load();
          }}
        >
          Load SRD rules into HiveMind memory
        </button>
      </div>
      {s.installed.importing && (
        <p className={`text-sm ${s.installed.importing.error ? 'text-red-400' : 'text-slate-300'}`}>
          {s.installed.importing.error
            ? `Rules import failed: ${s.installed.importing.error}`
            : `Importing ${s.installed.importing.ruleset}: ${s.installed.importing.done} / ${s.installed.importing.total}`}
        </p>
      )}
      {s.installed.rules && (
        <p className="text-xs text-slate-400">
          {Object.entries(s.installed.rules)
            .map(([r, v]) => `${r}: ${v.count} entries (${new Date(v.at).toLocaleDateString()})`)
            .join(' · ')}
        </p>
      )}
      {s.installed.canvases && (
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {s.installed.canvases.map((c) => (
            <li key={c.id} className="flex items-center gap-2">
              <span className={c.ok ? (c.needsModel ? 'text-amber-300' : 'text-emerald-400') : 'text-red-400'}>{c.ok ? (c.needsModel ? '◐' : '●') : '✕'}</span>
              <a className="hover:underline" href={`/api/hivemind/canvases/${c.id}`} title="Download the JSON">
                {c.id}
              </a>
              <span className="truncate text-xs text-slate-500">{c.error ?? (c.needsModel ? `pick a model for: ${c.needsModel.join(', ')}` : '')}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Users() {
  const me = useMe();
  const [list, setList] = useState<{ id: string; username: string; email?: string; role: string; lastSeenAt?: string }[]>([]);
  const [open, setOpen] = useState<boolean>();
  const load = () => api('/api/admin/users').then(setList);
  useEffect(() => {
    load();
    api('/api/auth/config').then((c) => setOpen(c.registration));
  }, []);
  return (
    <section className="card space-y-3">
      <h2 className="rune-title">Users</h2>
      {me.authMode === 'builtin' && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-indigo-500"
            checked={!!open}
            onChange={async (e) => setOpen((await api('/api/admin/registration', { method: 'PUT', body: { open: e.target.checked } })).registration)}
          />
          Anyone can register
        </label>
      )}
      <ul className="divide-y divide-[#30363d] text-sm">
        {list.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className="font-medium">{u.username}</span>
            {u.email && <span className="text-xs text-slate-500">{u.email}</span>}
            <span className="ml-auto text-xs text-slate-500">{u.lastSeenAt ? `seen ${u.lastSeenAt}` : 'never seen'}</span>
            <select
              className="input w-auto py-1"
              value={u.role}
              disabled={u.id === me.id}
              onChange={(e) => api(`/api/admin/users/${u.id}`, { method: 'PUT', body: { role: e.target.value } }).then(load)}
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
            {u.id !== me.id && (
              <button className="btn-danger" onClick={() => confirm(`Delete ${u.username} and their characters?`) && api(`/api/admin/users/${u.id}`, { method: 'DELETE' }).then(load)}>
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Reading() {
  const me = useMe();
  const [p, setP] = useState(me.prefs as Record<string, any>);
  const set = async (patch: Record<string, unknown>) => {
    const next = await api('/api/me/prefs', { method: 'PUT', body: patch });
    setP(next);
    Object.assign(me.prefs, next);
    const html = document.documentElement;
    html.dataset.fontSize = next.fontSize ?? 'md';
    html.dataset.line = next.lineSpacing ?? 'normal';
    html.dataset.dyslexia = next.dyslexia ? '1' : '0';
  };
  return (
    <section className="card space-y-3">
      <h2 className="rune-title">Reading</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <label>
          <span className="label">Story text size</span>
          <select className="input" value={p.fontSize ?? 'md'} onChange={(e) => set({ fontSize: e.target.value })}>
            <option value="md">Normal</option>
            <option value="lg">Large</option>
            <option value="xl">Extra large</option>
          </select>
        </label>
        <label>
          <span className="label">Line spacing</span>
          <select className="input" value={p.lineSpacing ?? 'normal'} onChange={(e) => set({ lineSpacing: e.target.value })}>
            <option value="normal">Normal</option>
            <option value="loose">Loose</option>
          </select>
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" className="accent-indigo-500" checked={!!p.dyslexia} onChange={(e) => set({ dyslexia: e.target.checked })} />
          Dyslexia-friendly font
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" className="accent-indigo-500" checked={p.animations !== false} onChange={(e) => set({ animations: e.target.checked })} />
          Animations (3D dice, ink text, effects)
        </label>
      </div>
      <p className="story rounded-md border border-[#30363d] bg-[#0d1117] p-3">The torchlight gutters. Somewhere below, something old is waking.</p>
    </section>
  );
}

export function SettingsPage() {
  const me = useMe();
  return (
    <div className="space-y-4">
      {isNative() && (
        <section className="card flex items-center gap-2">
          <span className="text-sm text-slate-300">Connected to {location.host}</span>
          <button className="btn-ghost ml-auto" onClick={changeServer}>
            Change server
          </button>
        </section>
      )}
      <Reading />
      <VoiceSettings />
      {me.role === 'admin' && <HiveMindSettings />}
      {me.role === 'admin' && <Users />}
    </div>
  );
}
