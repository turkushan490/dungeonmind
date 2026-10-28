import type { FastifyInstance } from 'fastify';
import { RULESETS, type Ruleset } from '@dungeonmind/shared';
import { requireAdmin, requireUser } from '../auth/index.js';
import { getSetting, json, setSetting } from '../db.js';
import { canvasFiles, health, hivemindSettings, installCanvases, listModels, memoryImport, pullModel, saveHivemindSettings, type ModelRoles } from '../hivemind.js';
import { memoryEntries } from '../rules/index.js';

interface InstallState {
  canvasesAt?: string;
  canvases?: Awaited<ReturnType<typeof installCanvases>>;
  rules?: Partial<Record<Ruleset, { count: number; at: string }>>;
  importing?: { ruleset: Ruleset; done: number; total: number; error?: string };
}

const state = (): InstallState => json<InstallState>(getSetting('hivemind.installed'), {});
const saveState = (s: InstallState) => setSetting('hivemind.installed', JSON.stringify(s));

export function hivemindRoutes(app: FastifyInstance) {
  app.get('/api/settings/hivemind', { preHandler: requireAdmin }, async () => {
    const s = hivemindSettings();
    return { url: s.url, hasToken: !!s.token, models: s.models, timeoutMs: s.timeoutMs, installed: state() };
  });

  app.put('/api/settings/hivemind', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { url?: string; token?: string; models?: ModelRoles; timeoutMs?: number };
    if (body.url !== undefined && body.url && !/^https?:\/\/[^\s]+$/.test(body.url.trim())) return reply.code(400).send({ error: 'The URL starts with http:// or https://' });
    if (body.token && !body.token.trim().startsWith('hm_')) return reply.code(400).send({ error: 'A HiveMind token starts with hm_' });
    saveHivemindSettings(body);
    return { ok: true };
  });

  /** Everyone sees whether the DM can think (the lobby shows a warning when it can't). */
  app.get('/api/hivemind/health', { preHandler: requireUser }, async () => health());

  app.get('/api/hivemind/models', { preHandler: requireAdmin }, async (_req, reply) => {
    try {
      return await listModels();
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** The canvas JSON, to import by hand in HiveMind. */
  app.get('/api/hivemind/canvases', { preHandler: requireUser }, async () => canvasFiles().map((c) => ({ id: c.id, name: c.name, description: c.description })));
  app.get('/api/hivemind/canvases/:id', { preHandler: requireUser }, async (req, reply) => {
    const c = canvasFiles().find((c) => c.id === (req.params as { id: string }).id);
    if (!c) return reply.code(404).send({ error: 'Not found' });
    reply.header('content-disposition', `attachment; filename="${c.id}.canvas.json"`);
    return c;
  });

  app.post('/api/hivemind/install', { preHandler: requireAdmin }, async () => {
    const canvases = await installCanvases();
    saveState({ ...state(), canvases, canvasesAt: new Date().toISOString() });
    return { canvases };
  });

  /**
   * The Lab's fine-tuned DM model as the default (M13): optionally pull it into Ollama through HiveMind,
   * use it for the story and JSON blocks, and reinstall the canvases with it.
   */
  app.post('/api/hivemind/dm-model', { preHandler: requireAdmin }, async (req, reply) => {
    const { providerId, model, pull, roles } = (req.body ?? {}) as { providerId?: string; model?: string; pull?: boolean; roles?: ('story' | 'json')[] };
    if (!providerId || !model || model.length > 200) return reply.code(400).send({ error: 'Pick the provider and the model name' });
    let pulled: unknown;
    try {
      if (pull) pulled = await pullModel(providerId, model);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
    const s = hivemindSettings();
    const next = { ...s.models };
    for (const r of roles?.length ? roles : (['story', 'json'] as const)) next[r] = { providerId, model };
    saveHivemindSettings({ models: next });
    // Reinstalling keeps models picked by hand in HiveMind; nodes without one get the new default.
    const canvases = await installCanvases().catch(() => []);
    return { models: next, pulled, canvases };
  });

  /** Loads the SRD into HiveMind memory (rules:srd51 / rules:srd52). Runs in the background; poll GET /api/settings/hivemind. */
  app.post('/api/hivemind/import-rules', { preHandler: requireAdmin }, async (req, reply) => {
    const wanted = ((req.body as { rulesets?: string[] })?.rulesets ?? [...RULESETS]).filter((r): r is Ruleset => RULESETS.includes(r as Ruleset));
    if (state().importing && !state().importing!.error) return reply.code(409).send({ error: 'An import is already running' });
    const run = async () => {
      for (const ruleset of wanted) {
        const entries = memoryEntries(ruleset).map((e) => ({ text: e.text, tags: [e.kind.toLowerCase()] }));
        saveState({ ...state(), importing: { ruleset, done: 0, total: entries.length } });
        try {
          const count = await memoryImport(`rules:${ruleset}`, entries, (done) => saveState({ ...state(), importing: { ruleset, done, total: entries.length } }));
          const s = state();
          saveState({ ...s, importing: undefined, rules: { ...s.rules, [ruleset]: { count, at: new Date().toISOString() } } });
        } catch (err) {
          saveState({ ...state(), importing: { ruleset, done: 0, total: entries.length, error: (err as Error).message } });
          return;
        }
      }
    };
    const done = run();
    if ((req.query as { wait?: string }).wait) await done;
    return { started: wanted, ...(state().importing?.error ? { error: state().importing!.error } : {}) };
  });
}
