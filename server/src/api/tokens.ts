import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/index.js';
import { newId, randomToken, sha256 } from '../crypto.js';
import { db } from '../db.js';

/** API tokens (dm_…) for programs: HiveMind's Lab uses one for the Bookkeeper API. */
export function tokenRoutes(app: FastifyInstance) {
  app.get('/api/tokens', { preHandler: requireUser }, async (req) =>
    (db.prepare('SELECT id, name, prefix, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC').all(req.user!.id) as Record<string, string>[]).map((t) => ({
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      createdAt: t.created_at,
      lastUsedAt: t.last_used_at ?? undefined,
    })),
  );

  app.post('/api/tokens', { preHandler: requireUser }, async (req, reply) => {
    const name = String((req.body as { name?: string })?.name ?? '').trim().slice(0, 60);
    if (!name) return reply.code(400).send({ error: 'Name the token (e.g. "HiveMind Lab")' });
    const token = `dm_${randomToken(24)}`;
    const id = newId();
    db.prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, prefix) VALUES (?, ?, ?, ?, ?)').run(id, req.user!.id, name, sha256(token), token.slice(0, 7));
    // Shown once; only the hash is stored.
    return { id, name, token };
  });

  app.delete('/api/tokens/:id', { preHandler: requireUser }, async (req) => {
    db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run((req.params as { id: string }).id, req.user!.id);
    return { ok: true };
  });
}
