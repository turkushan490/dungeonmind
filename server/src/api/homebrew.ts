import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/index.js';
import { newId } from '../crypto.js';
import { db, json } from '../db.js';
import { cleanHomebrew, KINDS, type HomebrewKind } from '../rules/homebrew.js';
import { invalidateRules, isRuleset } from '../rules/index.js';

const toEntry = (r: Record<string, any>) => ({ id: r.id, ownerId: r.owner_id, owner: r.owner, ruleset: r.ruleset, kind: r.kind, name: r.name, data: json(r.data, {}), enabled: !!r.enabled, updatedAt: r.updated_at });

export function homebrewRoutes(app: FastifyInstance) {
  app.get('/api/homebrew', { preHandler: requireUser }, async (req) => {
    const { ruleset } = req.query as { ruleset?: string };
    return (
      db
        .prepare(`SELECT h.*, u.username AS owner FROM homebrew h JOIN users u ON u.id = h.owner_id ${ruleset ? 'WHERE h.ruleset = ?' : ''} ORDER BY h.kind, h.name`)
        .all(...(ruleset ? [ruleset] : [])) as Record<string, any>[]
    ).map(toEntry);
  });

  app.post('/api/homebrew', { preHandler: requireUser }, async (req, reply) => {
    const b = (req.body ?? {}) as { ruleset?: string; kind?: string; data?: Record<string, unknown> };
    if (!isRuleset(b.ruleset)) return reply.code(400).send({ error: 'Pick a ruleset' });
    if (!KINDS.includes(b.kind as HomebrewKind)) return reply.code(400).send({ error: `Kind is one of ${KINDS.join(', ')}` });
    const c = cleanHomebrew(b.kind as HomebrewKind, b.data ?? {});
    if ('error' in c) return reply.code(400).send({ error: c.error });
    if (db.prepare('SELECT 1 FROM homebrew WHERE ruleset = ? AND kind = ? AND name = ? COLLATE NOCASE').get(b.ruleset as string, b.kind as string, c.entry.name as string)) return reply.code(409).send({ error: 'There is already homebrew with that name' });
    const n = (db.prepare('SELECT COUNT(*) AS n FROM homebrew WHERE owner_id = ?').get(req.user!.id) as { n: number }).n;
    if (n >= 500) return reply.code(400).send({ error: 'At most 500 homebrew entries per user' });
    const id = newId();
    db.prepare('INSERT INTO homebrew (id, owner_id, ruleset, kind, name, data) VALUES (?, ?, ?, ?, ?, ?)').run(id, req.user!.id, b.ruleset as string, b.kind as string, c.entry.name as string, JSON.stringify(c.entry));
    invalidateRules();
    return toEntry({ ...(db.prepare('SELECT * FROM homebrew WHERE id = ?').get(id) as object), owner: req.user!.username });
  });

  app.put('/api/homebrew/:id', { preHandler: requireUser }, async (req, reply) => {
    const row = db.prepare('SELECT * FROM homebrew WHERE id = ?').get((req.params as { id: string }).id) as Record<string, any> | undefined;
    if (!row) return reply.code(404).send({ error: 'Not found' });
    if (row.owner_id !== req.user!.id && req.user!.role !== 'admin') return reply.code(403).send({ error: 'Only its maker or an admin can change it' });
    const b = (req.body ?? {}) as { data?: Record<string, unknown>; enabled?: boolean };
    if (b.data) {
      const c = cleanHomebrew(row.kind, b.data);
      if ('error' in c) return reply.code(400).send({ error: c.error });
      db.prepare("UPDATE homebrew SET name = ?, data = ?, updated_at = datetime('now') WHERE id = ?").run(c.entry.name as string, JSON.stringify(c.entry), row.id);
    }
    if (b.enabled !== undefined) db.prepare('UPDATE homebrew SET enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, row.id);
    invalidateRules();
    return { ok: true };
  });

  app.delete('/api/homebrew/:id', { preHandler: requireUser }, async (req, reply) => {
    const row = db.prepare('SELECT owner_id FROM homebrew WHERE id = ?').get((req.params as { id: string }).id) as { owner_id: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'Not found' });
    if (row.owner_id !== req.user!.id && req.user!.role !== 'admin') return reply.code(403).send({ error: 'Only its maker or an admin can delete it' });
    db.prepare('DELETE FROM homebrew WHERE id = ?').run((req.params as { id: string }).id);
    invalidateRules();
    return { ok: true };
  });
}
