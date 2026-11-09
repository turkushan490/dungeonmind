import { toast } from './notify';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Thrown when the caller's `signal` stopped the call. Never toasted. */
export class CancelledError extends ApiError {
  constructor() {
    super('Cancelled', 0);
  }
}
export const isCancelled = (err: unknown) => err instanceof CancelledError;

/** A random job id (crypto.randomUUID needs https, a LAN server may be plain http). */
const newJobId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Calls the API. Failures show a toast unless `quiet` (the caller shows them itself).
 * With `signal`, aborting stops the call: the fetch is aborted, a slow AI job is cancelled on the server
 * (DELETE /api/jobs/:id, so nothing it made is saved), and the call rejects with CancelledError, without a toast.
 */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; quiet?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  const { signal } = opts;
  if (signal?.aborted) throw new CancelledError();
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  // We pick the job id, so the job can be cancelled even when the 202 never reaches us.
  const jobId = signal && method !== 'GET' ? newJobId() : undefined;
  let liveJob = jobId;
  const cancelJob = () => void fetch(`/api/jobs/${liveJob}`, { method: 'DELETE', credentials: 'include', keepalive: true }).catch(() => {});
  if (jobId) signal!.addEventListener('abort', cancelJob, { once: true });
  try {
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(jobId ? { 'x-job-id': jobId } : {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        credentials: 'include',
        signal,
      });
    } catch {
      if (signal?.aborted) throw new CancelledError();
      const err = new ApiError("Can't reach the DungeonMind server.", 0);
      if (!opts.quiet) toast(err.message);
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (signal?.aborted) throw new CancelledError();
    if (!res.ok) {
      const err = new ApiError(data.error ?? `HTTP ${res.status}`, res.status);
      if (!opts.quiet && res.status !== 401) toast(err.message);
      throw err;
    }
    // Slow AI work answers 202 {jobId}; wait for it here so callers just get the result.
    if (res.status === 202 && data.jobId) {
      liveJob = data.jobId;
      return await waitForJob<T>(data.jobId, opts.quiet, signal);
    }
    return data as T;
  } finally {
    if (jobId) signal!.removeEventListener('abort', cancelJob);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      r();
    }
  });

async function waitForJob<T>(jobId: string, quiet?: boolean, signal?: AbortSignal): Promise<T> {
  for (;;) {
    await sleep(1500, signal);
    if (signal?.aborted) throw new CancelledError();
    let job: { status: string; result?: T; error?: string };
    try {
      job = await api(`/api/jobs/${jobId}`, { quiet: true });
    } catch (err) {
      // A dropped connection or a proxy hiccup: keep waiting; a gone job (404) is final.
      if (err instanceof ApiError && err.status === 404) {
        if (!quiet) toast(err.message);
        throw err;
      }
      continue;
    }
    // Finished before the cancel reached the server: the result is saved, so hand it back.
    if (job.status === 'done') return job.result as T;
    if (job.status === 'cancelled' || signal?.aborted) throw new CancelledError();
    if (job.status === 'error') {
      const err = new ApiError(job.error ?? 'The DM failed', 502);
      if (!quiet) toast(err.message);
      throw err;
    }
  }
}

/** Raw upload (images): the body is the file itself. */
export async function upload<T = any>(path: string, file: Blob): Promise<T> {
  const res = await fetch(path, { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' }, credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    toast(data.error ?? `HTTP ${res.status}`);
    throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status);
  }
  return data as T;
}
