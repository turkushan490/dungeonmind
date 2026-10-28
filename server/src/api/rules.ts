import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/index.js';
import { isRuleset, rules, searchRules } from '../rules/index.js';

const KINDS = ['classes', 'species', 'backgrounds', 'feats', 'spells', 'items', 'monsters', 'conditions', 'skills', 'features', 'traits', 'rules'] as const;

export function rulesRoutes(app: FastifyInstance) {
  /** What the character builder needs in one go (no spells/items/monsters: those are big). */
  app.get('/api/rules/:ruleset/builder', { preHandler: requireUser }, async (req, reply) => {
    const { ruleset } = req.params as { ruleset: string };
    if (!isRuleset(ruleset)) return reply.code(404).send({ error: 'Unknown ruleset' });
    const d = rules(ruleset);
    return { ruleset, classes: d.classes, species: d.species, backgrounds: d.backgrounds, skills: d.skills, feats: d.feats.map((f) => ({ id: f.id, name: f.name })) };
  });

  app.get('/api/rules/:ruleset/search', { preHandler: requireUser }, async (req, reply) => {
    const { ruleset } = req.params as { ruleset: string };
    const { q, limit } = req.query as { q?: string; limit?: string };
    if (!isRuleset(ruleset)) return reply.code(404).send({ error: 'Unknown ruleset' });
    return searchRules(ruleset, q ?? '', Math.min(50, Number(limit) || 10));
  });

  /** Lists (spells can be filtered by class and max level). */
  app.get('/api/rules/:ruleset/:kind', { preHandler: requireUser }, async (req, reply) => {
    const { ruleset, kind } = req.params as { ruleset: string; kind: string };
    if (!isRuleset(ruleset) || !KINDS.includes(kind as (typeof KINDS)[number])) return reply.code(404).send({ error: 'Not found' });
    const d = rules(ruleset);
    if (kind === 'spells') {
      const { class: cls, maxLevel } = req.query as { class?: string; maxLevel?: string };
      return d.spells.filter((s) => (!cls || s.classes.includes(cls)) && (maxLevel === undefined || s.level <= Number(maxLevel)));
    }
    return d[kind as keyof typeof d];
  });

  app.get('/api/rules/:ruleset/:kind/:id', { preHandler: requireUser }, async (req, reply) => {
    const { ruleset, kind, id } = req.params as { ruleset: string; kind: string; id: string };
    if (!isRuleset(ruleset) || !KINDS.includes(kind as (typeof KINDS)[number])) return reply.code(404).send({ error: 'Not found' });
    const list = rules(ruleset)[kind as (typeof KINDS)[number]] as unknown as { id: string }[];
    return list.find((x) => x.id === id) ?? reply.code(404).send({ error: 'Not found' });
  });
}
