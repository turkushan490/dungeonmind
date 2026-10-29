import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from './auth/index.js';
import { newId } from './crypto.js';
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
