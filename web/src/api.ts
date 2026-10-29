import { toast } from './notify';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Calls the API. Failures show a toast unless `quiet` (the caller shows them itself). */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; quiet?: boolean } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'include',
    });
  } catch {
    const err = new ApiError("Can't reach the DungeonMind server.", 0);
    if (!opts.quiet) toast(err.message);
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(data.error ?? `HTTP ${res.status}`, res.status);
    if (!opts.quiet && res.status !== 401) toast(err.message);
    throw err;
  }
  // Slow AI work answers 202 {jobId}; wait for it here so callers just get the result.
  if (res.status === 202 && data.jobId) return waitForJob<T>(data.jobId, opts.quiet);
  return data as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForJob<T>(jobId: string, quiet?: boolean): Promise<T> {
  for (;;) {
    await sleep(1500);
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
    if (job.status === 'done') return job.result as T;
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
