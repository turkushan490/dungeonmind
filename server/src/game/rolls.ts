import { SKILLS, type Ability, type GameCharacter, type Npc, type PendingRoll, type RollOutcome, type RulesData } from '@dungeonmind/shared';
import { combineAdv, DiceError, parseDice, roll, rollD20, type Adv } from './dice.js';
import { derive, itemByName } from './character.js';
import { clip, sameName } from './text.js';

/** What dnd-adjudicate returns. */
export interface Adjudication {
  rolls?: RawRoll[];
  resources?: { pc: string; name: string; amount: number }[];
  refused?: { pc: string; reason: string }[];
  notes?: string;
}
export interface RawRoll {
  id?: string;
  actor?: string;
  pc?: string;
  kind?: string;
  ability?: string;
  skill?: string;
  dc?: number;
  target?: string;
  targetAc?: number;
  adv?: string;
  dice?: string;
  bonus?: number;
  damageType?: string;
  weapon?: string;
  spell?: string;
  onHit?: string;
  onFail?: string;
  half?: boolean;
  reason?: string;
}

const ABIL: Ability[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const abilityOf = (s: string | undefined): Ability | undefined => {
  const k = String(s ?? '').toLowerCase().slice(0, 3);
  return ABIL.includes(k as Ability) ? (k as Ability) : undefined;
};
const skillOf = (s: string | undefined) => {
  const k = String(s ?? '').toLowerCase().trim().replace(/\s+/g, '-');
  return k in SKILLS ? k : undefined;
};

/** Conditions that change the actor's own d20 rolls. */
export function conditionAdv(c: GameCharacter | undefined, kind: string, ability?: Ability, ruleset = 'srd51'): Adv {
  if (!c) return 'none';
  const on = (n: string) => c.conditions.some((x) => x.name === n);
  const src: Adv[] = [];
  if (kind === 'attack') {
    if (['blinded', 'frightened', 'poisoned', 'prone', 'restrained'].some(on)) src.push('dis');
    if (on('invisible') || on('hidden')) src.push('adv');
    if (ruleset === 'srd51' && c.exhaustion >= 3) src.push('dis');
  }
  if (kind === 'check') {
    if (on('poisoned') || on('frightened')) src.push('dis');
    if (ruleset === 'srd51' && c.exhaustion >= 1) src.push('dis');
  }
  if (kind === 'save') {
    if (on('restrained') && ability === 'dex') src.push('dis');
    if (ruleset === 'srd51' && c.exhaustion >= 3) src.push('dis');
    if (on('dodging') && ability === 'dex') src.push('adv');
  }
  return combineAdv(...src);
}

/** Attacks against a target with these conditions have advantage. */
const targetGivesAdv = (c: GameCharacter | undefined) => !!c && c.conditions.some((x) => ['blinded', 'paralyzed', 'restrained', 'stunned', 'unconscious', 'petrified'].includes(x.name));

function safeDice(expr: string | undefined, fallback: string): string {
  try {
    if (expr) {
      parseDice(expr);
      return expr.replace(/\s+/g, '');
    }
  } catch {}
  return fallback;
}

/**
 * Turns the adjudicator's roll list into rolls the server can run. For player characters every modifier
 * comes from the sheet; the AI's numbers are only used for NPCs.
 */
export function buildRolls(rules: RulesData, chars: GameCharacter[], npcs: Npc[], adj: Adjudication): PendingRoll[] {
  const out: PendingRoll[] = [];
  const ids = new Map<string, string>();
  const list = (Array.isArray(adj.rolls) ? adj.rolls : []).slice(0, 30);
  list.forEach((r, i) => ids.set(String(r?.id ?? `r${i + 1}`), `r${i + 1}`));
  for (const [i, r] of list.entries()) {
    if (!r || typeof r !== 'object') continue;
    const kind = (['attack', 'save', 'check', 'damage', 'heal'].includes(String(r.kind)) ? r.kind : 'check') as PendingRoll['kind'];
    const actorName = clip(String(r.actor ?? r.pc ?? 'Someone'), 60);
    const pc = chars.find((c) => sameName(c.name, actorName));
    const targetPc = chars.find((c) => sameName(c.name, r.target));
    const targetNpc = npcs.find((n) => sameName(n.name, r.target));
    const d = pc ? derive(rules, pc) : undefined;
    const ability = abilityOf(r.ability);
    const skill = skillOf(r.skill);
    const exh2024 = rules.ruleset === 'srd52' && pc ? 2 * pc.exhaustion : 0;
    const base: PendingRoll = {
      id: `r${i + 1}`,
      actor: pc?.name ?? actorName,
      characterId: pc?.id,
      kind,
      label: '',
      dice: '1d20',
      adv: 'none',
      bonus: 0,
      target: r.target ? clip(String(r.target), 60) : undefined,
      damageType: r.damageType ? clip(String(r.damageType), 20) : undefined,
      onHit: r.onHit ? ids.get(String(r.onHit)) : undefined,
      onFail: r.onFail ? ids.get(String(r.onFail)) : undefined,
      half: r.half ? true : undefined,
      reason: r.reason ? clip(String(r.reason), 160) : undefined,
      auto: !pc,
    };
    const aiAdv = (['adv', 'dis'].includes(String(r.adv)) ? r.adv : 'none') as Adv;
    if (kind === 'attack') {
      let bonus = Number(r.bonus) || 0;
      let what = r.weapon || r.spell || 'attack';
      if (pc && d) {
        if (r.spell) bonus = d.spellAttack ?? d.profBonus + Math.max(d.mods.int, d.mods.wis, d.mods.cha);
        else {
          const item = (r.weapon && pc.inventory.find((it) => sameName(it.name, r.weapon))) || pc.inventory.find((it) => it.equipped && itemByName(rules, it.name)?.damage);
          const w = item ? itemByName(rules, item.name) : undefined;
          const finesse = w?.properties?.some((p) => /finesse/i.test(p));
          const ranged = /ranged/i.test(w?.category ?? '');
          const m = finesse ? Math.max(d.mods.str, d.mods.dex) : ranged ? d.mods.dex : d.mods.str;
          bonus = m + d.profBonus - exh2024;
          what = item?.name ?? 'unarmed strike';
        }
      }
      const ac = targetPc ? derive(rules, targetPc).ac : (targetNpc?.ac ?? (Number(r.targetAc) || 12));
      Object.assign(base, {
        label: `${base.actor} attacks${base.target ? ` ${base.target}` : ''} (${what})`,
        bonus,
        targetAc: ac,
        adv: combineAdv(aiAdv, conditionAdv(pc, 'attack', undefined, rules.ruleset), targetGivesAdv(targetPc) ? 'adv' : 'none'),
      });
    } else if (kind === 'save') {
      const ab = ability ?? 'dex';
      // A PC's spell sets the DC: use the caster's real spell save DC when the AI names a caster in "reason"/"spell".
      const caster = chars.find((c) => c !== pc && r.spell && (c.spells ?? []).concat(c.cantrips ?? []).some((s) => sameName(s.replace(/-/g, ' '), String(r.spell).replace(/-/g, ' '))));
      const dc = caster ? (derive(rules, caster).spellDc ?? Number(r.dc)) : Number(r.dc) || 10;
      Object.assign(base, {
        label: `${base.actor} ${ab.toUpperCase()} save`,
        bonus: pc && d ? d.saveBonus[ab] : Number(r.bonus) || 0,
        dc,
        adv: combineAdv(aiAdv, conditionAdv(pc, 'save', ab, rules.ruleset)),
      });
    } else if (kind === 'check') {
      const ab = ability ?? (skill ? SKILLS[skill] : 'wis');
      Object.assign(base, {
        label: `${base.actor} ${skill ? skill.replace(/-/g, ' ') : ab.toUpperCase()} check`,
        bonus: pc && d ? (skill ? d.skillBonus[skill] : d.mods[ab] - exh2024) : Number(r.bonus) || 0,
        dc: Number(r.dc) || undefined,
        adv: combineAdv(aiAdv, conditionAdv(pc, 'check', ab, rules.ruleset)),
      });
    } else {
      // damage / heal
      let dice = safeDice(r.dice, kind === 'heal' ? '1d4' : '1d6');
      if (kind === 'damage' && pc && d && !r.spell) {
        const item = (r.weapon && pc.inventory.find((it) => sameName(it.name, r.weapon))) || pc.inventory.find((it) => it.equipped && itemByName(rules, it.name)?.damage);
        const w = item ? itemByName(rules, item.name) : undefined;
        if (w?.damage) {
          const finesse = w.properties?.some((p) => /finesse/i.test(p));
          const ranged = /ranged/i.test(w.category);
          const m = finesse ? Math.max(d.mods.str, d.mods.dex) : ranged ? d.mods.dex : d.mods.str;
          dice = `${w.damage}${m >= 0 ? '+' : ''}${m}`;
          base.damageType = w.damageType ?? base.damageType;
        }
      }
      Object.assign(base, {
        label: `${base.actor} ${kind === 'heal' ? 'healing' : 'damage'}${base.target ? ` → ${base.target}` : ''}${base.damageType ? ` (${base.damageType})` : ''}`,
        dice,
        bonus: 0,
        adv: undefined,
      });
    }
    out.push(base);
  }
  // Dependencies on rolls that don't exist are dropped.
  for (const r of out) {
    if (r.onHit && !out.some((x) => x.id === r.onHit)) delete r.onHit;
    if (r.onFail && !out.some((x) => x.id === r.onFail)) delete r.onFail;
  }
  return out;
}

/** Can this roll be made now (its parent is resolved)? */
export function ready(r: PendingRoll, all: PendingRoll[]): boolean {
  if (r.result) return false;
  const parent = all.find((x) => x.id === (r.onHit ?? r.onFail));
  return !parent || !!parent.result;
}

/**
 * Rolls (or takes the player's dice for) one roll. Throws DiceError for impossible manual values.
 * Then skips the children that no longer happen (a miss, a made save) and marks crits.
 */
export function resolveRoll(r: PendingRoll, all: PendingRoll[], manual?: number[]): RollOutcome {
  const parent = all.find((x) => x.id === (r.onHit ?? r.onFail));
  if (r.kind === 'damage' || r.kind === 'heal' || r.kind === 'hitdie') {
    const out = roll(r.dice, { manual, crit: r.crit });
    let total = Math.max(0, out.total);
    const halved = !!(r.half && parent?.result?.success && r.onFail);
    if (halved) total = Math.floor(total / 2);
    const res: RollOutcome = {
      dice: out.dice.filter((x) => !x.dropped).map((x) => x.value),
      total,
      manual: out.manual,
      crit: r.crit,
      text: `${r.label}: ${r.dice}${r.crit ? ' (critical, dice doubled)' : ''} → [${out.dice.map((x) => x.value).join(', ')}] = ${out.total}${halved ? `, halved: ${total}` : ''}${out.manual ? ' (rolled by the player)' : ''}`,
    };
    r.result = res;
    return res;
  }
  const d = rollD20(r.bonus, (r.adv ?? 'none') as Adv, manual);
  let success: boolean | undefined;
  let vs = '';
  if (r.kind === 'attack') {
    success = d.crit || (!d.fumble && d.total >= (r.targetAc ?? 10));
    vs = ` vs AC ${r.targetAc} — ${d.crit ? 'critical hit!' : d.fumble ? 'natural 1, miss' : success ? 'hit' : 'miss'}`;
  } else if (r.kind === 'death') {
    success = d.natural >= 10;
    vs = d.natural === 20 ? ' — natural 20!' : d.natural === 1 ? ' — natural 1, two failures' : success ? ' — success' : ' — failure';
  } else if (r.dc !== undefined) {
    success = d.total >= r.dc;
    vs = ` vs DC ${r.dc} — ${success ? 'success' : 'failure'}`;
  }
  const advText = d.adv === 'none' ? '' : ` (${d.adv === 'adv' ? 'advantage' : 'disadvantage'}: ${d.rolls.join(' / ')})`;
  const res: RollOutcome = {
    dice: d.rolls,
    natural: d.natural,
    total: d.total,
    manual: d.manual,
    success,
    crit: d.crit,
    fumble: d.fumble,
    text: `${r.label}: d20 ${d.natural}${advText} ${r.bonus >= 0 ? '+' : '−'} ${Math.abs(r.bonus)} = ${d.total}${vs}${d.manual ? ' (rolled by the player)' : ''}`,
  };
  r.result = res;
  // Children: damage after a hit (doubled dice on a crit), damage after a failed save.
  for (const child of all.filter((x) => x.onHit === r.id || x.onFail === r.id)) {
    if (child.onHit === r.id && !success) child.result = { dice: [], total: 0, manual: false, skipped: true, text: `${child.label}: no damage (missed)` };
    if (child.onHit === r.id && success && d.crit) child.crit = true;
    if (child.onFail === r.id && success && !child.half) child.result = { dice: [], total: 0, manual: false, skipped: true, text: `${child.label}: no effect (save made)` };
  }
  return res;
}

/** HP changes the dice caused: per PC id (net) and per NPC name. */
export function rollEffects(rolls: PendingRoll[], chars: GameCharacter[], npcs: Npc[]) {
  const pcs = new Map<string, { damage: number; heal: number; crit: boolean }>();
  const foes = new Map<string, { damage: number; heal: number }>();
  for (const r of rolls) {
    if (!r.result || r.result.skipped || (r.kind !== 'damage' && r.kind !== 'heal')) continue;
    const targetName = r.target ?? (r.kind === 'heal' ? r.actor : undefined);
    if (!targetName) continue;
    const pc = chars.find((c) => sameName(c.name, targetName));
    if (pc) {
      const e = pcs.get(pc.id) ?? { damage: 0, heal: 0, crit: false };
      if (r.kind === 'damage') e.damage += r.result.total;
      else e.heal += r.result.total;
      e.crit ||= !!r.crit;
      pcs.set(pc.id, e);
      continue;
    }
    const n = npcs.find((x) => sameName(x.name, targetName));
    if (n) {
      const e = foes.get(n.name) ?? { damage: 0, heal: 0 };
      if (r.kind === 'damage') e.damage += r.result.total;
      else e.heal += r.result.total;
      foes.set(n.name, e);
    }
  }
  return { pcs, foes };
}

export { DiceError };
