import {
  ABILITIES,
  SKILLS,
  XP_TABLE,
  mod,
  profBonus,
  type Abilities,
  type Ability,
  type Character,
  type CharacterBuild,
  type Counter,
  type Derived,
  type InventoryItem,
  type Recharge,
  type RollPart,
  type RulesClass,
  type RulesData,
  type RulesItem,
} from '@dungeonmind/shared';
import { findIn } from '../rules/index.js';
import { classesOf, findSub, MULTICLASS_SKILLS, multiclassBlock, spellSlots, subclassLevel, topSlot, type ClassEntry } from './classes.js';
import { featureCounters } from './features.js';

export { findSub, subclassLevel } from './classes.js';

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
const POINT_COST: Record<number, number> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };

/** Extra free skill picks some species give. */
const SPECIES_SKILLS: Record<string, { any?: number; fixed?: string[] }> = {
  'srd51:half-elf': { any: 2 },
  'srd51:half-orc': { fixed: ['intimidation'] },
  'srd51:elf': { fixed: ['perception'] },
  'srd52:human': { any: 1 },
  'srd52:elf': { any: 1 },
};

const totals = (...parts: (Partial<Abilities> | undefined)[]): Abilities => {
  const out = Object.fromEntries(ABILITIES.map((a) => [a, 0])) as Abilities;
  for (const p of parts) for (const a of ABILITIES) out[a] += p?.[a] ?? 0;
  return out;
};

/** How many Ability Score Improvements a class has by this level. */
export function asiCount(cls: RulesClass, level: number): number {
  const upTo = cls.levels.filter((l) => l.level <= level);
  const fromData = upTo.at(-1)?.asi;
  if (typeof fromData === 'number') return fromData;
  return upTo.filter((l) => l.features.some((f) => /ability score improvement/i.test(f))).length;
}

/** Spells one class may know/prepare at its own level (cantrips, leveled spells, its highest spell level). */
export function classSpellLimits(e: ClassEntry, abilities: Abilities) {
  const { cls, level } = e;
  const lv = cls.levels.find((l) => l.level === level)?.spellcasting;
  if (!lv) return { cantrips: 0, spells: 0, maxLevel: 0 };
  let spells = lv.known ?? lv.prepared;
  if (spells === undefined) {
    // 2014 prepared casters: ability modifier + level (paladin: half level); wizards also keep a spellbook.
    const m = cls.spellAbility ? mod(abilities[cls.spellAbility]) : 0;
    spells = Math.max(1, m + (cls.id === 'paladin' ? Math.floor(level / 2) : level));
    if (cls.id === 'wizard') spells = Math.max(spells, 6 + 2 * (level - 1));
  }
  return { cantrips: lv.cantrips ?? 0, spells, maxLevel: topSlot(lv.slots) };
}

/** Spells a character may know/prepare: every class's own allowance added up (`per`: each class's). */
export function spellLimits(rules: RulesData, b: Pick<CharacterBuild, 'class' | 'subclass' | 'level' | 'hpRolls' | 'multiclass'>, abilities: Abilities) {
  const per = classesOf(rules, b).map((e) => ({ cls: e.cls, ...classSpellLimits(e, abilities) }));
  return {
    cantrips: per.reduce((n, x) => n + x.cantrips, 0),
    spells: per.reduce((n, x) => n + x.spells, 0),
    maxLevel: Math.max(0, ...per.map((x) => x.maxLevel)),
    per,
  };
}

export function finalAbilities(rules: RulesData, b: CharacterBuild): Abilities {
  const sp = findIn(rules.species, b.species);
  const sub = sp ? findSub(sp.subspecies, b.subspecies) : undefined;
  return totals(b.baseAbilities, sp?.abilityBonuses, sub?.abilityBonuses, b.bonusChoices, b.asi);
}

/** Every rule a build breaks, in plain English. Empty = legal. */
export function validateBuild(rules: RulesData, b: CharacterBuild, opts: { minLevel?: number; maxLevel?: number; rolled?: number[] } = {}): string[] {
  const errors: string[] = [];
  if (!b.name?.trim() || b.name.length > 60) errors.push('Give the character a name (max 60 characters).');
  if (!Number.isInteger(b.level) || b.level < 1 || b.level > 20) errors.push('Level is 1-20.');
  if (opts.minLevel && b.level < opts.minLevel) errors.push(`This game starts at level ${opts.minLevel}.`);
  if (opts.maxLevel && b.level > opts.maxLevel) errors.push(`This game ends at level ${opts.maxLevel}.`);
  const cls = findIn(rules.classes, b.class);
  const sp = findIn(rules.species, b.species);
  const bg = findIn(rules.backgrounds, b.background);
  if (!cls) errors.push(b.class ? `Unknown class "${b.class}".` : 'Pick a class.');
  if (!sp) errors.push(b.species ? `Unknown species "${b.species}".` : 'Pick a species.');
  if (!bg) errors.push(b.background ? `Unknown background "${b.background}".` : 'Pick a background.');
  if (sp && sp.subspecies.length && rules.ruleset === 'srd51' && !b.subspecies) errors.push(`Pick a subrace for ${sp.name}.`);
  if (sp && b.subspecies && !findSub(sp.subspecies, b.subspecies)) errors.push(`${b.subspecies} is not a ${sp.name} option.`);
  if (cls && b.subclass && !findSub(cls.subclasses, b.subclass)) errors.push(`${b.subclass} is not a ${cls.name} subclass in this ruleset.`);
  const classes = cls ? classesOf(rules, b) : [];
  const firstLevel = classes[0]?.level ?? b.level;
  if (cls && !b.subclass && firstLevel >= subclassLevel(rules.ruleset, cls.id) && cls.subclasses.length) errors.push(`A level ${firstLevel} ${cls.name} needs a subclass.`);

  // Multiclassing: more classes, each with its own levels; the first class keeps what they leave.
  const seen = new Set([cls?.id]);
  for (const m of b.multiclass ?? []) {
    const mc = findIn(rules.classes, m?.class);
    if (!mc) {
      errors.push(m?.class ? `Unknown class "${m.class}".` : 'Pick a class for each multiclass.');
      continue;
    }
    if (seen.has(mc.id)) errors.push(`${mc.name} is listed twice: give it more levels instead.`);
    seen.add(mc.id);
    if (!Number.isInteger(m.level) || m.level < 1) errors.push(`Give ${mc.name} at least one level.`);
    if (m.subclass && !findSub(mc.subclasses, m.subclass)) errors.push(`${m.subclass} is not a ${mc.name} subclass in this ruleset.`);
    if (!m.subclass && m.level >= subclassLevel(rules.ruleset, mc.id) && mc.subclasses.length) errors.push(`A level ${m.level} ${mc.name} needs a subclass.`);
    if ((m.hpRolls ?? []).some((v) => !Number.isInteger(v) || v < 1 || v > mc.hitDie)) errors.push(`${mc.name} hit points are rolled on a d${mc.hitDie}.`);
  }
  if (cls && firstLevel < 1) errors.push(`${cls.name} needs at least one level: the other classes have ${b.level - firstLevel} of the ${b.level}.`);

  // Ability scores.
  const base = ABILITIES.map((a) => b.baseAbilities?.[a]);
  if (base.some((v) => !Number.isInteger(v))) errors.push('Every ability needs a score.');
  else if (b.abilityMethod === 'standard') {
    if ([...base].sort((x, y) => y! - x!).join() !== STANDARD_ARRAY.join()) errors.push('The standard array is 15, 14, 13, 12, 10, 8, each used once.');
  } else if (b.abilityMethod === 'pointbuy') {
    if (base.some((v) => v! < 8 || v! > 15)) errors.push('Point buy scores are 8-15.');
    else {
      const cost = base.reduce((s, v) => s + POINT_COST[v!], 0);
      if (cost > 27) errors.push(`Point buy costs ${cost} of 27 points.`);
    }
  } else if (b.abilityMethod === 'rolled') {
    if (!opts.rolled) errors.push('Rolled scores need a server roll.');
    else if ([...base].sort((x, y) => y! - x!).join() !== [...opts.rolled].sort((x, y) => y - x).join()) errors.push('Use exactly the scores the server rolled.');
  } else if (b.abilityMethod === 'manual') {
    if (base.some((v) => v! < 3 || v! > 18)) errors.push('Scores are 3-18 before bonuses.');
  } else errors.push('Pick how to generate ability scores.');

  // Flexible bonuses.
  const choice = Object.entries(b.bonusChoices ?? {}).filter(([, v]) => v);
  if (rules.ruleset === 'srd52') {
    const opts2 = bg?.abilityOptions ?? [];
    const vals = choice.map(([, v]) => v).sort();
    if (choice.some(([a]) => !opts2.includes(a as Ability))) errors.push(`The ${bg?.name ?? ''} background raises only ${opts2.join(', ').toUpperCase()}.`);
    else if (!(vals.join() === '1,2' || vals.join() === '1,1,1')) errors.push('Background bonuses: +2 and +1, or +1 to all three.');
  } else if (sp?.id === 'half-elf') {
    if (choice.length !== 2 || choice.some(([a, v]) => v !== 1 || a === 'cha')) errors.push('Half-elves raise two abilities other than Charisma by 1.');
  } else if (choice.length) errors.push(`${sp?.name ?? 'This species'} has no free ability bonuses.`);

  // ASIs.
  if (cls) {
    // Improvements come with class levels, so every class counts its own.
    const allowed = classes.reduce((n, e) => n + asiCount(e.cls, e.level), 0) * 2;
    const used = Object.values(b.asi ?? {}).reduce((s, v) => s + (v ?? 0), 0);
    if (Object.values(b.asi ?? {}).some((v) => (v ?? 0) < 0)) errors.push('Ability Score Improvements only raise scores.');
    if (used > allowed) errors.push(`A level ${b.level} ${cls.name} has ${allowed} ability points from improvements, not ${used}.`);
  }
  const fin = finalAbilities(rules, b);
  if (ABILITIES.some((a) => fin[a] > 20)) errors.push('No ability can go above 20.');
  // Every class of a multiclass character needs its prerequisite scores, the first one too.
  if (b.multiclass?.length) for (const e of classes) {
    const why = multiclassBlock(e.cls, fin);
    if (why) errors.push(why);
  }

  // Skills.
  if (cls && bg) {
    const fixed = new Set([...bg.skills, ...(SPECIES_SKILLS[`${rules.ruleset}:${sp?.id}`]?.fixed ?? [])]);
    const fromClasses = (b.multiclass ?? []).reduce((n, m) => n + (MULTICLASS_SKILLS[findIn(rules.classes, m?.class)?.id ?? ''] ?? 0), 0);
    const extraAny = (SPECIES_SKILLS[`${rules.ruleset}:${sp?.id}`]?.any ?? 0) + fromClasses;
    const picked = (b.skills ?? []).filter((s) => !fixed.has(s));
    const unknown = picked.filter((s) => !(s in SKILLS));
    if (unknown.length) errors.push(`Unknown skill: ${unknown.join(', ')}.`);
    if (new Set(b.skills).size !== (b.skills ?? []).length) errors.push('A skill is listed twice.');
    const fromClass = picked.filter((s) => cls.skillChoices.from.includes(s));
    const outside = picked.length - Math.min(fromClass.length, cls.skillChoices.choose);
    if (picked.length > cls.skillChoices.choose + extraAny || outside > extraAny)
      errors.push(`${cls.name}: choose ${cls.skillChoices.choose} skills from ${cls.skillChoices.from.join(', ')}${extraAny ? ` (+${extraAny} any from your ${fromClasses ? 'species and other classes' : 'species'})` : ''}.`);
    if (picked.length < cls.skillChoices.choose) errors.push(`Choose ${cls.skillChoices.choose - picked.length} more skill${cls.skillChoices.choose - picked.length > 1 ? 's' : ''}.`);
  }

  // Spells.
  if (cls) {
    // A multiclass character picks from every class's list, up to each class's own spell level.
    const lim = spellLimits(rules, b, fin);
    const who = classes.map((e) => e.cls.name).join(' / ') || cls.name;
    const cantrips = b.cantrips ?? [];
    const spells = b.spells ?? [];
    if (cantrips.length > lim.cantrips) errors.push(`A level ${b.level} ${who} knows ${lim.cantrips} cantrips, not ${cantrips.length}.`);
    if (spells.length > lim.spells) errors.push(`A level ${b.level} ${who} has ${lim.spells} spells, not ${spells.length}.`);
    for (const id of [...cantrips, ...spells]) {
      const s = findIn(rules.spells, id);
      const from = s ? lim.per.filter((x) => s.classes.includes(x.cls.id)) : [];
      const top = Math.max(0, ...from.map((x) => x.maxLevel));
      if (!s) errors.push(`Unknown spell "${id}".`);
      else if (!from.length) errors.push(`${s.name} is not on the ${classes.map((e) => e.cls.name).join(' or ') || cls.name} spell list.`);
      else if (cantrips.includes(id) && s.level !== 0) errors.push(`${s.name} is not a cantrip.`);
      else if (spells.includes(id) && (s.level === 0 || s.level > top)) errors.push(`${s.name} (level ${s.level}) is above your highest slot (${top}).`);
    }
  }
  if ((b.equipment ?? []).length > 80) errors.push('Too many items.');
  return errors;
}

// ---- Derived numbers ----

export function itemByName(rules: RulesData, name: string): RulesItem | undefined {
  return findIn(rules.items, name.replace(/^\d+\s*[×x]\s*/, '').replace(/\s*\(.*\)$/, ''));
}

export function derive(rules: RulesData, c: Character): Derived {
  const pb = profBonus(c.level);
  const mods = Object.fromEntries(ABILITIES.map((a) => [a, mod(c.abilities[a])])) as Abilities;
  const classes = classesOf(rules, c);
  const has = (id: string) => classes.some((e) => e.cls.id === id);
  const exhaustionPenalty = rules.ruleset === 'srd52' ? 2 * c.exhaustion : 0;

  // Armor Class from equipped armor and shield; unarmored defense for barbarians and monks.
  let armor: RulesItem | undefined;
  let shield = false;
  for (const it of c.inventory.filter((i) => i.equipped)) {
    const r = itemByName(rules, it.name);
    if (!r?.armor) continue;
    if (/shield/i.test(r.name)) shield = true;
    else armor = r;
  }
  let ac: number;
  if (armor?.armor) ac = armor.armor.base + (armor.armor.dexBonus ? (armor.armor.maxBonus !== undefined ? Math.min(mods.dex, armor.armor.maxBonus) : mods.dex) : 0);
  else if (has('barbarian')) ac = 10 + mods.dex + mods.con;
  else if (has('monk') && !shield) ac = 10 + mods.dex + mods.wis;
  else ac = 10 + mods.dex;
  if (shield) ac += 2;

  // Each save and skill bonus as named parts; the totals are their sums.
  const partsFor = (a: Ability, proficient: boolean): RollPart[] => [
    { label: a.toUpperCase(), value: mods[a] },
    ...(proficient ? [{ label: 'Proficiency', value: pb }] : []),
    ...(exhaustionPenalty ? [{ label: 'Exhaustion', value: -exhaustionPenalty }] : []),
  ];
  const sum = (p: RollPart[]) => p.reduce((t, x) => t + x.value, 0);
  const saveParts = Object.fromEntries(ABILITIES.map((a) => [a, partsFor(a, c.saves.includes(a))])) as Record<Ability, RollPart[]>;
  const skillParts = Object.fromEntries(Object.entries(SKILLS).map(([s, a]) => [s, partsFor(a, c.skills.includes(s))]));
  const saveBonus = Object.fromEntries(ABILITIES.map((a) => [a, sum(saveParts[a])])) as Abilities;
  const skillBonus = Object.fromEntries(Object.entries(skillParts).map(([s, p]) => [s, sum(p)]));
  // The first class that casts at its level gives the save DC and attack (spells.ts picks per spell).
  const spellAbility = classes.find((e) => e.cls.spellAbility && e.cls.levels.find((l) => l.level === e.level)?.spellcasting)?.cls.spellAbility;
  const sp = findIn(rules.species, c.species);
  const { slots, pact } = spellSlots(rules, classes);
  return {
    profBonus: pb,
    mods,
    ac,
    initiative: mods.dex - exhaustionPenalty,
    speed: Math.max(0, (sp?.speed ?? 30) - (rules.ruleset === 'srd52' ? 5 * c.exhaustion : 0)),
    passivePerception: 10 + skillBonus.perception,
    saveBonus,
    skillBonus,
    saveParts,
    skillParts,
    spellAbility,
    spellDc: spellAbility ? 8 + pb + mods[spellAbility] : undefined,
    spellAttack: spellAbility ? pb + mods[spellAbility] : undefined,
    maxSpellLevel: Math.max(topSlot(slots), topSlot(pact)),
    nextLevelXp: c.level < 20 ? XP_TABLE[c.level + 1] : undefined,
  };
}

// ---- Hit points ----
export const fixedHpPerLevel = (hitDie: number) => hitDie / 2 + 1;

export function maxHp(hitDie: number, level: number, conMod: number, hpRolls: number[] = []): number {
  let hp = hitDie + conMod;
  for (let l = 2; l <= level; l++) hp += Math.max(1, (hpRolls[l - 2] ?? fixedHpPerLevel(hitDie)) + conMod);
  return Math.max(1, hp);
}

/** Every class's levels on its own die: only the very first level is the full die; the others are rolled or fixed. */
export function maxHpOf(classes: ClassEntry[], conMod: number): number {
  const [first, ...more] = classes;
  let hp = first.level >= 1 ? maxHp(first.cls.hitDie, first.level, conMod, first.hpRolls) : 0;
  for (const e of more) for (let l = 1; l <= e.level; l++) hp += Math.max(1, (e.hpRolls?.[l - 1] ?? fixedHpPerLevel(e.cls.hitDie)) + conMod);
  return Math.max(1, hp);
}

// ---- Counters (resource model) ----
const C = (name: string, max: number, recharge: Recharge, source: string): Counter => ({ name, current: max, max, recharge, source });

/**
 * Counters from every class's features (the same counter from two classes keeps the larger one) and the spell slots.
 * Pact Magic slots come back on a short rest, and are called "Pact slot" next to other spell slots.
 */
export function classCounters(rules: RulesData, classes: ClassEntry[], abilities: Abilities, charLevel: number): Counter[] {
  const out: Counter[] = [];
  for (const e of classes)
    for (const k of featureCounters(rules, e.cls, e.level, e.subclass, abilities, charLevel)) {
      const prev = out.find((x) => x.name === k.name);
      if (!prev) out.push(k);
      else if (k.max > prev.max) Object.assign(prev, k);
    }
  const { slots, pact } = spellSlots(rules, classes);
  const casters = classes.filter((e) => e.cls.id !== 'warlock' && e.cls.spellAbility).map((e) => e.cls.name).join(' / ');
  slots.forEach((n, i) => n > 0 && out.push(C(`Spell slot L${i + 1}`, n, 'long', `${casters} spellcasting`)));
  const both = topSlot(slots) > 0;
  pact.forEach((n, i) => n > 0 && out.push(C(`${both ? 'Pact' : 'Spell'} slot L${i + 1}`, n, 'short', 'Warlock spellcasting')));
  return out;
}

const SPECIES_COUNTERS: Record<string, (pb: number) => Counter[]> = {
  'srd51:half-orc': () => [C('Relentless Endurance', 1, 'long', 'Half-Orc')],
  'srd51:dragonborn': () => [C('Breath Weapon', 1, 'short', 'Dragonborn')],
  'srd52:orc': (pb) => [C('Relentless Endurance', 1, 'long', 'Orc'), C('Adrenaline Rush', pb, 'short', 'Orc')],
  'srd52:dragonborn': (pb) => [C('Breath Weapon', pb, 'long', 'Dragonborn')],
  'srd52:goliath': (pb) => [C('Giant Ancestry', pb, 'long', 'Goliath')],
  'srd52:dwarf': (pb) => [C('Stonecunning', pb, 'long', 'Dwarf')],
};

/**
 * The counters a sheet should have. Spent amounts carry over (a rebuild or level-up never refills them),
 * and custom counters (items, ammo, homebrew) are kept.
 */
export function buildCounters(rules: RulesData, c: Pick<Character, 'class' | 'subclass' | 'multiclass' | 'hpRolls' | 'species' | 'level' | 'abilities' | 'counters' | 'hitDie'>): Counter[] {
  const classes = classesOf(rules, c);
  const sp = findIn(rules.species, c.species);
  // Hit dice: one counter per die size, the biggest first.
  const dice = new Map<number, number>();
  for (const e of classes) dice.set(e.cls.hitDie, (dice.get(e.cls.hitDie) ?? 0) + e.level);
  if (!dice.size) dice.set(c.hitDie, c.level);
  const fresh = [
    ...[...dice].sort((x, y) => y[0] - x[0]).map(([d, n]) => C(`Hit Dice (d${d})`, n, 'long', 'Hit Dice')),
    ...classCounters(rules, classes, c.abilities, c.level),
    ...(sp ? (SPECIES_COUNTERS[`${rules.ruleset}:${sp.id}`]?.(profBonus(c.level)) ?? []) : []),
  ];
  const old = c.counters ?? [];
  const generated = new Set(fresh.map((f) => f.name));
  return [
    ...fresh.map((f) => {
      const prev = old.find((o) => o.name === f.name);
      return prev ? { ...f, current: Math.max(0, Math.min(f.max, f.max - (prev.max - prev.current))) } : f;
    }),
    ...old.filter((o) => !generated.has(o.name) && (o.source === 'custom' || o.source === 'item' || o.source === 'homebrew')),
  ];
}

// ---- Inventory ----
export function parseItems(lines: string[]): InventoryItem[] {
  const out: InventoryItem[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.length > 120) continue;
    const m = /^(\d+)\s*[×x]?\s+(.+)$/.exec(line) ?? /^(\d+)\s*[×x]\s*(.+)$/.exec(line) ?? /^(.+?)\s*\((\d+)\)$/.exec(line);
    const [name, qty] = m ? (/^\d/.test(m[1]) ? [m[2], Number(m[1])] : [m[1], Number(m[2])]) : [line, 1];
    const prev = out.find((i) => i.name.toLowerCase() === name.toLowerCase());
    if (prev) prev.qty += qty;
    else out.push({ name, qty });
  }
  return out;
}

/** Equips the first armor, shield and weapons so AC is right from the start. */
function autoEquip(rules: RulesData, inv: InventoryItem[]): InventoryItem[] {
  let body = false;
  let shield = false;
  return inv.map((i) => {
    const r = itemByName(rules, i.name);
    if (r?.armor && /shield/i.test(r.name) && !shield) return (shield = true), { ...i, equipped: true };
    if (r?.armor && !/shield/i.test(r.name) && !body) return (body = true), { ...i, equipped: true };
    if (r?.damage) return { ...i, equipped: true };
    return i;
  });
}

const GOLD = /^(\d+)\s*(gp|gold)$/i;

/** A legal build becomes a full sheet (HP, saves, counters, inventory). `prev` keeps play state on edits. */
export function buildCharacter(rules: RulesData, b: CharacterBuild, base: { id: string; ownerId: string; prev?: Character }): Character {
  const cls = findIn(rules.classes, b.class)!;
  const abilities = finalAbilities(rules, b);
  const prev = base.prev;
  const multiclass = b.multiclass?.length
    ? b.multiclass.map((m) => {
        const mc = findIn(rules.classes, m.class)!;
        return { class: mc.id, level: m.level, ...(findSub(mc.subclasses, m.subclass) ? { subclass: findSub(mc.subclasses, m.subclass)!.id } : {}), ...(m.hpRolls?.length ? { hpRolls: m.hpRolls } : {}) };
      })
    : undefined;
  const hp = maxHpOf(classesOf(rules, { ...b, multiclass }), mod(abilities.con));
  const goldLines = (b.equipment ?? []).filter((l) => GOLD.test(l.trim()));
  const gold = goldLines.reduce((s, l) => s + Number(GOLD.exec(l.trim())![1]), 0);
  const inventory = prev?.inventory ?? autoEquip(rules, parseItems((b.equipment ?? []).filter((l) => !GOLD.test(l.trim()))));
  const fixed = new Set([...(findIn(rules.backgrounds, b.background)?.skills ?? []), ...(SPECIES_SKILLS[`${rules.ruleset}:${findIn(rules.species, b.species)?.id}`]?.fixed ?? [])]);
  const c: Character = {
    ...b,
    class: cls.id,
    subclass: findSub(cls.subclasses, b.subclass)?.id,
    multiclass,
    species: findIn(rules.species, b.species)!.id,
    subspecies: findSub(findIn(rules.species, b.species)!.subspecies, b.subspecies)?.id,
    background: findIn(rules.backgrounds, b.background)!.id,
    skills: [...new Set([...fixed, ...b.skills])],
    id: base.id,
    ownerId: base.ownerId,
    xp: prev?.xp ?? XP_TABLE[b.level],
    abilities,
    maxHp: hp,
    hp: prev ? Math.min(hp, prev.hp + Math.max(0, hp - prev.maxHp)) : hp,
    tempHp: prev?.tempHp ?? 0,
    hitDie: cls.hitDie,
    saves: cls.saves,
    counters: [],
    conditions: prev?.conditions ?? [],
    concentration: prev?.concentration,
    inventory,
    gold: prev?.gold ?? gold,
    deathSaves: prev?.deathSaves ?? { success: 0, fail: 0 },
    exhaustion: prev?.exhaustion ?? 0,
    portrait: prev?.portrait,
    notes: prev?.notes,
  };
  c.counters = buildCounters(rules, { ...c, counters: prev?.counters ?? [] });
  c.levelUpPending = c.level < 20 && c.xp >= XP_TABLE[c.level + 1];
  return c;
}

/** The choices part of a sheet (to edit it in the builder again). */
export function buildOf(c: Character): CharacterBuild {
  const { ruleset, name, species, subspecies, class: cls, subclass, background, level, abilityMethod, baseAbilities, rollId, bonusChoices, asi, skills, cantrips, spells, equipment, alignment, appearance, personality, backstory, hpRolls, multiclass } = c;
  return { ruleset, name, species, subspecies, class: cls, subclass, background, level, abilityMethod, baseAbilities, rollId, bonusChoices, asi, skills, cantrips, spells, equipment, alignment, appearance, personality, backstory, hpRolls, multiclass };
}
