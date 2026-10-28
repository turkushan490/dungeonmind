import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { bookkeepingRoutes } from './api/bookkeeping.js';
import { characterRoutes } from './api/characters.js';
import { gameRoutes } from './api/games.js';
import { hivemindRoutes } from './api/hivemind.js';
import { homebrewRoutes } from './api/homebrew.js';
import { registerHomebrew } from './rules/homebrew.js';
import { rulesRoutes } from './api/rules.js';
import { portraitRoutes } from './api/portraits.js';
import { tableRoutes } from './api/table.js';
import { imageRoutes } from './images.js';
import { ttsRoutes } from './api/tts.js';
import { authRoutes } from './auth/index.js';
import { registerEngine } from './game/engine.js';
import { config } from './config.js';
import { attachRealtime, presenceList } from './realtime.js';
import { requireUser } from './auth/index.js';

export const VERSION = process.env.APP_VERSION || 'dev';

/** The whole web app without listening: main.ts starts it, tests inject requests into it. */
export async function buildApp(opts: { logger?: boolean; web?: boolean; realtime?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL || 'info' }, trustProxy: true, bodyLimit: 12 * 1024 * 1024 });
  await app.register(cookie);

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? `Server error: ${err.message}` : err.message });
  });

  // Refuse cross-site form posts: writes must be JSON (raw bodies only for uploads).
  app.addHook('onRequest', async (req, reply) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.url.startsWith('/api/')) {
      const type = req.headers['content-type'] ?? '';
      const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'];
      const upload = req.url.includes('/upload') && /^(image\/|application\/octet-stream)/.test(type);
      if (hasBody && !upload && !type.startsWith('application/json')) return reply.code(415).send({ error: 'Send JSON' });
    }
  });

  app.get('/api/health', async () => ({ ok: true, app: 'dungeonmind', version: VERSION, authMode: config.authMode }));
  app.get('/api/presence', { preHandler: requireUser }, async () => presenceList());

  registerEngine();
  registerHomebrew();
  authRoutes(app);
  rulesRoutes(app);
  hivemindRoutes(app);
  characterRoutes(app);
  gameRoutes(app);
  tableRoutes(app);
  bookkeepingRoutes(app);
  ttsRoutes(app);
  imageRoutes(app);
  portraitRoutes(app);
  homebrewRoutes(app);

  if (opts.realtime !== false) attachRealtime(app);

  if (opts.web !== false && existsSync(config.webDir)) {
    await app.register(staticFiles, {
      root: config.webDir,
      setHeaders: (res, path) => {
        if (path.endsWith('.html')) res.setHeader('cache-control', 'no-cache');
      },
    });
    // Single-page app: page routes get index.html; missing API routes and files are real 404s.
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/') || /\.[a-z0-9]+$/i.test(req.url.split('?')[0])) return reply.code(404).send({ error: 'Not found' });
      reply.header('cache-control', 'no-cache');
      return reply.sendFile('index.html');
    });
  }
  return app;
}
