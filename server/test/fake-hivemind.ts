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
  /** M9 `modelOverride`: the run's models. */
  models?: Record<string, { providerId: string; model: string }>;
}

/** HiveMind M9 (the AI Trainer), all on. */
export const M9_FEATURES = ['modelOverride', 'nodeInputs', 'scopedTraining', 'trainEvents', 'trainingWindow', 'schedules'];

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
  // M9: datasets, training jobs, the training window and workflow schedules.
  datasets = new Map<string, { id: string; name: string; items: any[] }>();
  trainJobs = new Map<string, { id: string; body: any; state: string; model?: string }>();
  /** The model a finished training job reports. */
  trainedModel = 'dungeonmind-dm-1';
  schedules = new Map<string, any>();
  window = { start: '03:00', end: '08:00', open: false };
  pulls: { providerId: string; model: string }[] = [];
  models: { providerId: string; id: string }[] = [{ providerId: 'ollama', id: 'story-24b' }, { providerId: 'ollama', id: 'json-20b' }];
  private runs = new Map<string, { status: string; call: FakeCall; outputs: Record<string, any>; events: string[]; done: Promise<void> }>();
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
    if (p === '/api/models') return this.send(res, 200, { models: this.models });
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
      if (b.models && !this.features.includes('modelOverride')) return this.send(res, 400, { error: 'Unknown field: models' });
      const call: FakeCall = { canvasId: b.canvasId, question: b.question, vars: b.vars ?? {}, models: b.models };
      this.calls.push(call);
      const id = `r_${++this.n}`;
      const run = { status: 'running', call, outputs: {} as Record<string, any>, events: [] as string[], done: Promise.resolve() };
      run.done = (async () => {
        const answer = await this.onRun(call);
        if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));
        if (answer.stream) run.events.push(JSON.stringify({ type: 'thinking', label: answer.stream.label, text: 'Let me think.' }));
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
      // M9 `nodeInputs`: the exact messages each LLM node sent, keyed by node id.
      const inputs =
        url.searchParams.get('inputs') === '1' && this.features.includes('nodeInputs')
          ? Object.fromEntries(Object.keys(run.outputs).map((label) => [label, { messages: [{ role: 'system', content: `exact system prompt of ${run.call.canvasId}/${label}` }, { role: 'user', content: run.call.question }] }]))
          : undefined;
      return this.send(res, 200, { id: m[1], status: run.status, outputs: run.outputs, events: [], ...(inputs ? { inputs } : {}) });
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
    if ((m = p.match(/^\/api\/ollama\/([^/]+)\/pull$/))) {
      const b = await this.body(req);
      this.pulls.push({ providerId: decodeURIComponent(m[1]), model: b.model });
      return this.send(res, 200, { ok: true });
    }
    // ---- M9 ----
    const has = (f: string) => this.features.includes(f);
    if (p === '/api/datasets' && has('scopedTraining')) {
      if (req.method === 'POST') {
        const b = await this.body(req);
        const d = { id: `ds_${++this.n}`, name: b.name, items: [] };
        this.datasets.set(d.id, d);
        return this.send(res, 200, { id: d.id, name: d.name, count: 0 });
      }
      return this.send(res, 200, { datasets: [...this.datasets.values()].map((d) => ({ id: d.id, name: d.name, count: d.items.length })) });
    }
    if ((m = p.match(/^\/api\/datasets\/([^/]+)\/items$/)) && has('scopedTraining')) {
      const d = this.datasets.get(m[1]);
      if (!d) return this.send(res, 404, { error: 'Dataset not found' });
      if (req.method === 'POST') {
        const b = await this.body(req);
        d.items.push(...b.items);
        return this.send(res, 200, { added: b.items.length });
      }
      if (req.method === 'DELETE') {
        d.items = [];
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 200, { items: d.items });
    }
    if (p === '/api/lab/train' && req.method === 'POST' && has('scopedTraining')) {
      const b = await this.body(req);
      const job = { id: `train_${++this.n}`, body: b, state: 'done', model: this.trainedModel };
      this.trainJobs.set(job.id, job);
      return this.send(res, 200, { id: job.id, state: 'queued' });
    }
    if ((m = p.match(/^\/api\/lab\/train\/([^/]+)\/events$/)) && has('trainEvents')) {
      const job = this.trainJobs.get(m[1]);
      if (!job) return this.send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const e of [{ state: 'training', step: 1, total: 2, loss: 1.5, eta: 30 }, { log: 'epoch 1 done' }, { step: 2, total: 2, loss: 0.9, eta: 0 }, { state: 'done', model: job.model, sample: { before: 'meh', after: 'better' } }])
        res.write(`data: ${JSON.stringify(e)}\n\n`);
      res.write('event: end\ndata: {}\n\n');
      return res.end();
    }
    if ((m = p.match(/^\/api\/lab\/train\/([^/]+)$/)) && has('scopedTraining')) {
      const job = this.trainJobs.get(m[1]);
      if (!job) return this.send(res, 404, { error: 'Not found' });
      if (req.method === 'DELETE') {
        this.trainJobs.delete(m[1]);
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 200, { id: job.id, state: job.state, model: job.model });
    }
    if (p === '/api/lab/window' && has('trainingWindow')) return this.send(res, 200, this.window);
    if ((m = p.match(/^\/api\/workflows\/([^/]+)\/schedule$/)) && has('schedules')) {
      if (req.method === 'PUT') {
        this.schedules.set(m[1], await this.body(req));
        return this.send(res, 200, this.schedules.get(m[1]));
      }
      if (req.method === 'DELETE') {
        this.schedules.delete(m[1]);
        return this.send(res, 200, { ok: true });
      }
      const sc = this.schedules.get(m[1]);
      return sc ? this.send(res, 200, sc) : this.send(res, 404, { error: 'No schedule' });
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
