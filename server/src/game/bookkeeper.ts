import { XP_TABLE, type Approval, type Condition, type Counter, type GameCharacter, type GameSettings, type Npc, type Ruleset } from '@dungeonmind/shared';
import { newId } from '../crypto.js';
import { rollD20, roll } from './dice.js';
import { mod } from '@dungeonmind/shared';
import { clip, sameName } from './text.js';

/**
 * The Bookkeeper: every number on every sheet goes through here. Pure functions on characters,
 * so they're easy to test; the turn engine calls them inside the turn's transaction.
 */

export interface BookResult {
  /** Shown in the story log ("Turks: 12 → 5 HP"). */
  changes: string[];
  /** For the host ("Bookkeeper rejected …"). */
  notes: string[];
  approvals: Approval[];
}
export const emptyResult = (): BookResult => ({ changes: [], notes: [], approvals: [] });

// ---- Counters ----

/** "1st-level spell slot", "spell slot 1", "Level 1 slot", "L1 slot" → "Spell slot L1". */
export function normalizeCounterName(name: string): string {
  const s = name.trim();
  const slot = /(?:spell\s*)?slot/i.test(s) && (/(?:L|level\s*|lvl\s*)(\d)/i.exec(s) ?? /(\d)(?:st|nd|rd|th)?[-\s]*level/i.exec(s) ?? /slot\s*(\d)/i.exec(s));
  if (slot) return `Spell slot L${slot[1]}`;
  return s;
}

export function findCounter(c: GameCharacter, name: string): Counter | undefined {
  const n = normalizeCounterName(name).toLowerCase();
  return (
    c.counters.find((k) => k.name.toLowerCase() === n) ??
    c.counters.find((k) => k.name.toLowerCase().startsWith(n) || n.startsWith(k.name.toLowerCase())) ??
    (n === 'ki points' || n === 'focus' ? c.counters.find((k) => /^(ki|focus points)$/i.test(k.name)) : undefined)
  );
}

/** Ammunition and other items count as resources too: arrows come out of the inventory. */
const AMMO = /^(arrows?|bolts?|bullets?|needles?|darts?|javelins?|handaxes?|daggers?)$/i;

export interface Spend {
  characterId: string;
  name: string;
  amount: number;
  /** Spent from the inventory instead of a counter. */
  item?: boolean;
}

/**
 * Is every resource the actions need available? Returns what to spend, or why a character's action is refused.
 * Nothing is spent here.
 */
export function checkResources(chars: GameCharacter[], wanted: { pc: string; name: string; amount: number }[]): { spend: Spend[]; refused: { characterId: string; reason: string }[] } {
  const spend: Spend[] = [];
  const refused: { characterId: string; reason: string }[] = [];
  const need = new Map<string, number>();
  for (const w of wanted ?? []) {
    const c = chars.find((x) => sameName(x.name, w?.pc));
    if (!c || typeof w.name !== 'string') continue;
    const amount = Math.max(1, Math.min(100, Math.round(Number(w.amount) || 1)));
    if (refused.some((r) => r.characterId === c.id)) continue;
    const counter = findCounter(c, w.name);
    if (counter) {
      const key = `${c.id}|${counter.name}`;
      const total = (need.get(key) ?? 0) + amount;
      if (total > counter.current) {
        refused.push({ characterId: c.id, reason: `${counter.name} is at ${counter.current}/${counter.max}${counter.current === 0 ? ' (used up)' : ''}.` });
        continue;
      }
      need.set(key, total);
      spend.push({ characterId: c.id, name: counter.name, amount });
      continue;
    }
    const item = c.inventory.find((i) => sameName(i.name, w.name) || i.name.toLowerCase().startsWith(w.name.toLowerCase().replace(/s$/, '')));
    if (item || AMMO.test(w.name)) {
      const have = item?.qty ?? 0;
      const key = `${c.id}|item:${item?.name ?? w.name}`;
      const total = (need.get(key) ?? 0) + amount;
      if (total > have) {
        refused.push({ characterId: c.id, reason: `${c.name} has ${have} ${item?.name ?? w.name} left.` });
        continue;
      }
      need.set(key, total);
      spend.push({ characterId: c.id, name: item!.name, amount, item: true });
      continue;
    }
    // A spell slot level the character doesn't have, or a feature they don't have at all.
    if (/slot/i.test(w.name) || /divinity|rage|inspiration|ki|surge|wind|sorcery|wild shape|lay on hands|focus/i.test(w.name))
      refused.push({ characterId: c.id, reason: `${c.name} has no ${normalizeCounterName(w.name)}.` });
  }
  return { spend, refused };
}

export function applySpend(chars: GameCharacter[], spend: Spend[], sign: 1 | -1 = -1): string[] {
  const out: string[] = [];
  for (const s of spend) {
    const c = chars.find((x) => x.id === s.characterId);
    if (!c) continue;
    if (s.item) {
      const it = c.inventory.find((i) => i.name === s.name);
      if (!it) continue;
      it.qty = Math.max(0, it.qty + sign * s.amount);
      out.push(`${c.name}: ${s.name} ${it.qty + -sign * s.amount} → ${it.qty}`);
      if (it.qty === 0) c.inventory = c.inventory.filter((i) => i !== it);
      continue;
    }
    const k = c.counters.find((x) => x.name === s.name);
    if (!k) continue;
    const before = k.current;
    k.current = Math.max(0, Math.min(k.max, k.current + sign * s.amount));
    out.push(`${c.name}: ${k.name} ${before}/${k.max} → ${k.current}/${k.max}`);
  }
  return out;
}

// ---- Hit points ----

const has = (c: GameCharacter, cond: string) => c.conditions.some((x) => x.name === cond);
export const isDown = (c: GameCharacter) => c.hp <= 0;

function addCondition(c: GameCharacter, cond: Condition) {
  const prev = c.conditions.find((x) => x.name === cond.name);
  if (prev) {
    if (cond.rounds === undefined) delete prev.rounds;
    else if (prev.rounds !== undefined) prev.rounds = Math.max(prev.rounds, cond.rounds);
  } else c.conditions.push(cond);
}
const removeCondition = (c: GameCharacter, name: string) => (c.conditions = c.conditions.filter((x) => x.name !== name));

/** Concentration DC after taking damage. 2024 caps it at 30. */
export const concentrationDc = (damage: number, ruleset: Ruleset) => Math.min(ruleset === 'srd52' ? 30 : 99, Math.max(10, Math.floor(damage / 2)));

/**
 * Damage: temporary HP first, never below 0. Dropping to 0: unconscious (or dead from massive damage).
 * Damage while at 0: a death save failure (two on a crit). Concentration: the server rolls the Constitution save.
 */
export function applyDamage(c: GameCharacter, amount: number, opts: { crit?: boolean; ruleset: Ruleset; conBonus?: number; source?: string }): string[] {
  const out: string[] = [];
  let dmg = Math.max(0, Math.round(amount));
  if (!dmg || has(c, 'dead')) return out;
  if (c.tempHp > 0) {
    const used = Math.min(c.tempHp, dmg);
    c.tempHp -= used;
    dmg -= used;
    out.push(`${c.name}: ${used} absorbed by temporary HP`);
  }
  if (c.hp <= 0) {
    if (dmg <= 0) return out;
    if (dmg >= c.maxHp) {
      die(c);
      out.push(`${c.name} dies (massive damage at 0 HP).`);
      return out;
    }
    c.deathSaves.fail = Math.min(3, c.deathSaves.fail + (opts.crit ? 2 : 1));
    removeCondition(c, 'stable');
    out.push(`${c.name} takes damage while down: death save failures ${c.deathSaves.fail}/3`);
    if (c.deathSaves.fail >= 3) {
      die(c);
      out.push(`${c.name} dies.`);
    }
    return out;
  }
  const before = c.hp;
  const left = c.hp - dmg;
  c.hp = Math.max(0, left);
  out.push(`${c.name}: ${before} → ${c.hp} HP`);
  if (c.hp === 0) {
    if (-left >= c.maxHp) {
      die(c);
      out.push(`${c.name} dies instantly (massive damage).`);
      return out;
    }
    // Relentless Endurance: drop to 1 instead, once per long rest.
    const re = c.counters.find((k) => k.name === 'Relentless Endurance' && k.current > 0);
    if (re) {
      re.current--;
      c.hp = 1;
      out.push(`${c.name} refuses to fall (Relentless Endurance): 1 HP`);
      return out;
    }
    addCondition(c, { name: 'unconscious', source: 'dropped to 0 HP' });
    c.deathSaves = { success: 0, fail: 0 };
    out.push(`${c.name} falls unconscious.`);
    if (c.concentration) {
      out.push(`${c.name} loses concentration on ${c.concentration}.`);
      delete c.concentration;
    }
    return out;
  }
  if (c.concentration) {
    const dc = concentrationDc(dmg, opts.ruleset);
    const r = rollD20(opts.conBonus ?? mod(c.abilities.con));
    if (r.total >= dc) out.push(`${c.name} keeps concentration on ${c.concentration} (CON save ${r.natural}${r.bonus >= 0 ? '+' : ''}${r.bonus} = ${r.total} vs DC ${dc})`);
    else {
      out.push(`${c.name} loses concentration on ${c.concentration} (CON save ${r.total} vs DC ${dc})`);
      delete c.concentration;
    }
  }
  return out;
}

function die(c: GameCharacter) {
  c.hp = 0;
  c.conditions = c.conditions.filter((x) => x.name !== 'unconscious' && x.name !== 'stable');
  addCondition(c, { name: 'dead' });
  delete c.concentration;
}

/** Healing never goes above max HP, and wakes a character at 0 HP. The dead stay dead. */
export function applyHeal(c: GameCharacter, amount: number): string[] {
  const n = Math.max(0, Math.round(amount));
  if (!n || has(c, 'dead')) return n && has(c, 'dead') ? [`${c.name} is dead; healing has no effect.`] : [];
  const before = c.hp;
  c.hp = Math.min(c.maxHp, c.hp + n);
  const out = [`${c.name}: ${before} → ${c.hp} HP`];
  if (before === 0 && c.hp > 0) {
    removeCondition(c, 'unconscious');
    removeCondition(c, 'stable');
    c.deathSaves = { success: 0, fail: 0 };
    out.push(`${c.name} wakes up.`);
  }
  return out;
}

/** A death saving throw result (natural d20). */
export function deathSave(c: GameCharacter, natural: number): string {
  if (natural === 20) {
    c.hp = 1;
    removeCondition(c, 'unconscious');
    c.deathSaves = { success: 0, fail: 0 };
    return `${c.name} rolls a natural 20 and wakes with 1 HP!`;
  }
  if (natural === 1) c.deathSaves.fail += 2;
  else if (natural >= 10) c.deathSaves.success += 1;
  else c.deathSaves.fail += 1;
  if (c.deathSaves.fail >= 3) {
    die(c);
    return `${c.name} dies.`;
  }
  if (c.deathSaves.success >= 3) {
    addCondition(c, { name: 'stable' });
    c.deathSaves = { success: 0, fail: 0 };
    return `${c.name} is stable.`;
  }
  return `${c.name} death saves: ${c.deathSaves.success} successes, ${c.deathSaves.fail} failures`;
}

// ---- The state JSON's deltas ----

export interface Delta {
  pc: string;
  hp?: number;
  tempHp?: number;
  gold?: number;
  counters?: Record<string, number>;
  addItems?: string[];
  removeItems?: string[];
  addConditions?: { name: string; rounds?: number; source?: string }[];
  removeConditions?: string[];
  concentration?: string | null;
}

export const CONDITIONS = [
  'blinded',
  'charmed',
  'deafened',
  'exhaustion',
  'frightened',
  'grappled',
  'incapacitated',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
  // Not SRD conditions, but things the table tracks the same way.
  'hidden',
  'blessed',
  'raging',
  'hasted',
  'dodging',
  'stable',
];

const cleanCondition = (name: string) => name.toLowerCase().trim().replace(/[^a-z -]/g, '').slice(0, 30);

/**
 * Applies the AI's proposed changes, clamped to the rules. HP changes must come from the server's dice results
 * (`backed`): anything else goes to the host for approval, as do big gold gains.
 */
export function applyDeltas(chars: GameCharacter[], deltas: unknown[], opts: { backed: Map<string, number>; settings: GameSettings }): BookResult {
  const res = emptyResult();
  for (const raw of (Array.isArray(deltas) ? deltas : []).slice(0, 40)) {
    if (!raw || typeof raw !== 'object') continue;
    const d = raw as Delta;
    const c = chars.find((x) => sameName(x.name, d.pc));
    if (!c) {
      if (d.pc) res.notes.push(`Bookkeeper ignored a change for unknown character "${clip(String(d.pc), 40)}".`);
      continue;
    }
    if (typeof d.hp === 'number' && d.hp !== 0) {
      const server = opts.backed.get(c.id);
      if (server === undefined) {
        res.approvals.push({ id: newId(), kind: 'delta', characterId: c.id, name: c.name, amount: Math.round(d.hp), reason: `HP ${d.hp > 0 ? '+' : ''}${Math.round(d.hp)} without a dice roll` });
        res.notes.push(`Bookkeeper held back ${c.name} HP ${d.hp > 0 ? '+' : ''}${Math.round(d.hp)}: no roll backs it. The host decides.`);
      } else if (Math.round(d.hp) !== server) res.notes.push(`Bookkeeper corrected ${c.name}'s HP change: the DM wrote ${d.hp}, the dice say ${server}.`);
    }
    if (typeof d.tempHp === 'number' && d.tempHp > 0) {
      // Temporary HP don't stack: keep the higher.
      const t = Math.min(999, Math.round(d.tempHp));
      if (t > c.tempHp) {
        res.changes.push(`${c.name}: ${t} temporary HP`);
        c.tempHp = t;
      }
    }
    if (typeof d.gold === 'number' && d.gold !== 0) {
      const g = Math.round(d.gold);
      if (g > 0 && g > opts.settings.approvalGold) {
        res.approvals.push({ id: newId(), kind: 'gold', characterId: c.id, name: c.name, amount: g, reason: `${g} gp found` });
        res.notes.push(`${c.name} would gain ${g} gp: waiting for the host.`);
      } else if (g < 0 && -g > c.gold) res.notes.push(`Bookkeeper rejected ${c.name} spending ${-g} gp (has ${c.gold}).`);
      else {
        res.changes.push(`${c.name}: ${c.gold} → ${c.gold + g} gp`);
        c.gold += g;
      }
    }
    for (const [name, delta] of Object.entries(d.counters ?? {})) {
      const k = findCounter(c, name);
      const n = Math.round(Number(delta));
      if (!k || !n) {
        if (!k && n) res.notes.push(`Bookkeeper ignored "${clip(name, 40)}" for ${c.name}: no such resource.`);
        continue;
      }
      const next = k.current + n;
      if (next < 0) {
        res.notes.push(`Bookkeeper rejected ${c.name} spending ${-n} ${k.name} (${k.current} left).`);
        continue;
      }
      const clamped = Math.min(k.max, next);
      res.changes.push(`${c.name}: ${k.name} ${k.current}/${k.max} → ${clamped}/${k.max}`);
      k.current = clamped;
    }
    for (const it of (d.addItems ?? []).slice(0, 10)) {
      if (typeof it !== 'string' || !it.trim()) continue;
      const m = /^(\d+)\s*[×x]\s*(.+)$/.exec(it.trim());
      const [qty, name] = m ? [Math.min(999, Number(m[1])), clip(m[2], 80)] : [1, clip(it.trim(), 80)];
      const prev = c.inventory.find((i) => i.name.toLowerCase() === name.toLowerCase());
      if (prev) prev.qty += qty;
      else c.inventory.push({ name, qty });
      res.changes.push(`${c.name} gets ${qty > 1 ? `${qty}× ` : ''}${name}`);
    }
    for (const it of (d.removeItems ?? []).slice(0, 10)) {
      if (typeof it !== 'string') continue;
      const prev = c.inventory.find((i) => sameName(i.name, it) || i.name.toLowerCase() === it.toLowerCase());
      if (!prev) {
        res.notes.push(`Bookkeeper ignored removing "${clip(it, 40)}" from ${c.name}: not in the inventory.`);
        continue;
      }
      prev.qty -= 1;
      if (prev.qty <= 0) c.inventory = c.inventory.filter((i) => i !== prev);
      res.changes.push(`${c.name} loses ${prev.name}`);
    }
    for (const cond of (d.addConditions ?? []).slice(0, 8)) {
      const name = cleanCondition(typeof cond === 'string' ? cond : (cond?.name ?? ''));
      if (!name || name === 'dead' || name === 'unconscious') continue; // only HP decides those
      if (name === 'exhaustion') {
        c.exhaustion = Math.min(6, c.exhaustion + 1);
        res.changes.push(`${c.name}: exhaustion ${c.exhaustion}`);
        if (c.exhaustion >= 6) {
          die(c);
          res.changes.push(`${c.name} dies of exhaustion.`);
        }
        continue;
      }
      if (!CONDITIONS.includes(name)) res.notes.push(`Condition "${name}" on ${c.name} is not an SRD condition; tracked anyway.`);
      const rounds = typeof cond === 'object' && typeof cond.rounds === 'number' ? Math.max(1, Math.min(10_000, Math.round(cond.rounds))) : undefined;
      addCondition(c, { name, rounds, source: typeof cond === 'object' && cond.source ? clip(cond.source, 60) : undefined });
      res.changes.push(`${c.name} is ${name}${rounds ? ` (${rounds} rounds)` : ''}`);
    }
    for (const cond of (d.removeConditions ?? []).slice(0, 8)) {
      const name = cleanCondition(String(cond));
      if (name === 'dead' || name === 'unconscious') continue;
      if (c.conditions.some((x) => x.name === name)) {
        removeCondition(c, name);
        res.changes.push(`${c.name} is no longer ${name}`);
      }
    }
    if (d.concentration !== undefined) {
      if (d.concentration && !isDown(c)) {
        if (c.concentration && c.concentration !== d.concentration) res.changes.push(`${c.name} drops ${c.concentration}`);
        c.concentration = clip(String(d.concentration), 60);
        res.changes.push(`${c.name} concentrates on ${c.concentration}`);
      } else if (!d.concentration && c.concentration) {
        res.changes.push(`${c.name} stops concentrating on ${c.concentration}`);
        delete c.concentration;
      }
    }
  }
  return res;
}

// ---- XP and levels ----

export function applyXp(chars: GameCharacter[], xp: unknown, settings: GameSettings): BookResult {
  const res = emptyResult();
  if (settings.xpMode === 'milestone') {
    if (Array.isArray(xp) && xp.length) res.notes.push('XP from the DM ignored: this game levels by milestones (host: Level up the party).');
    return res;
  }
  for (const raw of (Array.isArray(xp) ? xp : []).slice(0, 20)) {
    const e = raw as { pc?: string; amount?: number; reason?: string };
    const amount = Math.round(Number(e?.amount));
    if (!amount || amount < 0) continue;
    const targets = !e.pc || /^(all|party|everyone)$/i.test(e.pc) ? chars.filter((c) => !has(c, 'dead')) : chars.filter((c) => sameName(c.name, e.pc));
    for (const c of targets) {
      if (amount > settings.approvalXp) {
        res.approvals.push({ id: newId(), kind: 'xp', characterId: c.id, name: c.name, amount, reason: clip(e.reason ?? 'XP', 120) });
        res.notes.push(`${c.name} would get ${amount} XP: waiting for the host.`);
        continue;
      }
      c.xp += amount;
      res.changes.push(`${c.name} +${amount} XP${e.reason ? ` (${clip(e.reason, 80)})` : ''}`);
    }
  }
  return res;
}

/** After every round: does anyone reach the next level? The end level is the cap. */
export function levelCheck(chars: GameCharacter[], endLevel: number): string[] {
  const out: string[] = [];
  for (const c of chars) {
    const ready = c.level < Math.min(20, endLevel) && c.xp >= XP_TABLE[c.level + 1];
    if (ready && !c.levelUpPending) out.push(`${c.name} reached level ${c.level + 1}! Open the level-up.`);
    c.levelUpPending = ready || undefined;
  }
  return out;
}

// ---- Time ----

/** Conditions with a duration count down; expired ones end. */
export function tickConditions(chars: GameCharacter[], rounds = 1): string[] {
  const out: string[] = [];
  for (const c of chars) {
    for (const x of c.conditions) if (x.rounds !== undefined) x.rounds -= rounds;
    const ended = c.conditions.filter((x) => x.rounds !== undefined && x.rounds <= 0);
    if (ended.length) {
      c.conditions = c.conditions.filter((x) => !ended.includes(x));
      out.push(`${c.name}: ${ended.map((x) => x.name).join(', ')} ended`);
    }
  }
  return out;
}

/** Counters that come back every turn (reactions, per-turn features). */
export function rechargeTurn(chars: GameCharacter[]) {
  for (const c of chars) for (const k of c.counters) if (k.recharge === 'turn') k.current = k.max;
}

/**
 * Short rest: short-recharge counters refill; spend hit dice (rolled by the server, + CON each).
 * Long rest: everything refills, HP to max, hit dice back (2014: half, 2024: all), exhaustion −1, temporary HP gone.
 */
export function rest(chars: GameCharacter[], kind: 'short' | 'long', ruleset: Ruleset, hitDice: Record<string, number> = {}): string[] {
  const out: string[] = [];
  for (const c of chars) {
    if (has(c, 'dead')) continue;
    const refilled: string[] = [];
    for (const k of c.counters) {
      if (k.name.startsWith('Hit Dice')) continue;
      const back = kind === 'long' ? ['short', 'long', 'dawn', 'turn'].includes(k.recharge) : ['short', 'turn'].includes(k.recharge);
      if (back && k.current < k.max) {
        k.current = k.max;
        refilled.push(k.name);
      }
    }
    const hd = c.counters.find((k) => k.name.startsWith('Hit Dice'));
    if (kind === 'short') {
      const n = Math.max(0, Math.min(hd?.current ?? 0, Math.round(hitDice[c.id] ?? 0)));
      if (n && hd && c.hp > 0) {
        const r = roll(`${n}d${c.hitDie}`);
        const gain = r.dice.reduce((s, d) => s + Math.max(0, d.value + mod(c.abilities.con)), 0);
        hd.current -= n;
        const before = c.hp;
        c.hp = Math.min(c.maxHp, c.hp + gain);
        out.push(`${c.name} spends ${n} Hit ${n > 1 ? 'Dice' : 'Die'} (${r.dice.map((d) => d.value).join(', ')} + CON): ${before} → ${c.hp} HP`);
      }
    } else {
      const before = c.hp;
      if (c.hp > 0 || has(c, 'stable')) {
        c.hp = c.maxHp;
        removeCondition(c, 'unconscious');
        removeCondition(c, 'stable');
      }
      c.tempHp = 0;
      c.deathSaves = { success: 0, fail: 0 };
      if (hd) {
        const regain = ruleset === 'srd52' ? hd.max : Math.max(1, Math.floor(hd.max / 2));
        hd.current = Math.min(hd.max, hd.current + regain);
      }
      if (c.exhaustion > 0) c.exhaustion--;
      if (before !== c.hp) out.push(`${c.name}: ${before} → ${c.hp} HP`);
      c.conditions = c.conditions.filter((x) => x.rounds === undefined || x.name === 'dead');
    }
    if (refilled.length) out.push(`${c.name} regains ${refilled.join(', ')}`);
  }
  return out;
}

// ---- NPCs ----
export function damageNpc(n: Npc, amount: number): string {
  if (n.hp === undefined) return `${n.name} takes ${amount} damage`;
  const before = n.hp;
  n.hp = Math.max(0, n.hp - Math.max(0, Math.round(amount)));
  if (n.hp === 0 && n.status !== 'dead') n.status = 'dead';
  return `${n.name}: ${before} → ${n.hp} HP${n.hp === 0 ? ' (down)' : ''}`;
}
export function healNpc(n: Npc, amount: number): string {
  if (n.hp === undefined) return `${n.name} heals ${amount}`;
  const before = n.hp;
  n.hp = Math.min(n.maxHp ?? n.hp + amount, n.hp + Math.round(amount));
  if (n.hp > 0 && n.status === 'dead') n.status = 'hostile';
  return `${n.name}: ${before} → ${n.hp} HP`;
}
