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
  return data as T;
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
