import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** What a fake canvas run returns: outputs by node label, an error, or a delay. */
export interface FakeRun {
  outputs?: Record<string, string | undefined>;
  error?: string;
  /** Streamed as token events of this label before node_done. */
  stream?: { label: string; text: string };
  delayMs?: number;
}

export interface FakeCall {
  canvasId: string;
  question: string;
  vars: Record<string, string>;
}

/**
 * A small stand-in for HiveMind's API (docs/HIVEMIND_CHANGES.md): health with features, canvases, runs with SSE
 * and per-node outputs, memory import/search and files. Tests script the run answers with `onRun`.
 */
export class FakeHiveMind {
  server: Server;
  url = '';
  token = 'hm_test';
  features = ['vars', 'history', 'jsonMode', 'memoryKeyTemplate', 'nodeOutputs', 'memorySearch', 'memoryImport', 'imageBatch', 'numCtx'];
  canvases = new Map<string, any>();
  memory = new Map<string, { text: string; tags?: string[] }[]>();
  calls: FakeCall[] = [];
  files = new Map<string, Buffer>();
  onRun: (call: FakeCall) => FakeRun | Promise<FakeRun> = () => ({ outputs: {} });
  private runs = new Map<string, { status: string; outputs: Record<string, any>; events: string[]; done: Promise<void> }>();
  private n = 0;

  constructor() {
    this.server = createServer((req, res) => this.handle(req, res).catch((err) => this.send(res, 500, { error: String(err) })));
  }

  async start() {
    await new Promise<void>((ok) => this.server.listen(0, '127.0.0.1', ok));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this;
  }
  stop() {
    this.server.closeAllConnections?.();
    return new Promise<void>((ok) => this.server.close(() => ok()));
  }

  /** Calls of one canvas. */
  callsOf(canvasId: string) {
    return this.calls.filter((c) => c.canvasId === canvasId);
  }

  private send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const s = Buffer.concat(chunks).toString('utf8');
    return s ? JSON.parse(s) : {};
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, 'http://x');
    const p = url.pathname;
    if (p === '/api/health') return this.send(res, 200, { ok: true, version: 'fake', features: this.features });
    if (req.headers.authorization !== `Bearer ${this.token}`) return this.send(res, 401, { error: 'Not logged in' });

    let m: RegExpMatchArray | null;
    if (p === '/api/models') return this.send(res, 200, { models: [{ providerId: 'ollama', id: 'story-24b' }, { providerId: 'ollama', id: 'json-20b' }] });
    if ((m = p.match(/^\/api\/canvases\/([^/]+)$/))) {
      if (req.method === 'PUT') {
        const c = await this.body(req);
        if (!c.name) return this.send(res, 400, { error: 'Canvas needs a name' });
        this.canvases.set(m[1], { ...c, id: m[1] });
        return this.send(res, 200, this.canvases.get(m[1]));
      }
      const c = this.canvases.get(m[1]);
      return c ? this.send(res, 200, c) : this.send(res, 404, { error: 'Not found' });
    }
    if (p === '/api/runs' && req.method === 'POST') {
      const b = await this.body(req);
      if (!b.question) return this.send(res, 400, { error: 'Ask a question' });
      if (!this.canvases.has(b.canvasId)) return this.send(res, 404, { error: 'Canvas not found' });
      const call: FakeCall = { canvasId: b.canvasId, question: b.question, vars: b.vars ?? {} };
      this.calls.push(call);
      const id = `r_${++this.n}`;
      const run = { status: 'running', outputs: {} as Record<string, any>, events: [] as string[], done: Promise.resolve() };
      run.done = (async () => {
        const answer = await this.onRun(call);
        if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));
        if (answer.stream) for (const piece of answer.stream.text.match(/.{1,12}/gs) ?? []) run.events.push(JSON.stringify({ type: 'token', label: answer.stream.label, text: piece }));
        if (answer.error) {
          run.events.push(JSON.stringify({ type: 'error', error: answer.error }));
          run.status = 'error';
          return;
        }
        for (const [label, text] of Object.entries(answer.outputs ?? {})) {
          if (text === undefined) continue;
          run.outputs[label] = { nodeId: label, type: 'llm', text };
          run.events.push(JSON.stringify({ type: 'node_done', label, text }));
        }
        run.events.push(JSON.stringify({ type: 'run_done' }));
        run.status = 'done';
      })();
      this.runs.set(id, run);
      return this.send(res, 200, { runId: id });
    }
    if ((m = p.match(/^\/api\/runs\/([^/]+)\/events$/))) {
      const run = this.runs.get(m[1]);
      if (!run) return this.send(res, 404, { error: 'Run not found' });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      await run.done;
      for (const e of run.events) res.write(`data: ${e}\n\n`);
      res.write('event: end\ndata: {}\n\n');
      return res.end();
    }
    if ((m = p.match(/^\/api\/runs\/([^/]+)\/cancel$/))) return this.send(res, 200, { ok: true });
    if ((m = p.match(/^\/api\/runs\/([^/]+)$/))) {
      const run = this.runs.get(m[1]);
      if (!run) return this.send(res, 404, { error: 'Run not found' });
      if (run.status === 'running') return this.send(res, 409, { error: 'This run is still going' });
      return this.send(res, 200, { id: m[1], status: run.status, outputs: run.outputs, events: [] });
    }
    if ((m = p.match(/^\/api\/memory\/keys\/([^/]+)\/import$/))) {
      const key = decodeURIComponent(m[1]);
      const b = await this.body(req);
      if (b.entries.length > 20000) return this.send(res, 413, { error: 'Too large' });
      const list = b.replace ? [] : (this.memory.get(key) ?? []);
      list.push(...b.entries);
      this.memory.set(key, list);
      return this.send(res, 200, { imported: b.entries.length, key });
    }
    if ((m = p.match(/^\/api\/memory\/keys\/([^/]+)\/search$/))) {
      const b = await this.body(req);
      const words = String(b.query).toLowerCase().split(/\W+/).filter(Boolean);
      const hits = (this.memory.get(decodeURIComponent(m[1])) ?? [])
        .map((e) => ({ text: e.text, score: words.filter((w) => e.text.toLowerCase().includes(w)).length }))
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, b.limit ?? 5);
      return this.send(res, 200, hits);
    }
    if ((m = p.match(/^\/api\/memory\/keys\/([^/]+)$/)) && req.method === 'DELETE') {
      this.memory.delete(decodeURIComponent(m[1]));
      return this.send(res, 200, { ok: true });
    }
    if (p === '/api/files/raw') {
      const f = this.files.get(url.searchParams.get('path') ?? '');
      if (!f) return this.send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(f);
    }
    return this.send(res, 404, { error: `fake: no route ${req.method} ${p}` });
  }
}

/** A 1×1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
