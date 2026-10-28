import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { getSetting, json, setSetting } from './db.js';

/** What DungeonMind needs from HiveMind (docs/HIVEMIND_CHANGES.md §9). */
export const REQUIRED_FEATURES = ['vars', 'jsonMode', 'memoryKeyTemplate', 'nodeOutputs', 'memorySearch', 'memoryImport'] as const;
export const OPTIONAL_FEATURES = ['numCtx', 'imageBatch', 'history'] as const;

export const canvasDir = () => resolve(process.env.CANVAS_DIR || (existsSync('hivemind') ? 'hivemind' : existsSync('../hivemind') ? '../hivemind' : '/app/hivemind'));

export class HiveMindError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    /** Worth an automatic retry (network, timeout, 5xx, invalid JSON). */
    readonly retryable = true,
  ) {
    super(message);
  }
}

export interface ModelRef {
  providerId: string;
  model: string;
}
/** Which HiveMind model each kind of canvas node uses (Settings → HiveMind). */
export interface ModelRoles {
  story?: ModelRef;
  json?: ModelRef;
  image?: ModelRef;
}

export function hivemindSettings(): { url: string; token: string; models: ModelRoles; timeoutMs: number } {
  const url = getSetting('hivemind.url') ?? config.hivemindUrl;
  const enc = getSetting('hivemind.token');
  let token = config.hivemindToken;
  if (enc) {
    try {
      token = decrypt(enc);
    } catch {
      token = '';
    }
  }
  return {
    url: url.replace(/\/+$/, ''),
    token,
    models: json<ModelRoles>(getSetting('hivemind.models'), {}),
    timeoutMs: Number(getSetting('hivemind.timeoutMs') ?? 10 * 60_000),
  };
}

export function saveHivemindSettings(s: { url?: string; token?: string; models?: ModelRoles; timeoutMs?: number }) {
  if (s.url !== undefined) setSetting('hivemind.url', s.url.trim());
  if (s.token) setSetting('hivemind.token', encrypt(s.token.trim()));
  if (s.models) setSetting('hivemind.models', JSON.stringify(s.models));
  if (s.timeoutMs) setSetting('hivemind.timeoutMs', String(Math.max(30_000, Math.min(60 * 60_000, s.timeoutMs))));
}

async function call<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { url, token } = hivemindSettings();
  if (!url) throw new HiveMindError('HiveMind is not set up yet (Settings → HiveMind)', 0, false);
  let res: Response;
  try {
    res = await fetch(url + path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
  } catch (err) {
    throw new HiveMindError(`Can't reach HiveMind at ${url}: ${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new HiveMindError(`HiveMind ${res.status}: ${body.error ?? res.statusText}`, res.status, res.status >= 500 || res.status === 409 || res.status === 429);
  return body;
}

export interface HiveMindHealth {
  ok: boolean;
  version?: string;
  features: string[];
  missing: string[];
  missingOptional: string[];
  error?: string;
}

/** The compatibility check: Settings shows it, and games refuse to start while required features are missing. */
export async function health(): Promise<HiveMindHealth> {
  try {
    const h = await call<{ ok: boolean; version?: string; features?: string[] }>('/api/health', { timeoutMs: 8000 });
    const features = h.features ?? [];
    return {
      ok: !!h.ok,
      version: h.version,
      features,
      missing: REQUIRED_FEATURES.filter((f) => !features.includes(f)),
      missingOptional: OPTIONAL_FEATURES.filter((f) => !features.includes(f)),
    };
  } catch (err) {
    return { ok: false, features: [], missing: [...REQUIRED_FEATURES], missingOptional: [...OPTIONAL_FEATURES], error: (err as Error).message };
  }
}

export async function listModels(): Promise<{ providerId: string; model: string; label?: string }[]> {
  const r = await call<{ models: { providerId: string; id?: string; model?: string; name?: string }[] }>('/api/models', { timeoutMs: 20_000 });
  return (r.models ?? []).map((m) => ({ providerId: m.providerId, model: m.model ?? m.id ?? '', label: m.name })).filter((m) => m.model);
}

// ---- Canvases ----
interface CanvasNode {
  id: string;
  type: string;
  label?: string;
  config: Record<string, unknown> & { model?: ModelRef };
}
export interface CanvasFile {
  id: string;
  name: string;
  description?: string;
  nodes: CanvasNode[];
  edges: unknown[];
}

export function canvasFiles(): CanvasFile[] {
  const dir = canvasDir();
  return readdirSync(dir)
    .filter((f) => f.endsWith('.canvas.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as CanvasFile);
}

/** narration (and the free-text answer) → the story model; JSON blocks → the JSON model; images → the image model. */
export function roleOf(n: CanvasNode): keyof ModelRoles | undefined {
  if (n.type === 'image') return 'image';
  if (n.type !== 'llm') return;
  return n.config.json ? 'json' : n.label === 'narration' || n.label === 'answer' ? 'story' : 'json';
}

/**
 * Installs (or updates) every DungeonMind canvas with PUT /api/canvases/:id. Models already picked in HiveMind
 * are kept; new nodes get the models from Settings → HiveMind.
 */
export async function installCanvases(): Promise<{ id: string; ok: boolean; error?: string; needsModel?: string[] }[]> {
  const { models } = hivemindSettings();
  const out = [];
  for (const c of canvasFiles()) {
    try {
      const existing = await call<CanvasFile>(`/api/canvases/${c.id}`).catch(() => undefined);
      const needsModel: string[] = [];
      const nodes = c.nodes.map((n) => {
        const role = roleOf(n);
        if (!role) return n;
        const kept = existing?.nodes.find((e) => e.id === n.id)?.config.model;
        const model = kept?.providerId ? kept : models[role];
        if (!model) needsModel.push(n.label ?? n.id);
        return model ? { ...n, config: { ...n.config, model } } : n;
      });
      await call(`/api/canvases/${c.id}`, { method: 'PUT', body: JSON.stringify({ ...c, nodes }) });
      out.push({ id: c.id, ok: true, needsModel: needsModel.length ? needsModel : undefined });
    } catch (err) {
      out.push({ id: c.id, ok: false, error: (err as Error).message });
    }
  }
  return out;
}

// ---- Memory ----
const IMPORT_CHUNK = 2000;

/** Bulk-loads entries in chunks (HiveMind caps one import at 20 000 entries / 20 MB); the first chunk replaces the key. */
export async function memoryImport(key: string, entries: { text: string; tags?: string[] }[], onProgress?: (done: number) => void): Promise<number> {
  let done = 0;
  for (let i = 0; i < entries.length || i === 0; i += IMPORT_CHUNK) {
    const chunk = entries.slice(i, i + IMPORT_CHUNK);
    const r = await call<{ imported: number }>(`/api/memory/keys/${encodeURIComponent(key)}/import`, {
      method: 'POST',
      body: JSON.stringify({ entries: chunk, replace: i === 0 }),
      timeoutMs: 120_000,
    });
    done += r.imported ?? chunk.length;
    onProgress?.(done);
    if (!entries.length) break;
  }
  return done;
}

export const memorySearch = (key: string, query: string, limit = 5) =>
  call<{ text: string; score: number; at?: string }[]>(`/api/memory/keys/${encodeURIComponent(key)}/search`, { method: 'POST', body: JSON.stringify({ query, limit }) });

export const memoryDelete = (key: string) => call(`/api/memory/keys/${encodeURIComponent(key)}`, { method: 'DELETE' });

// ---- Runs ----
export interface RunResult {
  runId: string;
  outputs: Record<string, { nodeId: string; type: string; text: string }>;
  final?: string;
}

export interface RunOptions {
  vars?: Record<string, string>;
  signal?: AbortSignal;
  /** Live narration tokens, per node label. */
  onToken?: (label: string, text: string) => void;
  /** e.g. "narration" started. */
  onNode?: (label: string, event: 'start' | 'done') => void;
}

/** Starts a canvas run, follows its SSE stream until the end, then reads the per-node outputs. */
export async function runCanvas(canvasId: string, question: string, opts: RunOptions = {}): Promise<RunResult> {
  const { url, token, timeoutMs } = hivemindSettings();
  const vars = Object.fromEntries(Object.entries(opts.vars ?? {}).map(([k, v]) => [k, String(v ?? '')]));
  const { runId } = await call<{ runId: string }>('/api/runs', { method: 'POST', body: JSON.stringify({ canvasId, question: question || '-', vars }) });

  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const labels = new Map<string, string>();
  let failed: string | undefined;
  try {
    const res = await fetch(`${url}/api/runs/${runId}/events`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal });
    if (!res.ok || !res.body) throw new HiveMindError(`HiveMind events ${res.status}`, res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let ended = false;
    while (!ended) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n');
        if (event === 'end') {
          ended = true;
          break;
        }
        if (event === 'error') throw new HiveMindError(json<{ error?: string }>(data, {}).error ?? 'Run failed');
        if (!data) continue;
        const ev = json<{ type?: string; nodeId?: string; label?: string; text?: string; error?: string; graph?: { nodes: CanvasNode[] } }>(data, {});
        if (ev.type === 'run_start') for (const n of ev.graph?.nodes ?? []) labels.set(n.id, n.label ?? n.id);
        const label = ev.label ?? (ev.nodeId ? (labels.get(ev.nodeId) ?? ev.nodeId) : '');
        if (ev.type === 'token' && ev.text) opts.onToken?.(label, ev.text);
        if (ev.type === 'node_start') opts.onNode?.(label, 'start');
        if (ev.type === 'node_done') opts.onNode?.(label, 'done');
        if (ev.type === 'error') failed = ev.error ?? 'Run failed';
      }
    }
    reader.cancel().catch(() => {});
  } catch (err) {
    // Stop the run on HiveMind too, so it doesn't keep the GPU busy.
    call(`/api/runs/${runId}/cancel`, { method: 'POST' }).catch(() => {});
    if (err instanceof HiveMindError) throw err;
    throw new HiveMindError(timeout.aborted ? `HiveMind run timed out after ${Math.round(timeoutMs / 1000)} s` : `HiveMind run stopped: ${(err as Error).message}`);
  }
  const run = await call<{ status: string; final?: string; outputs?: RunResult['outputs']; error?: string }>(`/api/runs/${runId}`);
  if (run.status === 'error' || failed) throw new HiveMindError(`HiveMind run failed: ${failed ?? run.error ?? 'unknown error'}`);
  return { runId, outputs: run.outputs ?? {}, final: run.final };
}

/** Parses a JSON node output (HiveMind already normalises it; this also strips fences for safety). */
export function outputJson<T>(result: RunResult, label: string): T {
  const text = result.outputs[label]?.text;
  if (text === undefined) throw new HiveMindError(`HiveMind returned no "${label}" output`);
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(clean) as T;
  } catch {
    throw new HiveMindError(`"${label}" is not valid JSON`);
  }
}

export const outputText = (result: RunResult, label: string): string => {
  const text = result.outputs[label]?.text?.trim();
  if (!text) throw new HiveMindError(`HiveMind returned an empty "${label}"`);
  return text;
};

/** Downloads a HiveMind file (images) so DungeonMind keeps its own copy. */
export async function fetchFile(path: string): Promise<{ data: Buffer; type: string }> {
  const { url, token } = hivemindSettings();
  const res = await fetch(`${url}/api/files/raw?path=${encodeURIComponent(path)}&inline=1`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new HiveMindError(`HiveMind file ${res.status}`, res.status);
  return { data: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') ?? 'application/octet-stream' };
}

/** `![image](hm-file:path)` links in an image block's output. */
export const imagePaths = (text: string) => [...text.matchAll(/\]\(hm-file:([^)\s]+)\)/g)].map((m) => decodeURIComponent(m[1]));

// ---- Retry ----
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: { attempts?: number; baseMs?: number; onRetry?: (attempt: number, err: Error) => void } = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  let last: Error = new Error('never ran');
  for (let a = 1; a <= attempts; a++) {
    try {
      return await fn(a);
    } catch (err) {
      last = err as Error;
      if (err instanceof HiveMindError && !err.retryable) throw err;
      if (a < attempts) {
        opts.onRetry?.(a, last);
        await new Promise((r) => setTimeout(r, (opts.baseMs ?? 1500) * a));
      }
    }
  }
  throw last;
}
