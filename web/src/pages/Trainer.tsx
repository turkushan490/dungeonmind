import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { toast } from '../notify';
import { getSocket } from '../socket';

/** M9: the admin "AI Trainer". Plain language; every HiveMind M9 feature is detected and explained when missing. */

type Feature = 'modelOverride' | 'nodeInputs' | 'scopedTraining' | 'trainEvents' | 'trainingWindow' | 'schedules';
interface ModelRef {
  providerId: string;
  model: string;
}
interface Board {
  model: string;
  games: number;
  turns: number;
  jsonValid: number;
  rulesPer100: number;
  numberPer100: number;
  resourcePer100: number;
  errorsPer100: number;
  story: number | null;
  tokensPerSec: number | null;
  secondsPerTurn: number | null;
}
interface NightlyResult {
  id: number;
  at: string;
  status: string;
  examples?: number;
  model?: string;
  candidate?: Board;
  current?: Board;
  promoted: boolean;
  reason: string;
  simId?: string;
  reportId?: string;
}
interface Status {
  hivemind: { ok: boolean; error?: string };
  features: Record<Feature, boolean>;
  dmModel: ModelRef | null;
  settings: { nightly: boolean; base: string; callbackUrl: string; judgeSample: number };
  callbackUrl: string;
  last: NightlyResult | null;
  nextRun: string | null;
  window: { start: string; end: string; open: boolean } | null;
  dataset: { name: string; size: number | null; pushed: number; waiting: number };
  records: Record<string, number>;
  live: { stream: string; last: number; done: boolean }[];
}
interface Scenario {
  id: string;
  text: string;
  source: string;
}
interface Sim {
  id: string;
  kind: 'sim' | 'eval';
  status: string;
  error?: string;
  createdAt: string;
  settings: { models: ModelRef[]; games: number; turns: number };
  scoreboard: Board[];
}
interface DmOption extends ModelRef {
  why: 'trained' | 'curated' | 'tested';
  label: string;
  installed: boolean;
}

const FEATURE_TEXT: Record<Feature, string> = {
  modelOverride: 'comparing models',
  nodeInputs: 'recording the exact prompts',
  scopedTraining: 'datasets and training',
  trainEvents: 'live training progress',
  trainingWindow: 'the training window',
  schedules: 'nightly training',
};

/** What a missing HiveMind M9 feature means, instead of a grey button. */
export function NeedsUpdate({ f }: { f: Feature }) {
  return <span className="text-xs text-amber-300">HiveMind needs updating for {FEATURE_TEXT[f]} ({f}).</span>;
}

const modelLabel = (m?: ModelRef | null) => (m ? `${m.model} (${m.providerId})` : 'the models picked on the canvases');

function lastNight(r: NightlyResult | null): string {
  if (!r) return 'No training yet.';
  const trained = r.examples !== undefined ? `Trained on ${r.examples} new examples` : 'Trained';
  if (r.promoted && r.candidate && r.current) return `${trained}, ${r.candidate.errorsPer100} vs ${r.current.errorsPer100} errors/100 → ${r.model} is now your DM.`;
  if (r.status !== 'done') return `Kept the old DM because ${r.reason}.`;
  return `${trained}${r.candidate && r.current ? `, ${r.candidate.errorsPer100} vs ${r.current.errorsPer100} errors/100` : ''} … kept the old one because ${r.reason}.`;
}

function StatusSection({ s, reload, watch }: { s: Status; reload: () => void; watch: (stream: string) => void }) {
  const [base, setBase] = useState(s.settings.base);
  const [callback, setCallback] = useState(s.settings.callbackUrl);
  const [busy, setBusy] = useState(false);
  const save = async (patch: Record<string, unknown>) => {
    const r = await api<{ nightly: { ok: boolean; error?: string } }>('/api/trainer/settings', { method: 'PUT', body: patch });
    if (!r.nightly.ok && r.nightly.error) toast(r.nightly.error, 'info');
    reload();
  };
  const running = s.live.filter((l) => !l.done);
  return (
    <section className="card space-y-3">
      <h2 className="rune-title">Status</h2>
      {!s.hivemind.ok && <p className="text-sm text-red-400">HiveMind is not reachable: {s.hivemind.error}</p>}
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="label">Your DM model</dt>
          <dd>{modelLabel(s.dmModel)}</dd>
        </div>
        <div>
          <dt className="label">Last night</dt>
          <dd>{lastNight(s.last)}</dd>
        </div>
        <div>
          <dt className="label">Next run</dt>
          <dd>{s.features.schedules ? (s.nextRun ? `Tonight at ${s.nextRun} (new examples go to HiveMind at 02:45)` : 'Nightly training is off') : <NeedsUpdate f="schedules" />}</dd>
        </div>
        <div>
          <dt className="label">Dataset "{s.dataset.name}"</dt>
          <dd>
            {s.dataset.size ?? s.dataset.pushed} examples in HiveMind · {s.dataset.waiting} waiting for the next push
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="label">Training window</dt>
          <dd>
            {s.window ? (
              <>
                {s.window.start}–{s.window.end} ({s.window.open ? 'open now' : 'closed now'}). Change it in HiveMind → Settings → Training.
              </>
            ) : (
              <NeedsUpdate f="trainingWindow" />
            )}
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn"
          disabled={busy || !s.features.scopedTraining}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ jobId: string; pushed: number }>('/api/trainer/train-now', { method: 'POST' });
              toast(`Pushed ${r.pushed} new examples; training started`, 'info');
              watch(`train:${r.jobId}`);
              reload();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Starting…' : 'Train now'}
        </button>
        <button className="btn-ghost" disabled={!s.features.schedules} onClick={() => save({ nightly: !s.settings.nightly })}>
          Nightly training: {s.settings.nightly ? 'on' : 'off'}
        </button>
        {!s.features.scopedTraining && <NeedsUpdate f="scopedTraining" />}
        {s.features.scopedTraining && !s.features.schedules && <NeedsUpdate f="schedules" />}
        <button className="btn-ghost" onClick={() => watch('nightly')}>
          Watch the nightly steps
        </button>
      </div>
      {running.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-400">Running now:</span>
          {running.map((l) => (
            <button key={l.stream} className="chip hover:text-white" onClick={() => watch(l.stream)}>
              👁 {l.stream.split(':')[0]}
            </button>
          ))}
        </div>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-slate-400">Training settings</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label>
            <span className="label">Base model to train</span>
            <input className="input" value={base} onChange={(e) => setBase(e.target.value)} onBlur={() => base !== s.settings.base && save({ base })} />
          </label>
          <label>
            <span className="label">Address HiveMind reports back to</span>
            <input className="input" placeholder={s.callbackUrl || 'https://dm.example.com'} value={callback} onChange={(e) => setCallback(e.target.value)} onBlur={() => callback !== s.settings.callbackUrl && save({ callbackUrl: callback })} />
          </label>
        </div>
        <p className="mt-1 text-xs text-slate-500">HiveMind's workflow "DungeonMind: nightly training" is (re)installed when these change.</p>
      </details>
    </section>
  );
}

function ScenarioRow({ s, reload }: { s: Scenario; reload: () => void }) {
  const [edit, setEdit] = useState<string>();
  return (
    <tr className="border-t border-[#30363d] align-top">
      <td className="py-1.5 pr-2">
        {edit === undefined ? (
          <button className="text-left hover:text-white" title="Click to edit" onClick={() => setEdit(s.text)}>
            {s.text}
          </button>
        ) : (
          <div className="flex gap-1">
            <textarea className="input h-16" value={edit} onChange={(e) => setEdit(e.target.value)} />
            <div className="flex flex-col gap-1">
              <button className="btn py-0.5 text-xs" onClick={async () => (await api(`/api/trainer/scenarios/${s.id}`, { method: 'PUT', body: { text: edit } }), setEdit(undefined), reload())}>
                Save
              </button>
              <button className="btn-ghost py-0.5 text-xs" onClick={() => setEdit(undefined)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </td>
      <td className="py-1.5 pr-2">
        <span className="chip">{s.source}</span>
      </td>
      <td className="py-1.5 text-right">
        <button className="btn-danger py-0.5 text-xs" onClick={() => api(`/api/trainer/scenarios/${s.id}`, { method: 'DELETE' }).then(reload)}>
          Delete
        </button>
      </td>
    </tr>
  );
}

function ScenariosSection({ list, reload }: { list: Scenario[]; reload: () => void }) {
  const [one, setOne] = useState('');
  const [bulk, setBulk] = useState('');
  const [theme, setTheme] = useState('');
  const [busy, setBusy] = useState(false);
  const [games, setGames] = useState<{ id: string; name: string }[]>([]);
  const [game, setGame] = useState('');
  useEffect(() => {
    api('/api/trainer/games').then(setGames);
  }, []);
  return (
    <section className="card space-y-3">
      <h2 className="rune-title">Scenarios</h2>
      <p className="text-xs text-slate-500">
        The starting situations simulated games are played from. "From outcomes": the situation just before each real turn labelled bad is added here by itself.
      </p>
      <div className="flex gap-2">
        <input className="input" placeholder="A new scenario" value={one} onChange={(e) => setOne(e.target.value)} />
        <button className="btn" disabled={!one.trim()} onClick={async () => (await api('/api/trainer/scenarios', { body: { text: one } }), setOne(''), reload())}>
          Add
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <span className="label">Bulk add (one per line)</span>
          <textarea className="input h-20" value={bulk} onChange={(e) => setBulk(e.target.value)} />
          <button className="btn-ghost" disabled={!bulk.trim()} onClick={async () => (await api('/api/trainer/scenarios/bulk', { body: { text: bulk } }), setBulk(''), reload())}>
            Add all
          </button>
        </div>
        <div className="space-y-1">
          <span className="label">Write 20 with AI</span>
          <input className="input" placeholder="Theme, e.g. haunted mines" value={theme} onChange={(e) => setTheme(e.target.value)} />
          <button
            className="btn-ghost"
            disabled={busy || !theme.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await api('/api/trainer/scenarios/ai', { body: { theme } });
                setTheme('');
                reload();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Writing…' : 'Write 20'}
          </button>
        </div>
        <div className="space-y-1">
          <span className="label">From a campaign</span>
          <select className="input" value={game} onChange={(e) => setGame(e.target.value)}>
            <option value="">– pick a game –</option>
            {games.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <button className="btn-ghost" disabled={!game} onClick={async () => (await api('/api/trainer/scenarios/from-game', { body: { gameId: game } }), reload())}>
            Use its current scene
          </button>
        </div>
      </div>
      {list.length > 0 && (
        <div className="scroll-thin max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <tbody>
              {list.map((s) => (
                <ScenarioRow key={s.id} s={s} reload={reload} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Scoreboard({ rows }: { rows: Board[] }) {
  if (!rows.length) return null;
  const n = (v: number | null, unit = '') => (v === null ? '–' : `${v}${unit}`);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-slate-400">
          <tr>
            <th className="text-left">Model</th>
            <th>Turns</th>
            <th>JSON valid</th>
            <th>Rules /100</th>
            <th>Numbers /100</th>
            <th>Resources /100</th>
            <th>Story</th>
            <th>Tokens/s</th>
            <th>s/turn</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.model} className="border-t border-[#30363d] text-center">
              <td className="text-left">{r.model === 'current' ? 'current DM' : r.model}</td>
              <td>{r.turns}</td>
              <td>{r.jsonValid}%</td>
              <td>{r.rulesPer100}</td>
              <td>{r.numberPer100}</td>
              <td>{r.resourcePer100}</td>
              <td>{n(r.story)}</td>
              <td>{n(r.tokensPerSec)}</td>
              <td>{n(r.secondsPerTurn)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SimulateSection({ s, scenarios, sims, reload, watch, picked, setPicked }: { s: Status; scenarios: Scenario[]; sims: Sim[]; reload: () => void; watch: (stream: string) => void; picked: string[]; setPicked: (ids: string[]) => void }) {
  const [options, setOptions] = useState<DmOption[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [games, setGames] = useState(1);
  const [turns, setTurns] = useState(5);
  const [only, setOnly] = useState<string[]>([]);
  useEffect(() => {
    api<{ options: DmOption[] }>('/api/trainer/dm-models', { quiet: true }).then((r) => setOptions(r.options)).catch(() => {});
  }, []);
  const key = (m: ModelRef) => `${m.providerId}::${m.model}`;
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <section className="card space-y-3">
      <h2 className="rune-title">Simulate</h2>
      <p className="text-xs text-slate-500">Fake players (a reckless fighter, a rules-lawyer, a sneaky rogue, a healer, a typo-heavy casual) play real games against the DM. The judge checks every turn the Bookkeeper flags.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <span className="label">DM models to compare</span>
          {s.features.modelOverride ? (
            <div className="scroll-thin max-h-32 space-y-0.5 overflow-y-auto text-sm">
              {options.map((o) => (
                <label key={key(o)} className="flex items-center gap-2">
                  <input type="checkbox" className="accent-indigo-500" checked={models.includes(key(o))} onChange={() => setModels(toggle(models, key(o)))} />
                  {o.label}
                </label>
              ))}
              <p className="text-xs text-slate-500">None picked: the current DM.</p>
            </div>
          ) : (
            <p className="text-sm">
              The current DM only. <NeedsUpdate f="modelOverride" />
            </p>
          )}
        </div>
        <div className="space-y-2">
          <label className="block">
            <span className="label">Games per model</span>
            <input className="input" type="number" min={1} max={10} value={games} onChange={(e) => setGames(Number(e.target.value))} />
          </label>
          <label className="block">
            <span className="label">Turns per game</span>
            <input className="input" type="number" min={1} max={30} value={turns} onChange={(e) => setTurns(Number(e.target.value))} />
          </label>
        </div>
        <div>
          <span className="label">Scenarios (none picked: all)</span>
          <div className="scroll-thin max-h-32 space-y-0.5 overflow-y-auto text-xs">
            {scenarios.map((x) => (
              <label key={x.id} className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5 accent-indigo-500" checked={only.includes(x.id)} onChange={() => setOnly(toggle(only, x.id))} />
                <span className="line-clamp-2">{x.text}</span>
              </label>
            ))}
            {!scenarios.length && <p className="text-slate-500">No scenarios yet: two built-in ones are used.</p>}
          </div>
        </div>
      </div>
      <button
        className="btn"
        onClick={async () => {
          const chosen = options.filter((o) => models.includes(key(o))).map((o) => ({ providerId: o.providerId, model: o.model }));
          const { id } = await api<{ id: string }>('/api/trainer/sims', { body: { models: chosen, games, turns, scenarioIds: only } });
          watch(`sim:${id}`);
          reload();
        }}
      >
        Start
      </button>
      <ul className="space-y-3">
        {sims.map((x) => (
          <li key={x.id} className="rounded-md border border-[#30363d] p-2">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
              <input type="checkbox" className="accent-indigo-500" title="Include in the report" checked={picked.includes(x.id)} onChange={() => setPicked(toggle(picked, x.id))} />
              <span>{x.kind === 'eval' ? 'Nightly eval' : 'Simulation'}</span>
              <span className="text-xs text-slate-500">
                {x.createdAt} · {x.settings.games} game{x.settings.games === 1 ? '' : 's'} × {x.settings.turns} turns
              </span>
              <span className={`chip ${x.status === 'running' ? 'dm-breathe' : ''}`}>{x.status}</span>
              {x.error && <span className="text-xs text-red-400">{x.error}</span>}
              <span className="ml-auto flex gap-1">
                <button className="btn-ghost py-0.5 text-xs" onClick={() => watch(`sim:${x.id}`)}>
                  👁 Watch
                </button>
                {x.status === 'running' && (
                  <button className="btn-ghost py-0.5 text-xs" onClick={() => api(`/api/trainer/sims/${x.id}/stop`, { method: 'POST' }).then(reload)}>
                    Stop
                  </button>
                )}
                <button className="btn-danger py-0.5 text-xs" onClick={() => confirm('Delete this run, its games and its records?') && api(`/api/trainer/sims/${x.id}`, { method: 'DELETE' }).then(reload)}>
                  Delete
                </button>
              </span>
            </div>
            <Scoreboard rows={x.scoreboard} />
          </li>
        ))}
      </ul>
    </section>
  );
}

interface Rec {
  id: number;
  game: string;
  turn: number;
  canvas: string;
  node?: string;
  source: string;
  label: string;
  model?: string;
  question: string;
  output: string;
  corrected?: string;
  reasons: string[];
  judge?: { errors: { type: string; detail: string }[]; story?: number };
}

function RecordCard({ r, reload }: { r: Rec; reload: () => void }) {
  const [text, setText] = useState(r.corrected ?? r.output);
  const act = (body: Record<string, unknown>) => api(`/api/trainer/records/${r.id}`, { method: 'PUT', body }).then(reload);
  return (
    <li className="space-y-1.5 rounded-md border border-[#30363d] p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span className="chip">{r.label}</span>
        <span>
          {r.game} · turn {r.turn} · {r.canvas}
          {r.node ? ` / ${r.node}` : ''} · {r.source}
          {r.model ? ` · ${r.model}` : ''}
        </span>
      </div>
      {(r.reasons.length > 0 || r.judge?.errors.length) && (
        <ul className="list-inside list-disc text-xs text-amber-200">
          {r.judge?.errors.map((e, i) => (
            <li key={`j${i}`}>
              Judge, {e.type}: {e.detail}
            </li>
          ))}
          {r.reasons.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
      <details>
        <summary className="cursor-pointer text-xs text-slate-400">What the DM was asked</summary>
        <pre className="scroll-thin max-h-48 overflow-auto whitespace-pre-wrap text-xs text-slate-400">{r.question}</pre>
      </details>
      <pre className="scroll-thin max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[#0d1117] p-2 text-xs">{r.output}</pre>
      <label className="block">
        <span className="label">{r.corrected ? "The judge's correction (edit it if needed)" : 'Correct answer'}</span>
        <textarea className="input h-24 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="flex flex-wrap gap-1">
        <button className="btn py-0.5 text-xs" disabled={!r.corrected || text !== r.corrected} title={r.corrected ? '' : 'There is no correction yet: edit it and save'} onClick={() => act({ action: 'accept' })}>
          Accept the correction
        </button>
        <button className="btn-ghost py-0.5 text-xs" disabled={!text.trim() || text === r.corrected} onClick={() => act({ action: 'edit', corrected: text })}>
          Save my edit
        </button>
        <button className="btn-ghost py-0.5 text-xs" onClick={() => act({ action: 'reject' })}>
          Reject
        </button>
        <button className="btn-danger ml-auto py-0.5 text-xs" onClick={() => api(`/api/trainer/records/${r.id}`, { method: 'DELETE' }).then(reload)}>
          Delete
        </button>
      </div>
    </li>
  );
}

function ReviewSection({ counts }: { counts: Record<string, number> }) {
  const [label, setLabel] = useState('bad');
  const [source, setSource] = useState('');
  const [limit, setLimit] = useState(20);
  const [data, setData] = useState<{ total: number; records: Rec[] }>();
  const load = () => api(`/api/trainer/records?label=${label}&source=${source}&limit=${limit}`).then(setData);
  useEffect(() => {
    load();
  }, [label, source, limit]);
  return (
    <section className="card space-y-3">
      <h2 className="rune-title">Review</h2>
      <p className="text-xs text-slate-500">
        Every AI answer from real and simulated games. Good and accepted ones train the DM. {Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')}
      </p>
      <div className="flex flex-wrap gap-2">
        <select className="input w-auto" value={label} onChange={(e) => setLabel(e.target.value)}>
          {['bad', 'pending', 'good', 'accepted', 'rejected'].map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
        <select className="input w-auto" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">all sources</option>
          <option value="game">real games</option>
          <option value="sim">simulations</option>
          <option value="eval">nightly evals</option>
        </select>
      </div>
      <ul className="space-y-2">
        {data?.records.map((r) => (
          <RecordCard key={`${r.id}:${r.label}:${r.corrected ?? ''}`} r={r} reload={load} />
        ))}
      </ul>
      {data && data.records.length < data.total && (
        <button className="btn-ghost w-full" onClick={() => setLimit(limit + 20)}>
          Show more ({data.total - data.records.length} left)
        </button>
      )}
      {data?.total === 0 && <p className="text-sm text-slate-500">Nothing here.</p>}
    </section>
  );
}

interface Report {
  id: string;
  title: string;
  status: string;
  error?: string;
  createdAt: string;
}

function ReportSection({ picked, watch }: { picked: string[]; watch: (stream: string) => void }) {
  const [list, setList] = useState<Report[]>([]);
  const [open, setOpen] = useState<{ id: string; title: string; md: string }>();
  const load = () => api<Report[]>('/api/trainer/reports').then(setList);
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!list.some((r) => r.status === 'running')) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [list]);
  return (
    <section className="card space-y-3">
      <h2 className="rune-title">Report</h2>
      <p className="text-xs text-slate-500">
        An improvement report over the selected runs ({picked.length} picked under Simulate) plus the bad answers from real games: the top errors with real turns, prompt changes for scripts/build-canvases.mjs, code changes for the Bookkeeper and engine, and model advice. Paste it into a coding chat.
      </p>
      <button
        className="btn"
        onClick={async () => {
          const { id } = await api<{ id: string }>('/api/trainer/reports', { body: { simIds: picked } });
          watch(`report:${id}`);
          load();
        }}
      >
        Make improvement report
      </button>
      <ul className="divide-y divide-[#30363d] text-sm">
        {list.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 py-1.5">
            <button className="min-w-0 truncate text-left hover:underline" onClick={async () => setOpen(await api(`/api/trainer/reports/${r.id}`))}>
              {r.title}
            </button>
            <span className="text-xs text-slate-500">{r.createdAt}</span>
            <span className={`chip ${r.status === 'running' ? 'dm-breathe' : ''}`}>{r.status}</span>
            <span className="ml-auto flex gap-1">
              {r.status === 'running' && (
                <button className="btn-ghost py-0.5 text-xs" onClick={() => watch(`report:${r.id}`)}>
                  👁 Watch
                </button>
              )}
              <a className="btn-ghost py-0.5 text-xs" href={`/api/trainer/reports/${r.id}/download`}>
                Download .md
              </a>
              <button className="btn-danger py-0.5 text-xs" onClick={() => api(`/api/trainer/reports/${r.id}`, { method: 'DELETE' }).then(load)}>
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
      {open && (
        <Modal title={open.title} wide onClose={() => setOpen(undefined)}>
          <div className="mb-2 flex gap-2">
            <button className="btn-ghost text-xs" onClick={() => navigator.clipboard.writeText(open.md).then(() => toast('Copied', 'info'))}>
              Copy
            </button>
            <a className="btn-ghost text-xs" href={`/api/trainer/reports/${open.id}/download`}>
              Download .md
            </a>
          </div>
          <Markdown text={open.md || '_Still being written…_'} />
        </Modal>
      )}
    </section>
  );
}

/** The restricted DM model picker (M9): trained dungeonmind-* models, the curated list, and models that proved themselves in the simulator. */
export function DmModelPicker({ onDone }: { onDone?: () => void }) {
  const [data, setData] = useState<{ current: ModelRef | null; options: DmOption[] }>();
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api('/api/trainer/dm-models', { quiet: true }).then(setData).catch(() => setData({ current: null, options: [] }));
  useEffect(() => {
    load();
  }, []);
  const key = (m: ModelRef) => `${m.providerId}::${m.model}`;
  const chosen = data?.options.find((o) => key(o) === pick);
  const groups: [DmOption['why'], string][] = [
    ['trained', 'Trained here'],
    ['curated', 'Recommended'],
    ['tested', 'Passed the simulator (≥ 90% valid JSON over ≥ 20 turns)'],
  ];
  return (
    <div className="space-y-2">
      <p className="text-sm">Now: {modelLabel(data?.current)}</p>
      <div className="flex flex-wrap gap-2">
        <select className="input min-w-0 flex-1" value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">– pick a DM model –</option>
          {groups.map(([why, label]) => {
            const opts = data?.options.filter((o) => o.why === why) ?? [];
            return opts.length ? (
              <optgroup key={why} label={label}>
                {opts.map((o) => (
                  <option key={key(o)} value={key(o)}>
                    {o.label}
                    {o.installed ? '' : ' (will be downloaded)'}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
        </select>
        <button
          className="btn"
          disabled={busy || !chosen}
          onClick={async () => {
            setBusy(true);
            try {
              await api('/api/hivemind/dm-model', { body: { providerId: chosen!.providerId, model: chosen!.model, pull: !chosen!.installed } });
              toast(`${chosen!.model} is now the DM model`, 'info');
              setPick('');
              load();
              onDone?.();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Applying…' : 'Use this model'}
        </button>
      </div>
    </div>
  );
}

// ---- Watch the AI ----
interface LiveEvent {
  stream: string;
  type: string;
  text?: string;
  data?: any;
  at: number;
}

/** Joins consecutive token events into one block, so streamed text reads as text. */
function blocks(events: LiveEvent[]) {
  const out: { type: string; text: string; data?: any }[] = [];
  for (const e of events) {
    const prev = out.at(-1);
    if (prev && prev.type === e.type && /token|thinking/.test(e.type)) prev.text += e.text ?? '';
    else out.push({ type: e.type, text: e.text ?? '', data: e.data });
  }
  return out;
}

function LossChart({ points }: { points: { step: number; loss: number }[] }) {
  if (points.length < 2) return null;
  const maxS = Math.max(...points.map((p) => p.step));
  const minS = Math.min(...points.map((p) => p.step));
  const maxL = Math.max(...points.map((p) => p.loss));
  const minL = Math.min(...points.map((p) => p.loss));
  const x = (s: number) => ((s - minS) / (maxS - minS || 1)) * 290 + 5;
  const y = (l: number) => 95 - ((l - minL) / (maxL - minL || 1)) * 90;
  return (
    <svg viewBox="0 0 300 100" className="h-32 w-full rounded bg-[#0d1117]" role="img" aria-label="Training loss">
      <polyline fill="none" stroke="currentColor" className="text-indigo-400" strokeWidth="2" points={points.map((p) => `${x(p.step)},${y(p.loss)}`).join(' ')} />
      <text x="5" y="12" className="fill-slate-400 text-[9px]">
        loss {points.at(-1)!.loss.toFixed(3)}
      </text>
    </svg>
  );
}

const STYLE: Record<string, string> = {
  player: 'border-l-2 border-indigo-500 pl-2 text-indigo-100',
  'dm-token': 'story whitespace-pre-wrap',
  'dm-thinking': 'whitespace-pre-wrap text-xs italic text-slate-500',
  'judge-thinking': 'whitespace-pre-wrap text-xs italic text-slate-500',
  'judge-token': 'whitespace-pre-wrap font-mono text-xs text-slate-500',
  'report-thinking': 'whitespace-pre-wrap text-xs italic text-slate-500',
  bookkeeper: 'whitespace-pre-wrap text-xs text-amber-200',
  judge: 'whitespace-pre-wrap text-xs text-emerald-200',
  game: 'text-xs font-semibold text-slate-300',
  log: 'font-mono text-xs text-slate-400',
  step: 'text-sm',
  state: 'text-xs text-slate-400',
  done: 'text-sm font-semibold text-slate-200',
};

export function WatchPanel({ stream, onClose }: { stream: string; onClose: () => void }) {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    api<LiveEvent[]>(`/api/trainer/live/${encodeURIComponent(stream)}`, { quiet: true })
      .then(setEvents)
      .catch(() => {});
    const s = getSocket();
    const on = (e: LiveEvent) => e.stream === stream && setEvents((l) => [...l, e]);
    s.on('trainer:live', on);
    return () => void s.off('trainer:live', on);
  }, [stream]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [events.length]);
  const kind = stream.split(':')[0];
  const counters = events.filter((e) => e.type === 'counters');
  const latest: Board[] = Object.values(Object.fromEntries(counters.map((c) => [c.data.model as string, c.data as Board])));
  const loss = events.filter((e) => e.type === 'loss' && typeof e.data?.loss === 'number').map((e) => e.data);
  const sample = events.filter((e) => e.type === 'sample').at(-1)?.data;
  const steps = events.filter((e) => e.type === 'step');
  const reportMd = events.filter((e) => e.type === 'report-token').map((e) => e.text).join('');
  const title = kind === 'sim' ? 'Watch the AI: simulation' : kind === 'train' ? 'Watch the AI: training' : kind === 'report' ? 'Watch the AI: report' : 'Watch the AI: nightly';
  return (
    <Modal title={title} wide onClose={onClose}>
      <div className="space-y-2">
        {kind === 'sim' && <Scoreboard rows={latest} />}
        {kind === 'train' && (
          <>
            <LossChart points={loss} />
            {loss.length > 0 && (
              <p className="text-xs text-slate-400">
                Step {loss.at(-1).step}/{loss.at(-1).total ?? '?'}
                {loss.at(-1).eta !== undefined && ` · about ${Math.round(Number(loss.at(-1).eta) / 60)} min left`}
              </p>
            )}
            {sample && (
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <span className="label">Before</span>
                  <pre className="whitespace-pre-wrap text-xs">{String(sample.before ?? '')}</pre>
                </div>
                <div>
                  <span className="label">After</span>
                  <pre className="whitespace-pre-wrap text-xs">{String(sample.after ?? sample.text ?? '')}</pre>
                </div>
              </div>
            )}
          </>
        )}
        {kind === 'nightly' && (
          <ol className="flex flex-wrap gap-2 text-xs">
            {['push', 'train', 'eval', 'decision'].map((st) => {
              const last = steps.filter((x) => x.data?.step === st).at(-1);
              return (
                <li key={st} className={`chip ${last ? 'border-indigo-500 text-indigo-200' : ''}`}>
                  {st}
                  {last?.data?.jobId && (
                    <button className="ml-1 underline" onClick={() => window.dispatchEvent(new CustomEvent('dm-watch', { detail: `train:${last.data.jobId}` }))}>
                      watch
                    </button>
                  )}
                  {last?.data?.simId && (
                    <button className="ml-1 underline" onClick={() => window.dispatchEvent(new CustomEvent('dm-watch', { detail: `sim:${last.data.simId}` }))}>
                      watch
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {kind === 'report' && reportMd && <Markdown text={reportMd} className="rounded-md border border-[#30363d] p-2" />}
        <div className="scroll-thin max-h-[50vh] space-y-1.5 overflow-y-auto rounded-md bg-[#0d1117] p-2">
          {blocks(events.filter((e) => e.type !== 'counters' && e.type !== 'loss' && e.type !== 'sample' && e.type !== 'report-token')).map((b, i) => (
            <div key={i} className={STYLE[b.type] ?? 'text-xs text-slate-300'}>
              {b.type === 'dm-thinking' || b.type === 'judge-thinking' || b.type === 'report-thinking' ? `💭 ${b.text}` : b.type === 'judge' ? `⚖ ${b.text}${b.data?.story ? ` (story ${b.data.story}/10)` : ''}` : b.text}
            </div>
          ))}
          {!events.length && <p className="text-sm text-slate-500">Nothing yet. This panel fills in as the AI works.</p>}
          <div ref={end} />
        </div>
      </div>
    </Modal>
  );
}

export function TrainerPage() {
  const [status, setStatus] = useState<Status>();
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [sims, setSims] = useState<Sim[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [watching, setWatching] = useState<string>();
  const loadStatus = () => api<Status>('/api/trainer/status').then(setStatus);
  const loadScenarios = () => api<Scenario[]>('/api/trainer/scenarios').then(setScenarios);
  const loadSims = () => api<Sim[]>('/api/trainer/sims').then(setSims);
  useEffect(() => {
    loadStatus();
    loadScenarios();
    loadSims();
    const on = (e: Event) => setWatching((e as CustomEvent<string>).detail);
    addEventListener('dm-watch', on);
    return () => removeEventListener('dm-watch', on);
  }, []);
  // Live counters while a run is going.
  useEffect(() => {
    if (!sims.some((x) => x.status === 'running')) return;
    const t = setTimeout(loadSims, 2000);
    return () => clearTimeout(t);
  }, [sims]);
  if (!status) return <p className="text-sm text-slate-400">Loading the AI Trainer…</p>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">Teach the AI Dungeon Master from real games and simulated ones. Training itself runs in HiveMind, at night, inside its training window.</p>
      <StatusSection s={status} reload={loadStatus} watch={setWatching} />
      <ScenariosSection list={scenarios} reload={loadScenarios} />
      <SimulateSection s={status} scenarios={scenarios} sims={sims} reload={loadSims} watch={setWatching} picked={picked} setPicked={setPicked} />
      <ReviewSection counts={status.records} />
      <ReportSection picked={picked} watch={setWatching} />
      <section className="card space-y-2">
        <h2 className="rune-title">DM model</h2>
        <DmModelPicker onDone={loadStatus} />
      </section>
      {watching && <WatchPanel stream={watching} onClose={() => setWatching(undefined)} />}
    </div>
  );
}
