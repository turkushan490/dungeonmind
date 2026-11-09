import { SKILLS, type Ability, type BonusDie, type GameCharacter, type Npc, type PendingRoll, type RollOutcome, type RulesData, type RulesSpell } from '@dungeonmind/shared';
import { findIn } from '../rules/index.js';
import { checkManual, combineAdv, DiceError, diceNeeded, parseDice, roll, rollD20, type Adv } from './dice.js';
import { derive, itemByName } from './character.js';
import { normalizeCounterName } from './bookkeeper.js';
import { actionNamed, monsterAttack, monsterCheck, monsterOf, monsterSave, type MonsterAction } from './monsters.js';
import { critOn, damageRiders, featureAdv, featureHeal, isRanged } from './features.js';
import { cantripTier, knownSpell, spellCount, spellDice, spellMod, spellSaveDc } from './spells.js';
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
  /** Class features the roll uses: "Sneak Attack", "Divine Smite", "Second Wind". */
  features?: string[];
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

/** Conditions combined for callers with no other sources of advantage. */
export function conditionAdv(c: GameCharacter | undefined, kind: string, ability?: Ability, ruleset = 'srd51'): Adv {
  return combineAdv(...conditionAdvValues(c, kind, ability, ruleset));
}

/** Conditions that change the actor's own d20 rolls. */
function conditionAdvValues(c: GameCharacter | undefined, kind: string, ability?: Ability, ruleset = 'srd51'): Adv[] {
  if (!c) return [];
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
  return src;
}

/**
 * Dice the roller's conditions add to a d20 test: Bless (attacks and saves), Guidance (one ability check),
 * Bardic Inspiration (one attack, save or check; the die is in the condition's source, "Bardic Inspiration d8").
 * One-shot dice go to the first roll of the turn that can use them (`used` remembers which went out).
 */
export function bonusDiceFor(c: GameCharacter, kind: PendingRoll['kind'], used: Set<string>): BonusDie[] {
  const has = (name: string) => c.conditions.find((x) => x.name === name);
  const out: BonusDie[] = [];
  const once = (condition: string, dice: string, from: string) => {
    if (used.has(`${c.id}:${condition}`)) return;
    used.add(`${c.id}:${condition}`);
    out.push({ dice, from, condition, once: true });
  };
  if (has('blessed') && (kind === 'attack' || kind === 'save')) out.push({ dice: '1d4', from: 'Bless', condition: 'blessed' });
  if (has('guided') && kind === 'check') once('guided', '1d4', 'Guidance');
  const inspired = has('inspired');
  if (inspired && (kind === 'attack' || kind === 'save' || kind === 'check')) once('inspired', `1d${/d(6|8|10|12)\b/.exec(inspired.source ?? '')?.[1] ?? 6}`, 'Bardic Inspiration');
  return out;
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

interface Cast {
  spell: RulesSpell;
  caster: GameCharacter;
  slot: number;
}

/** The spell slots the adjudicator spends, per character id, lowest first. */
function spentSlots(chars: GameCharacter[], resources: Adjudication['resources']): Map<string, number[]> {
  const slots = new Map<string, number[]>();
  for (const w of Array.isArray(resources) ? resources : []) {
    const c = chars.find((x) => sameName(x.name, w?.pc));
    const m = c && /^(?:Spell|Pact) slot L(\d)$/.exec(normalizeCounterName(String(w?.name ?? '')));
    if (!c || !m) continue;
    const free = slots.get(c.id) ?? [];
    for (let k = 0; k < Math.min(9, Math.max(1, Math.round(Number(w.amount) || 1))); k++) free.push(Number(m[1]));
    slots.set(c.id, free.sort((a, b) => a - b));
  }
  return slots;
}

/**
 * The PC spell behind each roll: the spell it names (a damage roll also its attack's or save's), who casts it,
 * and the slot it's cast with (taken out of `slots`, lowest that fits first; what's left is for smites).
 */
function spellCasts(rules: RulesData, chars: GameCharacter[], npcs: Npc[], list: RawRoll[], slots: Map<string, number[]>): (Cast | undefined)[] {
  const index = new Map(list.map((r, i) => [String(r?.id ?? `r${i + 1}`), i]));
  const byKey = new Map<string, Cast>();
  const out: (Cast | undefined)[] = [];
  list.forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    const p = index.get(String(r.onHit ?? r.onFail ?? ''));
    // A damage roll without a spell of its own belongs to its attack's or save's spell.
    if (!r.spell) {
      if (p !== undefined && p < i) out[i] = out[p];
      return;
    }
    const actorName = String(r.actor ?? r.pc ?? '');
    const actor = chars.find((c) => sameName(c.name, actorName));
    // A save names the target as its actor: the caster is whoever else at the table has the spell. A monster's own spell isn't a PC's.
    let caster = r.kind !== 'save' && knownSpell(rules, actor, r.spell) ? actor : undefined;
    if (!caster && (r.kind === 'save' || actor || !npcs.some((n) => sameName(n.name, actorName)))) caster = chars.find((c) => c !== actor && knownSpell(rules, c, r.spell));
    const spell = caster && findIn(rules.spells, r.spell);
    if (!caster || !spell) return;
    // Every roll of one spell by one caster is one cast, with one slot.
    const key = `${caster.id}|${spell.id}`;
    let cast = byKey.get(key);
    if (!cast) {
      const free = slots.get(caster.id) ?? [];
      const k = free.findIndex((l) => l >= spell.level);
      cast = { spell, caster, slot: spell.level === 0 ? 0 : k >= 0 ? free.splice(k, 1)[0] : spell.level };
      byKey.set(key, cast);
    }
    out[i] = cast;
  });
  return out;
}

/** A damage type the caster picks from a list ("acid|cold|fire") is the AI's pick when it's one of them; "weapon" is the weapon's. */
function pickType(options: string, ai: string | undefined): string | undefined {
  if (options === 'weapon') return ai;
  const list = options.split('|');
  return list.find((t) => t === ai?.toLowerCase()) ?? list[0];
}

/**
 * Turns the adjudicator's roll list into rolls the server can run. For player characters every modifier
 * comes from the sheet, for SRD monsters from the stat block, and a PC's spell rolls its own dice; the AI's numbers are only used for other NPCs.
 */
export function buildRolls(rules: RulesData, chars: GameCharacter[], npcs: Npc[], adj: Adjudication): PendingRoll[] {
  const out: PendingRoll[] = [];
  const ids = new Map<string, string>();
  const list = (Array.isArray(adj.rolls) ? adj.rolls : []).slice(0, 30);
  const used = new Set<string>();
  // The stat-block attack each monster attack roll uses, so its damage roll uses the same line.
  const attackOf = new Map<string, MonsterAction>();
  const present = npcs.filter((n) => n.status !== 'dead' && n.status !== 'fled');
  list.forEach((r, i) => ids.set(String(r?.id ?? `r${i + 1}`), `r${i + 1}`));
  const slots = spentSlots(chars, adj.resources);
  const casts = spellCasts(rules, chars, npcs, list, slots);
  // Darts that always hit (Magic Missile): how many each cast has left, and over how many damage rolls the AI spread them.
  const darts = new Map<Cast, { left: number; rolls: number }>();
  list.forEach((r, i) => {
    const c = casts[i];
    if (r?.kind !== 'damage' || !c?.spell.effect?.autoHit) return;
    const e = darts.get(c) ?? { left: spellCount(c.spell.effect, c.spell.level, c.slot, c.caster.level), rolls: 0 };
    e.rolls++;
    darts.set(c, e);
  });
  for (const [i, r] of list.entries()) {
    if (!r || typeof r !== 'object') continue;
    const kind = (['attack', 'save', 'check', 'damage', 'heal'].includes(String(r.kind)) ? r.kind : 'check') as PendingRoll['kind'];
    const actorName = clip(String(r.actor ?? r.pc ?? 'Someone'), 60);
    const pc = chars.find((c) => sameName(c.name, actorName));
    const targetPc = chars.find((c) => sameName(c.name, r.target));
    const targetNpc = npcs.find((n) => sameName(n.name, r.target));
    const d = pc ? derive(rules, pc) : undefined;
    const mon = pc ? undefined : monsterOf(rules, npcs.find((n) => n.name.toLowerCase() === actorName.toLowerCase()) ?? npcs.find((n) => sameName(n.name, actorName)));
    const ability = abilityOf(r.ability);
    const skill = skillOf(r.skill);
    const exh2024 = rules.ruleset === 'srd52' && pc ? 2 * pc.exhaustion : 0;
    const cast = casts[i];
    const effect = cast?.spell.effect;
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
        if (r.spell) bonus = d.profBonus + spellMod(rules, pc, findIn(rules.spells, r.spell)) - exh2024;
        else {
          const item = (r.weapon && pc.inventory.find((it) => sameName(it.name, r.weapon))) || pc.inventory.find((it) => it.equipped && itemByName(rules, it.name)?.damage);
          const w = item ? itemByName(rules, item.name) : undefined;
          const finesse = w?.properties?.some((p) => /finesse/i.test(p));
          const ranged = isRanged(rules, w);
          const m = finesse ? Math.max(d.mods.str, d.mods.dex) : ranged ? d.mods.dex : d.mods.str;
          bonus = m + d.profBonus - exh2024;
          what = item?.name ?? 'unarmed strike';
        }
      } else if (mon) {
        const a = monsterAttack(mon, r.weapon || r.spell);
        if (a) {
          bonus = a.attack!;
          what = a.name.replace(/^Legendary: /, '');
          attackOf.set(base.id, a);
        }
      }
      const ac = targetPc ? derive(rules, targetPc).ac : (targetNpc?.ac ?? (Number(r.targetAc) || 12));
      Object.assign(base, {
        label: `${base.actor} attacks${base.target ? ` ${base.target}` : ''} (${what})`,
        bonus,
        targetAc: ac,
        adv: combineAdv(aiAdv, ...conditionAdvValues(pc, 'attack', undefined, rules.ruleset), targetGivesAdv(targetPc) ? 'adv' : 'none', featureAdv(rules, pc, 'attack', undefined, !!r.spell) ? 'adv' : 'none'),
      });
      // Improved Critical: weapon attacks only.
      const crit = pc && !r.spell ? critOn(rules, pc) : 20;
      if (crit < 20) base.critOn = crit;
    } else if (kind === 'save') {
      // A PC's spell sets the ability and the DC: the caster's real spell save DC.
      const ab = effect?.save ?? ability ?? 'dex';
      const caster = cast && cast.caster !== pc ? cast.caster : undefined;
      // A monster's breath, bite or gaze: its stat block sets the DC. A PC's spell: its own class's DC.
      const source = caster ? undefined : statBlockDc(rules, present, r.spell || r.weapon, actorName);
      const dc = caster ? (spellSaveDc(rules, caster, cast?.spell) ?? Number(r.dc)) : (source ?? (Number(r.dc) || 10));
      Object.assign(base, {
        label: `${base.actor} ${ab.toUpperCase()} save`,
        bonus: pc && d ? d.saveBonus[ab] : mon ? monsterSave(mon, ab) : Number(r.bonus) || 0,
        dc,
        adv: combineAdv(aiAdv, ...conditionAdvValues(pc, 'save', ab, rules.ruleset), featureAdv(rules, pc, 'save', ab) ? 'adv' : 'none'),
      });
    } else if (kind === 'check') {
      const ab = ability ?? (skill ? SKILLS[skill] : 'wis');
      Object.assign(base, {
        label: `${base.actor} ${skill ? skill.replace(/-/g, ' ') : ab.toUpperCase()} check`,
        bonus: pc && d ? (skill ? d.skillBonus[skill] : d.mods[ab] - exh2024) : mon ? monsterCheck(mon, ab, skill) : Number(r.bonus) || 0,
        dc: Number(r.dc) || undefined,
        adv: combineAdv(aiAdv, ...conditionAdvValues(pc, 'check', ab, rules.ruleset), featureAdv(rules, pc, 'check', ab) ? 'adv' : 'none'),
      });
    } else {
      // damage / heal
      let dice = safeDice(r.dice, kind === 'heal' ? '1d4' : '1d6');
      const named = Array.isArray(r.features) ? r.features.slice(0, 6).map((f) => clip(String(f), 40)) : undefined;
      const from: string[] = [];
      if (kind === 'damage' && pc && d && !r.spell) {
        const item = (r.weapon && pc.inventory.find((it) => sameName(it.name, r.weapon))) || pc.inventory.find((it) => it.equipped && itemByName(rules, it.name)?.damage);
        const w = item ? itemByName(rules, item.name) : undefined;
        const finesse = !!w?.properties?.some((p) => /finesse/i.test(p));
        const ranged = isRanged(rules, w);
        const m = !w ? d.mods.str : finesse ? Math.max(d.mods.str, d.mods.dex) : ranged ? d.mods.dex : d.mods.str;
        if (w?.damage) {
          dice = `${w.damage}${m >= 0 ? '+' : ''}${m}`;
          base.damageType = w.damageType ?? base.damageType;
        }
        // Features on the hit: Rage and Divine Strike on their own, Sneak Attack and Smite when the adjudicator names them.
        const extra = damageRiders(rules, pc, { weapon: w?.damage ? w : undefined, str: !ranged && m === d.mods.str, named, type: r.damageType, used, slots: slots.get(pc.id) ?? [] });
        for (const x of extra.riders) {
          dice += `+${x.dice}`;
          from.push(`${x.from} ${x.dice}`);
          if (x.type) base.damageType = [...new Set([...(base.damageType?.split(', ') ?? []), x.type])].join(', ');
        }
        if (extra.notes.length) base.reason = clip([base.reason, ...extra.notes].filter(Boolean).join('; '), 160);
      } else if (kind === 'damage' && mon) {
        // After an attack: that attack's damage. Otherwise the action the AI names (a breath weapon), if it deals damage.
        const parent = base.onHit ?? base.onFail;
        const a = (parent && attackOf.get(parent)) || actionNamed(mon, r.weapon || r.spell);
        if (a?.damage) {
          dice = a.damage;
          base.damageType = a.damageType ?? base.damageType;
        }
      }
      if (kind === 'heal' && pc && !r.spell) {
        const h = featureHeal(rules, pc, named);
        if (h) {
          dice = h.dice;
          from.push(h.from);
        }
      }
      if (cast && effect && (kind === 'damage' ? effect.damage?.length : effect.heal)) {
        const s = cast.spell;
        const o = { mod: spellMod(rules, cast.caster, s), above: s.level ? Math.floor(Math.max(0, cast.slot - s.level) / (effect.upcastEvery ?? 1)) : 0 };
        if (kind === 'heal') dice = spellDice(effect.heal!, { ...o, upcast: effect.upcast });
        else {
          const tier = s.level === 0 && effect.scales === 'dice' ? cantripTier(cast.caster.level) : 1;
          // One roll takes all the darts; several split them as the AI's dice say, up to the darts there are.
          let times = 1;
          const left = darts.get(cast);
          if (left) {
            const per = parseDice(effect.damage![0].dice.replace(/[+-]?mod/, '')).terms[0];
            const said = safeDice(r.dice, '') ? (parseDice(r.dice!).terms.find((t) => t.sides === per?.sides)?.count ?? 0) / (per?.count ?? 1) : 1;
            times = left.rolls === 1 ? left.left : Math.max(1, Math.min(Math.round(said) || 1, left.left));
            left.left = Math.max(0, left.left - times);
          }
          dice = effect.damage!.map((p, j) => spellDice(p.dice, { ...o, tier, times, upcast: p.upcast ?? (j ? undefined : effect.upcast) })).join('+');
          const types = effect.damage!.map((p) => pickType(p.type, r.damageType)).filter(Boolean);
          base.damageType = types.length ? [...new Set(types)].join(', ') : base.damageType;
          if (base.onFail) base.half = effect.half || undefined;
        }
      }
      Object.assign(base, {
        label: `${base.actor} ${kind === 'heal' ? 'healing' : 'damage'}${from.length ? ` with ${from.join(', ')}` : ''}${base.target ? ` → ${base.target}` : ''}${base.damageType ? ` (${base.damageType})` : ''}`,
        dice,
        bonus: 0,
        adv: undefined,
      });
    }
    if (pc && kind !== 'damage' && kind !== 'heal') {
      const extra = bonusDiceFor(pc, kind, used);
      if (extra.length) base.bonusDice = extra;
      if (pc.species === 'halfling') base.luck = true;
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

/** The DC of a present monster's action by this name ("Bite", "Fire Breath"); never the saver's own. */
function statBlockDc(rules: RulesData, npcs: Npc[], action: string | undefined, saver: string): number | undefined {
  if (!action) return;
  for (const n of npcs) {
    if (sameName(n.name, saver)) continue;
    const m = monsterOf(rules, n);
    const dc = m && actionNamed(m, action)?.dc;
    if (dc) return dc;
  }
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
export function resolveRoll(r: PendingRoll, all: PendingRoll[], manual?: number[], opts: { timedOut?: boolean; hideTargets?: boolean } = {}): RollOutcome {
  const parent = all.find((x) => x.id === (r.onHit ?? r.onFail));
  const who = manual ? ' (rolled by the player)' : opts.timedOut ? ' (time ran out, the server rolled)' : '';
  if (r.kind === 'damage' || r.kind === 'heal' || r.kind === 'hitdie') {
    const out = roll(r.dice, { manual, crit: r.crit });
    let total = Math.max(0, out.total);
    const halved = !!(r.half && parent?.result?.success && r.onFail);
    if (halved) total = Math.floor(total / 2);
    const res: RollOutcome = {
      dice: out.dice.filter((x) => !x.dropped).map((x) => x.value),
      faces: out.dice,
      total,
      manual: out.manual,
      ...(opts.timedOut ? { timedOut: true } : {}),
      crit: r.crit,
      text: `${r.label}: ${r.dice}${r.crit ? ' (critical, dice doubled)' : ''} → [${out.dice.map((x) => x.value).join(', ')}] = ${out.total}${halved ? `, halved: ${total}` : ''}${who}`,
    };
    r.result = res;
    return res;
  }
  // "I roll myself" sends the d20s first, then the bonus dice (Bless…). Halfling Luck: players reroll their own 1s.
  const n = r.adv === 'adv' || r.adv === 'dis' ? 2 : 1;
  const extra = r.bonusDice ?? [];
  if (manual) {
    const err = checkManual([...Array<number>(n).fill(20), ...extra.flatMap((e) => diceNeeded(parseDice(e.dice)))], manual);
    if (err) throw new DiceError(err);
  }
  const d = rollD20(r.bonus, (r.adv ?? 'none') as Adv, manual?.slice(0, n), { rerollOnes: r.luck && !manual, critOn: r.critOn });
  let k = n;
  const bonusRolls = extra.map((e) => ({ e, out: roll(e.dice, { manual: manual?.slice(k, (k += diceNeeded(parseDice(e.dice)).length)) }) }));
  const total = d.total + bonusRolls.reduce((sum, b) => sum + b.out.total, 0);
  let success: boolean | undefined;
  let vs = '';
  // Hidden targets: the log (which the players read) says hit or miss, not the number.
  if (r.kind === 'attack') {
    success = d.crit || (!d.fumble && total >= (r.targetAc ?? 10));
    vs = `${opts.hideTargets ? '' : ` vs AC ${r.targetAc}`} — ${d.crit ? 'critical hit!' : d.fumble ? 'natural 1, miss' : success ? 'hit' : 'miss'}`;
  } else if (r.kind === 'death') {
    success = d.natural >= 10;
    vs = d.natural === 20 ? ' — natural 20!' : d.natural === 1 ? ' — natural 1, two failures' : success ? ' — success' : ' — failure';
  } else if (r.dc !== undefined) {
    success = total >= r.dc;
    vs = `${opts.hideTargets ? '' : ` vs DC ${r.dc}`} — ${success ? 'success' : 'failure'}`;
  }
  const advText = d.adv === 'none' ? '' : ` (${d.adv === 'adv' ? 'advantage' : 'disadvantage'}: ${d.rolls.join(' / ')})`;
  const luckText = d.rerolled ? ' (Halfling Luck: rolled the 1 again)' : '';
  const bonusText = bonusRolls.map((b) => ` + ${b.e.from} ${b.e.dice} (${b.out.total})`).join('');
  // On a tie the first die counts and the second is the dropped one. A 1 Halfling Luck rolled again shows as dropped.
  const kept = d.rolls.indexOf(d.natural);
  const used = extra.filter((e) => e.once).map((e) => e.condition);
  const res: RollOutcome = {
    dice: d.rolls,
    faces: [
      ...Array.from({ length: d.rerolled }, () => ({ sides: 20, value: 1, dropped: true })),
      ...d.rolls.map((value, i) => ({ sides: 20, value, ...(i !== kept ? { dropped: true } : {}) })),
      ...bonusRolls.flatMap((b) => b.out.dice),
    ],
    natural: d.natural,
    total,
    manual: d.manual,
    ...(opts.timedOut ? { timedOut: true } : {}),
    ...(used.length ? { usedConditions: used } : {}),
    success,
    crit: d.crit,
    fumble: d.fumble,
    text: `${r.label}: d20 ${d.natural}${advText}${luckText}${bonusText} ${r.bonus >= 0 ? '+' : '−'} ${Math.abs(r.bonus)} = ${total}${vs}${who}`,
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

/**
 * HP changes the dice caused: per PC id (net) and per NPC name. A PC who resists every type of a damage roll
 * (`resists`: Rage) takes half, said in `resisted`.
 */
export function rollEffects(rolls: PendingRoll[], chars: GameCharacter[], npcs: Npc[], resists?: (c: GameCharacter) => string[]) {
  const pcs = new Map<string, { damage: number; heal: number; crit: boolean }>();
  const foes = new Map<string, { damage: number; heal: number }>();
  const resisted: string[] = [];
  for (const r of rolls) {
    if (!r.result || r.result.skipped || (r.kind !== 'damage' && r.kind !== 'heal')) continue;
    const targetName = r.target ?? (r.kind === 'heal' ? r.actor : undefined);
    if (!targetName) continue;
    const pc = chars.find((c) => sameName(c.name, targetName));
    if (pc) {
      const e = pcs.get(pc.id) ?? { damage: 0, heal: 0, crit: false };
      const types = (r.damageType ?? '').toLowerCase().split(/,\s*/).filter(Boolean);
      const resist = r.kind === 'damage' && types.length && resists?.(pc);
      if (resist && types.every((t) => resist.includes(t))) {
        const half = Math.floor(r.result.total / 2);
        resisted.push(`${pc.name} resists ${types.join(', ')}: ${r.result.total} → ${half}`);
        e.damage += half;
      } else if (r.kind === 'damage') e.damage += r.result.total;
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
  return { pcs, foes, resisted };
}

export { DiceError };
