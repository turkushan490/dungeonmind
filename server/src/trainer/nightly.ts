import type { FastifyRequest } from 'fastify';
import { decrypt, encrypt, newId, randomToken, sha256 } from '../crypto.js';
import { db, getSetting, json, setSetting } from '../db.js';
import {
  addDatasetItems,
  ensureDataset,
  followSse,
  hasFeature,
  HiveMindError,
  hivemindSettings,
  putCanvas,
  putSchedule,
  startTraining,
  trainJob,
  type CanvasFile,
  type ModelRef,
  type TrainJob,
} from '../hivemind.js';
import { setDmModel } from '../api/hivemind.js';
import { everyDay } from '../jobs.js';
import { live } from './live.js';
import { toExample, toRecord } from './records.js';
import { startReport } from './report.js';
import { EVAL_SCENARIOS, modelKey, scoreboard, startSim, type Scoreboard } from './sim.js';

/**
 * M9 §6: the nightly pipeline. 02:45 DungeonMind pushes new good and accepted records to the HiveMind dataset
 * "DungeonMind DM"; 03:00 HiveMind's workflow dnd-nightly trains (in its training window) and posts the result to
 * /api/trainer/candidate; DungeonMind then runs the eval sim (candidate vs current) and promotes only a better model.
 */
export const DATASET = 'DungeonMind DM';
export const WORKFLOW = 'dnd-nightly';
export const MODEL_NAME = 'dungeonmind-dm';
export const DEFAULT_BASE = 'unsloth/Qwen3-8B';
export const PUSH_TIME = '02:45';
export const TRAIN_TIME = '03:00';
const NIGHTLY = 'nightly';

export interface TrainerSettings {
  nightly: boolean;
  base: string;
  /** Where HiveMind posts the candidate (defaults to the URL the admin uses). */
  callbackUrl: string;
  /** Share of unflagged sim turns the judge checks too. */
  judgeSample: number;
}

export function trainerSettings(): TrainerSettings {
  const s = json<Partial<TrainerSettings>>(getSetting('trainer.settings'), {});
  return { nightly: s.nightly ?? false, base: s.base || DEFAULT_BASE, callbackUrl: s.callbackUrl ?? '', judgeSample: s.judgeSample ?? 0.2 };
}

export function saveTrainerSettings(patch: Partial<TrainerSettings>): TrainerSettings {
  const cur = trainerSettings();
  const next: TrainerSettings = {
    nightly: patch.nightly !== undefined ? !!patch.nightly : cur.nightly,
    base: typeof patch.base === 'string' && patch.base.trim() ? patch.base.trim().slice(0, 200) : cur.base,
    callbackUrl: typeof patch.callbackUrl === 'string' ? patch.callbackUrl.trim().replace(/\/+$/, '').slice(0, 300) : cur.callbackUrl,
    judgeSample: patch.judgeSample !== undefined && Number.isFinite(Number(patch.judgeSample)) ? Math.max(0, Math.min(1, Number(patch.judgeSample))) : cur.judgeSample,
  };
  setSetting('trainer.settings', JSON.stringify(next));
  return next;
}

/** The URL the browser uses, remembered as the callback default. */
export const originOf = (req: FastifyRequest) => `${req.protocol}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;

const needs = async (f: Parameters<typeof hasFeature>[0]) => {
  if (!(await hasFeature(f))) throw new HiveMindError(`HiveMind needs updating (${f})`, 409, false);
};

// ---- 02:45: the dataset push ----
let pushing: Promise<{ pushed: number; datasetId: string }> | undefined;

/** Pushes good and accepted records that weren't pushed yet. Each record goes once (pushed_at). */
export function pushDataset() {
  pushing ??= doPush().finally(() => (pushing = undefined));
  return pushing;
}

async function doPush() {
  await needs('scopedTraining');
  const ds = await ensureDataset(DATASET);
  setSetting('trainer.datasetId', ds.id);
  const rows = db
    .prepare("SELECT r.*, g.ruleset FROM lab_records r JOIN games g ON g.id = r.game_id WHERE r.label IN ('good', 'accepted') AND r.source != 'eval' AND r.pushed_at IS NULL ORDER BY r.id LIMIT 20000")
    .all() as Record<string, any>[];
  let pushed = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await addDatasetItems(
      ds.id,
      chunk.map((r) => {
        const rec = toRecord(r, r.ruleset);
        return { ...toExample(rec), meta: { recordId: rec.id, canvas: rec.canvas, node: rec.node, source: rec.source, label: rec.label } };
      }),
    );
    const mark = db.prepare("UPDATE lab_records SET pushed_at = datetime('now') WHERE id = ?");
    for (const r of chunk) mark.run(r.id);
    pushed += chunk.length;
  }
  live(NIGHTLY, 'step', `push: ${pushed} new example${pushed === 1 ? '' : 's'} to "${DATASET}"`, { step: 'push', pushed });
  return { pushed, datasetId: ds.id };
}

// ---- The dnd-nightly workflow in HiveMind ----
/** The dm_ token HiveMind's HTTP block authenticates with; created once (for the admin who installs). */
function trainerToken(userId: string): string {
  const enc = getSetting('trainer.token');
  if (enc) {
    try {
      const token = decrypt(enc);
      if (db.prepare('SELECT 1 FROM api_tokens WHERE token_hash = ?').get(sha256(token))) return token;
    } catch {
      // Unreadable (new secret key): make a new one.
    }
  }
  const token = `dm_${randomToken(24)}`;
  db.prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, prefix) VALUES (?, ?, ?, ?, ?)').run(newId(), userId, 'AI Trainer (HiveMind nightly)', sha256(token), token.slice(0, 7));
  setSetting('trainer.token', encrypt(token));
  return token;
}

export function nightlyWorkflow(callback: string, token: string, s: TrainerSettings): CanvasFile {
  return {
    id: WORKFLOW,
    name: 'DungeonMind: nightly training',
    description: 'Trains the DungeonMind DM on new examples, then hands the result to DungeonMind, which tests it and promotes it only when it is better.',
    nodes: [
      { id: 'in', type: 'input', label: 'input', config: {} },
      {
        id: 'train',
        type: 'train',
        label: 'train',
        config: { dataset: DATASET, datasetId: getSetting('trainer.datasetId'), base: s.base, name: MODEL_NAME, minNewExamples: 100, nightly: true, wait: true },
      },
      {
        id: 'candidate',
        type: 'http',
        label: 'candidate',
        config: { method: 'POST', url: `${callback}/api/trainer/candidate`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{{inputs}}' },
      },
    ],
    edges: [
      { id: 'in-train', source: 'in', target: 'train' },
      { id: 'train-candidate', source: 'train', target: 'candidate' },
    ],
  };
}

/** Installs dnd-nightly with its 03:00 schedule (on install, and whenever the Trainer's settings change). */
export async function installNightly(userId: string, origin?: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await hasFeature('schedules'))) return { ok: false, error: 'HiveMind needs updating (schedules)' };
  if (origin && !getSetting('trainer.publicUrl')) setSetting('trainer.publicUrl', origin);
  const s = trainerSettings();
  const callback = s.callbackUrl || getSetting('trainer.publicUrl') || origin;
  if (!callback) return { ok: false, error: 'Set the callback URL (AI Trainer → Status)' };
  await putCanvas(nightlyWorkflow(callback, trainerToken(userId), s));
  await putSchedule(WORKFLOW, { time: TRAIN_TIME, days: [0, 1, 2, 3, 4, 5, 6], enabled: s.nightly });
  return { ok: true };
}

// ---- Training, live ----
/** Follows a HiveMind training job to its end, relaying loss, step/ETA, log lines and the sample to "Watch the AI". */
export async function followTraining(jobId: string): Promise<TrainJob> {
  const stream = `train:${jobId}`;
  const final = ['done', 'error', 'failed', 'cancelled', 'canceled', 'skipped'];
  if (await hasFeature('trainEvents')) {
    let last: Record<string, any> = {};
    await followSse(`/api/lab/train/${encodeURIComponent(jobId)}/events`, AbortSignal.timeout(24 * 3600_000), (_event, data) => {
      const ev = json<Record<string, any>>(data, {});
      last = { ...last, ...ev };
      if (ev.loss !== undefined || ev.step !== undefined) live(stream, 'loss', undefined, { step: ev.step, total: ev.total, loss: ev.loss, eta: ev.eta });
      if (ev.log ?? ev.line) live(stream, 'log', String(ev.log ?? ev.line));
      if (ev.sample) live(stream, 'sample', undefined, ev.sample);
      if (ev.state) live(stream, 'state', String(ev.state));
    }).catch((err) => live(stream, 'log', `Lost the training stream: ${(err as Error).message}`));
    if (final.includes(String(last.state))) {
      live(stream, 'done', String(last.state));
      return { ...(await trainJob(jobId).catch(() => ({}) as TrainJob)), ...last, id: jobId, state: String(last.state) } as TrainJob;
    }
  }
  // No live stream: ask every 15 s.
  for (let i = 0; i < 24 * 240; i++) {
    const job = await trainJob(jobId).catch(() => undefined);
    if (job && final.includes(job.state)) {
      live(stream, 'done', job.state);
      return job;
    }
    if (job) live(stream, 'state', job.state, job);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return { id: jobId, state: 'error', error: 'Training took more than a day' };
}

/** "Train now": the same pipeline right away (HiveMind still applies its training window). */
export async function trainNow(userId: string): Promise<{ jobId: string; pushed: number }> {
  await needs('scopedTraining');
  live(NIGHTLY, 'step', 'Train now: pushing new examples…', { step: 'push' });
  const { pushed, datasetId } = await pushDataset();
  const s = trainerSettings();
  const job = await startTraining({ base: s.base, name: MODEL_NAME, providerId: hivemindSettings().models.story?.providerId, datasetId, nightly: false, allowSmall: true });
  live(NIGHTLY, 'step', `train: job ${job.id} started (base ${s.base})`, { step: 'train', jobId: job.id });
  void followTraining(job.id)
    .then((done) => handleCandidate({ status: done.state === 'done' ? 'done' : 'skipped', model: done.model, jobId: job.id, error: done.error }, userId))
    .catch((err) => live(NIGHTLY, 'step', `train failed: ${(err as Error).message}`, { step: 'train' }));
  return { jobId: job.id, pushed };
}

// ---- The candidate: eval, then decide ----
export interface CandidateInput {
  status?: string;
  model?: string;
  jobId?: string;
  examples?: number;
  error?: string;
}

/** Promote ONLY when the candidate makes fewer errors/100 AND its JSON valid % is not lower. */
export function decide(cand: Scoreboard, cur: Scoreboard): { promote: boolean; reason: string } {
  if (cand.errorsPer100 >= cur.errorsPer100) return { promote: false, reason: `it made ${cand.errorsPer100} errors/100, not fewer than the current ${cur.errorsPer100}` };
  if (cand.jsonValid < cur.jsonValid) return { promote: false, reason: `its JSON was valid ${cand.jsonValid}% of the time, lower than the current ${cur.jsonValid}%` };
  return { promote: true, reason: `${cand.errorsPer100} vs ${cur.errorsPer100} errors/100, JSON valid ${cand.jsonValid}% vs ${cur.jsonValid}%` };
}

export interface NightlyResult {
  status: string;
  examples?: number;
  model?: string;
  candidate?: Scoreboard;
  current?: Scoreboard;
  promoted: boolean;
  reason: string;
  simId?: string;
  reportId?: string;
}

const saveResult = (r: NightlyResult) => {
  db.prepare('INSERT INTO trainer_results (data) VALUES (?)').run(JSON.stringify(r));
  live(NIGHTLY, 'step', `decision: ${r.promoted ? `${r.model} is now your DM` : `kept the old DM: ${r.reason}`}`, { step: 'decision', result: r });
  live(NIGHTLY, 'done', r.reason);
  return r;
};

export async function handleCandidate(input: CandidateInput, userId: string): Promise<NightlyResult> {
  const examples = typeof input.examples === 'number' ? input.examples : undefined;
  if (input.status !== 'done' || !input.model) {
    const reason = input.status === 'skipped' ? `there were not enough new examples${examples !== undefined ? ` (${examples})` : ''}` : `training did not finish (${input.error ?? input.status ?? 'unknown'})`;
    return saveResult({ status: input.status ?? 'unknown', examples, promoted: false, reason });
  }
  const current = hivemindSettings().models.story;
  const cand: ModelRef = { providerId: current?.providerId ?? 'ollama', model: input.model };
  if (!(await hasFeature('modelOverride'))) return saveResult({ status: 'done', examples, model: cand.model, promoted: false, reason: 'HiveMind needs updating (modelOverride) to compare the models' });
  live(NIGHTLY, 'step', `eval: ${cand.model} against ${current?.model ?? 'the current canvases'}, 2 games × 10 turns`, { step: 'eval' });
  const sim = startSim(userId, { models: current ? [cand, current] : [cand], includeCurrent: !current, games: 2, turns: 10, scenarioIds: [], scenarios: EVAL_SCENARIOS, judgeSample: trainerSettings().judgeSample }, 'eval');
  live(NIGHTLY, 'step', `eval: simulation ${sim.id}`, { step: 'eval', simId: sim.id });
  const stats = await sim.done;
  const c = scoreboard(modelKey(cand), stats[modelKey(cand)]);
  const k = scoreboard(modelKey(current), stats[modelKey(current)]);
  const d = decide(c, k);
  if (d.promote) await setDmModel(cand.providerId, cand.model);
  const reportId = startReport([sim.id], `Nightly: ${cand.model} (${d.promote ? 'promoted' : 'kept the old DM'})`).id;
  return saveResult({ status: 'done', examples, model: cand.model, candidate: c, current: k, promoted: d.promote, reason: d.reason, simId: sim.id, reportId });
}

export const lastResults = (limit = 20) =>
  (db.prepare('SELECT id, data, at FROM trainer_results ORDER BY id DESC LIMIT ?').all(limit) as Record<string, any>[]).map((r) => ({ id: r.id, at: r.at, ...json<NightlyResult>(r.data, {} as NightlyResult) }));

let registered = false;
/** 02:45 push while nightly training is on. */
export function registerNightly() {
  if (registered) return;
  registered = true;
  everyDay('trainer-push', () => (trainerSettings().nightly ? PUSH_TIME : undefined), () => pushDataset());
}
