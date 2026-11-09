import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from './auth/index.js';
import { newId } from './crypto.js';
import { getSetting, setSetting } from './db.js';
import { CancelledError, HiveMindError } from './hivemind.js';
import { logProblem } from './problems.js';

/**
 * Slow AI work (pitches, setup form, AI sheets, portraits) runs as a background job: the request answers
 * 202 {jobId} at once and the browser polls GET /api/jobs/:id. A local model on a busy GPU can take minutes,
 * longer than a reverse proxy's read timeout (60 s in Nginx Proxy Manager), which used to show up as HTTP 504.
 *
 * Cancel: DELETE /api/jobs/:id aborts the AbortSignal the work gets. The work passes it to runCanvas/withRetry
 * (which stop the HiveMind run and don't retry) and checks it (stopIfCancelled) right before it saves, so a
 * cancelled job never changes anything. The browser may pick the job id itself (header x-job-id), so it can
 * cancel even before the 202 reaches it; a cancel that arrives first leaves a tombstone and the job never starts.
 * The HTTP connection closing is not used: the 202 is sent at once, and proxies and CapacitorHttp don't pass
 * an aborted fetch on reliably.
 */
interface Job {
  userId: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  result?: unknown;
  error?: string;
  at: number;
  stop?: AbortController;
}

const jobs = new Map<string, Job>();
const KEEP_MS = 60 * 60_000;

/** Plain-language version of the HiveMind errors people actually hit. */
export function friendlyError(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  if (/model .* not found/i.test(msg)) return `The DM model isn't available in HiveMind/Ollama. Check the model on the DungeonMind canvases in HiveMind. (${msg})`;
  if (/out of memory|cudaMalloc|unable to allocate/i.test(msg)) return `The GPU is full (another model or ComfyUI is using it). Try again in a moment. (${msg})`;
  return msg;
}

const CLIENT_ID = /^[A-Za-z0-9_-]{16,64}$/;

function sweep(now = Date.now()) {
  for (const [id, j] of jobs) if (j.status !== 'running' && now - j.at > KEEP_MS) jobs.delete(id);
}

/**
 * Runs `work` as a job and answers 202 {jobId}. `work` gets an AbortSignal that fires when the job is cancelled:
 * pass it to runCanvas/withRetry and call stopIfCancelled(signal) right before saving.
 */
export function background(req: FastifyRequest, reply: FastifyReply, work: (signal: AbortSignal) => Promise<unknown>) {
  const now = Date.now();
  sweep(now);
  const userId = req.user!.id;
  const asked = String(req.headers['x-job-id'] ?? '');
  const earlier = CLIENT_ID.test(asked) ? jobs.get(asked) : undefined;
  // Cancelled before it got here: don't start it.
  if (earlier?.userId === userId && earlier.status === 'cancelled' && !earlier.stop) return reply.code(202).send({ jobId: asked });
  const id = CLIENT_ID.test(asked) && !earlier ? asked : newId();
  const stop = new AbortController();
  const job: Job = { userId, status: 'running', at: now, stop };
  jobs.set(id, job);
  work(stop.signal).then(
    (result) => Object.assign(job, stop.signal.aborted ? { status: 'cancelled', at: Date.now() } : { status: 'done', result, at: Date.now() }),
    (err) => {
      if (stop.signal.aborted || err instanceof CancelledError) return Object.assign(job, { status: 'cancelled', at: Date.now() });
      if (!(err instanceof HiveMindError)) req.log.error(err);
      logProblem('job', err, `${req.method} ${req.url} by ${req.user!.username}`);
      Object.assign(job, { status: 'error', error: friendlyError(err), at: Date.now() });
    },
  );
  return reply.code(202).send({ jobId: id });
}

/**
 * Stops a running job of this user. False when it had already finished (its result stands). An unknown id is
 * remembered as cancelled, for a job whose request hasn't arrived yet.
 */
export function cancelJob(userId: string, id: string): boolean {
  const job = jobs.get(id);
  if (!job) {
    if (!CLIENT_ID.test(id)) return false;
    sweep();
    jobs.set(id, { userId, status: 'cancelled', at: Date.now() });
    return true;
  }
  if (job.userId !== userId) return false;
  if (job.status === 'cancelled') return true;
  if (job.status !== 'running') return false;
  job.stop?.abort();
  Object.assign(job, { status: 'cancelled', at: Date.now() });
  return true;
}

export function jobRoutes(app: FastifyInstance) {
  app.get('/api/jobs/:id', { preHandler: requireUser }, async (req, reply) => {
    const job = jobs.get((req.params as { id: string }).id);
    if (!job || job.userId !== req.user!.id) return reply.code(404).send({ error: 'That job is gone (the server restarted?). Try again.' });
    return { status: job.status, result: job.result, error: job.error };
  });

  /** Cancel: { cancelled: false } when the job had already finished (its result is saved). */
  app.delete('/api/jobs/:id', { preHandler: requireUser }, async (req) => ({ cancelled: cancelJob(req.user!.id, (req.params as { id: string }).id) }));
}

// ---- A small persistent scheduler (M9): daily tasks at a local HH:MM, checked every minute ----
interface Daily {
  name: string;
  /** "HH:MM", or undefined while the task is switched off. */
  time: () => string | undefined;
  run: () => Promise<unknown>;
}
const daily: Daily[] = [];

export const everyDay = (name: string, time: Daily['time'], run: Daily['run']) => void daily.push({ name, time, run });

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Runs each task once per day, at its time or within the hour after it (a restart at 02:50 still pushes at 02:45's
 * task). The last run day is stored, so a restart never runs a task twice.
 */
export async function tick(now = new Date()) {
  for (const d of daily) {
    const t = d.time();
    if (!t) continue;
    const [h, m] = t.split(':').map(Number);
    const late = now.getHours() * 60 + now.getMinutes() - (h * 60 + m);
    const key = `jobs.lastRun.${d.name}`;
    if (late < 0 || late >= 60 || getSetting(key) === localDay(now)) continue;
    setSetting(key, localDay(now));
    await d.run().catch((err) => {
      console.error(`Scheduled task ${d.name} failed:`, (err as Error).message);
      logProblem('schedule', err, d.name);
    });
  }
}

export function startScheduler() {
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  return timer;
}
