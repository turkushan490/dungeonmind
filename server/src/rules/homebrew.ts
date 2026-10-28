import { ABILITIES, type RulesData, type Ruleset } from '@dungeonmind/shared';
import { db, json } from '../db.js';
import { setRulesExtender, slug } from './index.js';

export const KINDS = ['spell', 'item', 'monster', 'feat', 'condition', 'rule', 'species', 'background'] as const;
export type HomebrewKind = (typeof KINDS)[number];

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown, min: number, max: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d;
};
const list = (v: unknown, max = 30) => (Array.isArray(v) ? v.map((x) => str(x, 120)).filter(Boolean).slice(0, max) : typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, max) : []);

/**
 * Turns an editor form into an entry in DungeonMind's rules shape. Ids are "hb-<name>" so homebrew never
 * overwrites SRD content. Returns an error message for bad input.
 */
export function cleanHomebrew(kind: HomebrewKind, raw: Record<string, unknown>): { entry: Record<string, unknown> } | { error: string } {
  const name = str(raw.name, 80);
  if (!name) return { error: 'Give it a name' };
  const id = `hb-${slug(name)}`;
  const desc = str(raw.desc, 8000);
  switch (kind) {
    case 'spell': {
      const level = Math.round(num(raw.level, 0, 9, 1));
      return {
        entry: {
          id,
          name,
          level,
          school: str(raw.school, 40) || 'Evocation',
          classes: list(raw.classes).map(slug),
          castingTime: str(raw.castingTime, 60) || '1 action',
          range: str(raw.range, 60) || 'Self',
          duration: str(raw.duration, 60) || 'Instantaneous',
          concentration: !!raw.concentration,
          ritual: !!raw.ritual,
          components: str(raw.components, 200) || 'V, S',
          desc,
          damage: str(raw.damage, 40) || undefined,
        },
      };
    }
    case 'item': {
      const ac = raw.armorBase !== undefined && raw.armorBase !== '' ? Math.round(num(raw.armorBase, 0, 30, 10)) : undefined;
      return {
        entry: {
          id,
          name,
          category: str(raw.category, 60) || 'Wondrous Item',
          rarity: str(raw.rarity, 40) || undefined,
          magic: !!raw.magic,
          damage: str(raw.damage, 30) || undefined,
          damageType: str(raw.damageType, 30) || undefined,
          properties: list(raw.properties),
          armor: ac !== undefined ? { base: ac, dexBonus: raw.dexBonus !== false, maxBonus: raw.maxBonus === '' || raw.maxBonus === undefined ? undefined : num(raw.maxBonus, 0, 10, 2) } : undefined,
          cost: str(raw.cost, 30) || undefined,
          desc: desc || undefined,
        },
      };
    }
    case 'monster': {
      const abilities = Object.fromEntries(ABILITIES.map((a) => [a, Math.round(num((raw.abilities as Record<string, unknown>)?.[a] ?? raw[a], 1, 30, 10))]));
      return {
        entry: {
          id,
          name,
          size: str(raw.size, 20) || 'Medium',
          type: str(raw.type, 40) || 'monstrosity',
          ac: Math.round(num(raw.ac, 1, 30, 12)),
          hp: Math.round(num(raw.hp, 1, 2000, 10)),
          hitDice: str(raw.hitDice, 30) || '2d8',
          speed: str(raw.speed, 60) || '30 ft.',
          abilities,
          cr: num(raw.cr, 0, 30, 1),
          xp: Math.round(num(raw.xp, 0, 155000, 200)),
          traits: list(raw.traits, 20),
          actions: list(raw.actions, 20),
        },
      };
    }
    case 'species':
      return {
        entry: {
          id,
          name,
          speed: Math.round(num(raw.speed, 5, 120, 30)),
          size: str(raw.size, 20) || 'Medium',
          abilityBonuses: Object.fromEntries(ABILITIES.map((a) => [a, Math.round(num((raw.abilityBonuses as Record<string, unknown>)?.[a], -2, 3, 0))]).filter(([, v]) => v)),
          traits: list(raw.traits),
          subspecies: [],
        },
      };
    case 'background':
      return {
        entry: {
          id,
          name,
          skills: list(raw.skills, 4).map(slug),
          abilityOptions: list(raw.abilityOptions, 3).map((a) => a.toLowerCase().slice(0, 3)).filter((a) => (ABILITIES as readonly string[]).includes(a)),
          feat: str(raw.feat, 80) || undefined,
          equipment: list(raw.equipment),
        },
      };
    default:
      // feat, condition, rule
      if (!desc) return { error: 'Describe what it does' };
      return { entry: { id, name, desc } };
  }
}

const TARGET: Record<HomebrewKind, keyof RulesData> = {
  spell: 'spells',
  item: 'items',
  monster: 'monsters',
  feat: 'feats',
  condition: 'conditions',
  rule: 'rules',
  species: 'species',
  background: 'backgrounds',
};

/** Merges every enabled homebrew entry into the ruleset (builder, rules search, HiveMind memory import). */
export function registerHomebrew() {
  setRulesExtender((ruleset: Ruleset, base: RulesData) => {
    const rows = db.prepare('SELECT kind, data FROM homebrew WHERE ruleset = ? AND enabled = 1 ORDER BY name').all(ruleset) as { kind: HomebrewKind; data: string }[];
    if (!rows.length) return base;
    const out = { ...base } as RulesData & Record<string, unknown[]>;
    for (const r of rows) {
      const key = TARGET[r.kind];
      const entry = { ...(json<Record<string, unknown>>(r.data, {}) as { id: string }), homebrew: true };
      out[key] = [...(out[key] as unknown[]).filter((x) => (x as { id: string }).id !== entry.id), entry] as never;
    }
    return out;
  });
}
