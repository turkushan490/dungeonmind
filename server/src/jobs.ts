import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from './auth/index.js';
import { newId } from './crypto.js';
import { getSetting, setSetting } from './db.js';
import { HiveMindError } from './hivemind.js';

/**
 * Slow AI work (pitches, setup form, AI sheets, portraits) runs as a background job: the request answers
 * 202 {jobId} at once and the browser polls GET /api/jobs/:id. A local model on a busy GPU can take minutes,
 * longer than a reverse proxy's read timeout (60 s in Nginx Proxy Manager), which used to show up as HTTP 504.
 */
interface Job {
  userId: string;
  status: 'running' | 'done' | 'error';
  result?: unknown;
  error?: string;
  at: number;
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

export function background(req: FastifyRequest, reply: FastifyReply, work: () => Promise<unknown>) {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.status !== 'running' && now - j.at > KEEP_MS) jobs.delete(id);
  const id = newId();
  const job: Job = { userId: req.user!.id, status: 'running', at: now };
  jobs.set(id, job);
  work().then(
    (result) => Object.assign(job, { status: 'done', result, at: Date.now() }),
    (err) => {
      if (!(err instanceof HiveMindError)) req.log.error(err);
      Object.assign(job, { status: 'error', error: friendlyError(err), at: Date.now() });
    },
  );
  return reply.code(202).send({ jobId: id });
}

export function jobRoutes(app: FastifyInstance) {
  app.get('/api/jobs/:id', { preHandler: requireUser }, async (req, reply) => {
    const job = jobs.get((req.params as { id: string }).id);
    if (!job || job.userId !== req.user!.id) return reply.code(404).send({ error: 'That job is gone (the server restarted?). Try again.' });
    return { status: job.status, result: job.result, error: job.error };
  });
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
    await d.run().catch((err) => console.error(`Scheduled task ${d.name} failed:`, (err as Error).message));
  }
}

export function startScheduler() {
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  return timer;
}
