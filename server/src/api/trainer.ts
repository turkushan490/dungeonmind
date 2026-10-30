import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth/index.js';
import { newId } from '../crypto.js';
import { db, json } from '../db.js';
import { currentCampaign, parseSections } from '../game/campaign.js';
import { clip } from '../game/text.js';
import {
  findDataset,
  getSchedule,
  health,
  HiveMindError,
  hivemindSettings,
  listModels,
  outputJson,
  runCanvas,
  TRAINER_FEATURES,
  trainingWindow,
  withRetry,
  type ModelRef,
} from '../hivemind.js';
import { background } from '../jobs.js';
import { liveBacklog, liveStreams } from '../trainer/live.js';
import { DATASET, handleCandidate, installNightly, lastResults, originOf, saveTrainerSettings, TRAIN_TIME, trainerSettings, trainNow, WORKFLOW, type CandidateInput } from '../trainer/nightly.js';
import { toRecord, turnSignals, type Label } from '../trainer/records.js';
import { startReport } from '../trainer/report.js';
import { allSimStats, deleteSim, isRunning, scoreboard, simRow, startSim, stopSim, type ModelStats, type SimSettings } from '../trainer/sim.js';

/** The curated DM models the picker always offers (M9 §3 DM model). */
export const CURATED_MODELS = [
  { model: 'hf.co/LatitudeGames/Wayfarer-2-12B-GGUF:Q4_K_M', name: 'Wayfarer 2 12B', match: /^hf\.co\/LatitudeGames\/Wayfarer-2-12B-GGUF:Q4_K_M$/i },
  { model: 'qwen3:8b', name: 'Qwen3 8B', match: /^qwen3[:-]8b/i },
  { model: 'qwen3.5:9b', name: 'Qwen3.5 9B', match: /^qwen3\.5[:-]9b/i },
];

const int = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

const simOut = (r: Record<string, any>) => {
  const results = json<Record<string, ModelStats>>(r.results, {});
  const settings = json<SimSettings>(r.settings, {} as SimSettings);
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    error: r.error ?? undefined,
    createdAt: r.created_at,
    finishedAt: r.finished_at ?? undefined,
    settings: { models: settings.models, games: settings.games, turns: settings.turns, scenarioIds: settings.scenarioIds },
    scoreboard: Object.entries(results).map(([k, v]) => scoreboard(k, v)),
  };
};

const scenarioOut = (r: Record<string, any>) => ({ id: r.id, text: r.text, source: r.source, gameId: r.game_id ?? undefined, turn: r.turn ?? undefined, createdAt: r.created_at });
const addScenario = (text: string, source: string, gameId?: string) => {
  const id = newId();
  db.prepare('INSERT INTO trainer_scenarios (id, text, source, game_id) VALUES (?, ?, ?, ?)').run(id, clip(text.trim(), 2000), source, gameId ?? null);
  return scenarioOut(db.prepare('SELECT * FROM trainer_scenarios WHERE id = ?').get(id) as Record<string, any>);
};

const LABELS: Label[] = ['good', 'bad', 'pending', 'accepted', 'rejected'];

export function trainerRoutes(app: FastifyInstance) {
  // ---- Status ----
  app.get('/api/trainer/status', { preHandler: requireAdmin }, async () => {
    const h = await health();
    const features = Object.fromEntries(TRAINER_FEATURES.map((f) => [f, h.features.includes(f)])) as Record<(typeof TRAINER_FEATURES)[number], boolean>;
    const settings = trainerSettings();
    const [schedule, window, dataset] = await Promise.all([
      features.schedules ? getSchedule(WORKFLOW).catch(() => undefined) : undefined,
      features.trainingWindow ? trainingWindow().catch(() => undefined) : undefined,
      features.scopedTraining ? findDataset(DATASET).catch(() => undefined) : undefined,
    ]);
    const counts = Object.fromEntries((db.prepare('SELECT label, COUNT(*) AS n FROM lab_records GROUP BY label').all() as { label: string; n: number }[]).map((r) => [r.label, r.n]));
    const pushed = (db.prepare('SELECT COUNT(*) AS n FROM lab_records WHERE pushed_at IS NOT NULL').get() as { n: number }).n;
    const waiting = (db.prepare("SELECT COUNT(*) AS n FROM lab_records WHERE label IN ('good', 'accepted') AND source != 'eval' AND pushed_at IS NULL").get() as { n: number }).n;
    return {
      hivemind: { ok: h.ok, error: h.error },
      features,
      dmModel: hivemindSettings().models.story ?? null,
      settings,
      callbackUrl: settings.callbackUrl || (db.prepare("SELECT value FROM settings WHERE key = 'trainer.publicUrl'").get() as { value: string } | undefined)?.value || '',
      last: lastResults(1)[0] ?? null,
      results: lastResults(14),
      nextRun: settings.nightly ? (schedule?.nextRun ?? TRAIN_TIME) : null,
      schedule: schedule ?? null,
      window: window ?? null,
      dataset: { name: DATASET, size: dataset?.count ?? null, pushed, waiting },
      records: counts,
      live: liveStreams(),
    };
  });

  app.put('/api/trainer/settings', { preHandler: requireAdmin }, async (req) => {
    const settings = saveTrainerSettings((req.body ?? {}) as Record<string, any>);
    // The workflow carries the base model, the callback and the schedule: reinstall it.
    const nightly = await installNightly(req.user!.id, originOf(req)).catch((err) => ({ ok: false, error: (err as Error).message }));
    return { settings, nightly };
  });

  app.post('/api/trainer/train-now', { preHandler: requireAdmin }, async (req, reply) => background(req, reply, () => trainNow(req.user!.id)));

  /** HiveMind's dnd-nightly HTTP block posts the Train block's output here (with the Trainer's dm_ token). */
  app.post('/api/trainer/candidate', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as CandidateInput & { output?: CandidateInput };
    const input = body.output ?? body;
    void handleCandidate(input, req.user!.id).catch((err) => req.log.error(err));
    return reply.code(202).send({ ok: true });
  });

  // ---- Scenarios ----
  app.get('/api/trainer/scenarios', { preHandler: requireAdmin }, async () => (db.prepare('SELECT * FROM trainer_scenarios ORDER BY created_at, rowid').all() as Record<string, any>[]).map(scenarioOut));

  app.post('/api/trainer/scenarios', { preHandler: requireAdmin }, async (req, reply) => {
    const text = String((req.body as { text?: string })?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'Write the scenario' });
    return addScenario(text, 'manual');
  });

  app.put('/api/trainer/scenarios/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const text = String((req.body as { text?: string })?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'Write the scenario' });
    const r = db.prepare('UPDATE trainer_scenarios SET text = ? WHERE id = ?').run(clip(text, 2000), (req.params as { id: string }).id);
    if (!r.changes) return reply.code(404).send({ error: 'No such scenario' });
    return { ok: true };
  });

  app.delete('/api/trainer/scenarios/:id', { preHandler: requireAdmin }, async (req) => {
    db.prepare('DELETE FROM trainer_scenarios WHERE id = ?').run((req.params as { id: string }).id);
    return { ok: true };
  });

  /** One scenario per line. */
  app.post('/api/trainer/scenarios/bulk', { preHandler: requireAdmin }, async (req, reply) => {
    const lines = String((req.body as { text?: string })?.text ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 500);
    if (!lines.length) return reply.code(400).send({ error: 'Write one scenario per line' });
    return lines.map((l) => addScenario(l, 'manual'));
  });

  /** "Write 20 with AI" from a theme (the dnd-scenarios canvas). */
  app.post('/api/trainer/scenarios/ai', { preHandler: requireAdmin }, async (req, reply) => {
    const theme = String((req.body as { theme?: string })?.theme ?? '').trim().slice(0, 500);
    if (!theme) return reply.code(400).send({ error: 'Give a theme, e.g. "goblin ambushes in the woods"' });
    const count = int((req.body as { count?: number })?.count, 1, 50, 20);
    return background(req, reply, async () => {
      const r = await withRetry(() => runCanvas('dnd-scenarios', theme, { vars: { count: String(count) } }));
      const list = (outputJson<{ scenarios?: unknown[] }>(r, 'scenarios').scenarios ?? []).map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, count);
      if (!list.length) throw new HiveMindError('The AI wrote no scenarios; try again');
      return list.map((s) => addScenario(s, 'ai'));
    });
  });

  /** Real games to take a scenario from. */
  app.get('/api/trainer/games', { preHandler: requireAdmin }, async () =>
    db.prepare("SELECT id, name, status, updated_at AS updatedAt FROM games WHERE sim = 0 AND status != 'setup' AND id IN (SELECT game_id FROM campaign_versions) ORDER BY updated_at DESC LIMIT 200").all(),
  );

  /** "From a campaign": the game's current campaign.md situation becomes a scenario. */
  app.post('/api/trainer/scenarios/from-game', { preHandler: requireAdmin }, async (req, reply) => {
    const gameId = String((req.body as { gameId?: string })?.gameId ?? '');
    if (!db.prepare('SELECT 1 FROM games WHERE id = ? AND sim = 0').get(gameId)) return reply.code(404).send({ error: 'Game not found' });
    const md = currentCampaign(gameId);
    const scene = parseSections(md)['Current scene'];
    if (!scene?.trim()) return reply.code(400).send({ error: 'That campaign has no current scene yet' });
    return addScenario(scene, 'campaign', gameId);
  });

  // ---- Simulate ----
  app.get('/api/trainer/sims', { preHandler: requireAdmin }, async () => (db.prepare('SELECT * FROM trainer_sims ORDER BY created_at DESC, rowid DESC LIMIT 100').all() as Record<string, any>[]).map(simOut));

  app.post('/api/trainer/sims', { preHandler: requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { models?: ModelRef[]; games?: number; turns?: number; scenarioIds?: string[] };
    const models = (Array.isArray(b.models) ? b.models : []).filter((m) => m?.providerId && m?.model).slice(0, 4).map((m) => ({ providerId: String(m.providerId), model: String(m.model) }));
    if (models.length && !(await health()).features.includes('modelOverride')) return reply.code(409).send({ error: 'HiveMind needs updating to compare models (modelOverride). Leave the models empty to test the current DM.' });
    const settings: SimSettings = {
      models,
      games: int(b.games, 1, 10, 1),
      turns: int(b.turns, 1, 30, 5),
      scenarioIds: (Array.isArray(b.scenarioIds) ? b.scenarioIds : []).map(String).slice(0, 200),
      judgeSample: trainerSettings().judgeSample,
    };
    const { id } = startSim(req.user!.id, settings);
    return { id };
  });

  app.get('/api/trainer/sims/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const r = simRow((req.params as { id: string }).id);
    return r ? simOut(r) : reply.code(404).send({ error: 'No such run' });
  });

  app.post('/api/trainer/sims/:id/stop', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isRunning(id)) return reply.code(400).send({ error: 'That run is not running' });
    stopSim(id);
    return { ok: true };
  });

  app.delete('/api/trainer/sims/:id', { preHandler: requireAdmin }, async (req) => {
    deleteSim((req.params as { id: string }).id);
    return { ok: true };
  });

  // ---- Review ----
  app.get('/api/trainer/records', { preHandler: requireAdmin }, async (req) => {
    const q = req.query as { label?: string; source?: string; limit?: string; offset?: string };
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.label && LABELS.includes(q.label as Label)) (where.push('r.label = ?'), args.push(q.label));
    if (q.source && ['game', 'sim', 'eval'].includes(q.source)) (where.push('r.source = ?'), args.push(q.source));
    const rows = db
      .prepare(`SELECT r.*, g.ruleset, g.name AS game FROM lab_records r JOIN games g ON g.id = r.game_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.id DESC LIMIT ? OFFSET ?`)
      .all(...args, int(q.limit, 1, 200, 50), int(q.offset, 0, 1_000_000, 0)) as Record<string, any>[];
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM lab_records r ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).get(...args) as { n: number }).n;
    return {
      total,
      records: rows.map((r) => {
        const rec = toRecord(r, r.ruleset);
        return { ...rec, game: r.game, question: clip(r.question ?? '', 2000), reasons: [...rec.signals, ...turnSignals(rec.gameId, rec.turn)] };
      }),
    };
  });

  /** Accept the judge's correction, edit it, or reject the record. */
  app.put('/api/trainer/records/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { action?: string; corrected?: string };
    const row = db.prepare('SELECT corrected FROM lab_records WHERE id = ?').get(id) as { corrected: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: 'No such record' });
    if (b.action === 'reject') db.prepare("UPDATE lab_records SET label = 'rejected' WHERE id = ?").run(id);
    else if (b.action === 'accept' || b.action === 'edit') {
      const corrected = b.action === 'edit' ? String(b.corrected ?? '').slice(0, 200_000) : row.corrected;
      if (!corrected?.trim()) return reply.code(400).send({ error: b.action === 'edit' ? 'Write the corrected answer' : 'There is no correction to accept: edit it' });
      db.prepare("UPDATE lab_records SET label = 'accepted', corrected = ? WHERE id = ?").run(corrected, id);
    } else return reply.code(400).send({ error: 'action is accept, edit or reject' });
    return { ok: true };
  });

  app.delete('/api/trainer/records/:id', { preHandler: requireAdmin }, async (req) => {
    db.prepare('DELETE FROM lab_records WHERE id = ?').run(Number((req.params as { id: string }).id));
    return { ok: true };
  });

  // ---- Report ----
  app.get('/api/trainer/reports', { preHandler: requireAdmin }, async () =>
    (db.prepare('SELECT id, title, status, error, sim_ids, created_at, length(md) AS size FROM trainer_reports ORDER BY created_at DESC, rowid DESC').all() as Record<string, any>[]).map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      error: r.error ?? undefined,
      simIds: json<string[]>(r.sim_ids, []),
      createdAt: r.created_at,
      size: r.size,
    })),
  );

  app.post('/api/trainer/reports', { preHandler: requireAdmin }, async (req) => {
    const simIds = ((req.body as { simIds?: string[] })?.simIds ?? []).map(String).slice(0, 50);
    return { id: startReport(simIds).id };
  });

  app.get('/api/trainer/reports/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const r = db.prepare('SELECT * FROM trainer_reports WHERE id = ?').get((req.params as { id: string }).id) as Record<string, any> | undefined;
    if (!r) return reply.code(404).send({ error: 'No such report' });
    return { id: r.id, title: r.title, status: r.status, error: r.error ?? undefined, md: r.md, createdAt: r.created_at };
  });

  app.get('/api/trainer/reports/:id/download', { preHandler: requireAdmin }, async (req, reply) => {
    const r = db.prepare('SELECT md, created_at FROM trainer_reports WHERE id = ?').get((req.params as { id: string }).id) as { md: string; created_at: string } | undefined;
    if (!r) return reply.code(404).send({ error: 'No such report' });
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="dungeonmind-report-${r.created_at.slice(0, 10)}.md"`);
    return r.md;
  });

  app.delete('/api/trainer/reports/:id', { preHandler: requireAdmin }, async (req) => {
    db.prepare('DELETE FROM trainer_reports WHERE id = ?').run((req.params as { id: string }).id);
    return { ok: true };
  });

  // ---- DM model: the restricted picker ----
  app.get('/api/trainer/dm-models', { preHandler: requireAdmin }, async () => {
    const available = await listModels().catch(() => []);
    const ollama = available.find((m) => /ollama/i.test(m.providerId))?.providerId ?? available[0]?.providerId ?? 'ollama';
    const options: { providerId: string; model: string; why: 'trained' | 'curated' | 'tested'; label: string; installed: boolean; jsonValid?: number; turns?: number }[] = [];
    const add = (o: (typeof options)[number]) => !options.some((x) => x.model === o.model && x.providerId === o.providerId) && options.push(o);
    for (const m of available) if (/dungeonmind-/i.test(m.model)) add({ ...m, why: 'trained', label: `${m.model} (trained here)`, installed: true });
    for (const c of CURATED_MODELS) {
      const have = available.find((m) => c.match.test(m.model));
      add({ providerId: have?.providerId ?? ollama, model: have?.model ?? c.model, why: 'curated', label: c.name, installed: !!have });
    }
    for (const [key, s] of Object.entries(allSimStats())) {
      const valid = s.jsonTotal ? (s.jsonOk / s.jsonTotal) * 100 : 0;
      if (key === 'current' || s.turns < 20 || valid < 90) continue;
      const i = key.indexOf('/');
      const m = { providerId: key.slice(0, i), model: key.slice(i + 1) };
      add({ ...m, why: 'tested', label: `${m.model} (${Math.round(valid)}% JSON valid over ${s.turns} sim turns)`, installed: available.some((a) => a.providerId === m.providerId && a.model === m.model), jsonValid: Math.round(valid), turns: s.turns });
    }
    return { current: hivemindSettings().models.story ?? null, options };
  });

  // ---- Watch the AI ----
  app.get('/api/trainer/live', { preHandler: requireAdmin }, async () => liveStreams());
  app.get('/api/trainer/live/:stream', { preHandler: requireAdmin }, async (req) => liveBacklog((req.params as { stream: string }).stream));
}

