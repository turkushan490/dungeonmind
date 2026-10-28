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
  type RulesClass,
  type RulesData,
  type RulesItem,
} from '@dungeonmind/shared';
import { findIn, slug } from '../rules/index.js';

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
const POINT_COST: Record<number, number> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };

/** 2014 subclass levels; 2024: every class picks at 3. */
const SUBCLASS_LEVEL_2014: Record<string, number> = { cleric: 1, sorcerer: 1, warlock: 1, druid: 2, wizard: 2 };
export const subclassLevel = (ruleset: string, cls: string) => (ruleset === 'srd51' ? (SUBCLASS_LEVEL_2014[cls] ?? 3) : 3);

/** Extra free skill picks some species give. */
const SPECIES_SKILLS: Record<string, { any?: number; fixed?: string[] }> = {
  'srd51:half-elf': { any: 2 },
  'srd51:half-orc': { fixed: ['intimidation'] },
  'srd51:elf': { fixed: ['perception'] },
  'srd52:human': { any: 1 },
  'srd52:elf': { any: 1 },
};

/** Subclass/subspecies by id or name; "life" finds "life-domain", "Hill" finds "hill-dwarf". */
export function findSub<T extends { id: string; name: string }>(list: T[], x: string | undefined): T | undefined {
  if (!x) return;
  const k = slug(x);
  return list.find((s) => s.id === x || s.id === k || slug(s.name) === k) ?? list.find((s) => s.id.startsWith(`${k}-`) || s.id.endsWith(`-${k}`) || slug(s.name).split('-').includes(k));
}

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

/** Spells a character may know/prepare at a level (cantrips, leveled spells). */
export function spellLimits(rules: RulesData, b: Pick<CharacterBuild, 'class' | 'level' | 'ruleset'>, abilities: Abilities) {
  const cls = findIn(rules.classes, b.class);
  const lv = cls?.levels.find((l) => l.level === b.level)?.spellcasting;
  if (!cls || !lv) return { cantrips: 0, spells: 0, maxLevel: 0 };
  const maxLevel = lv.slots.reduce((m, n, i) => (n > 0 ? i + 1 : m), 0);
  let spells = lv.known ?? lv.prepared;
  if (spells === undefined) {
    // 2014 prepared casters: ability modifier + level (paladin: half level); wizards also keep a spellbook.
    const m = cls.spellAbility ? mod(abilities[cls.spellAbility]) : 0;
    spells = Math.max(1, m + (cls.id === 'paladin' ? Math.floor(b.level / 2) : b.level));
    if (cls.id === 'wizard') spells = Math.max(spells, 6 + 2 * (b.level - 1));
  }
  return { cantrips: lv.cantrips ?? 0, spells, maxLevel };
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
  if (cls && !b.subclass && b.level >= subclassLevel(rules.ruleset, cls.id) && cls.subclasses.length) errors.push(`A level ${b.level} ${cls.name} needs a subclass.`);

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
    const allowed = asiCount(cls, b.level) * 2;
    const used = Object.values(b.asi ?? {}).reduce((s, v) => s + (v ?? 0), 0);
    if (Object.values(b.asi ?? {}).some((v) => (v ?? 0) < 0)) errors.push('Ability Score Improvements only raise scores.');
    if (used > allowed) errors.push(`A level ${b.level} ${cls.name} has ${allowed} ability points from improvements, not ${used}.`);
  }
  const fin = finalAbilities(rules, b);
  if (ABILITIES.some((a) => fin[a] > 20)) errors.push('No ability can go above 20.');

  // Skills.
  if (cls && bg) {
    const fixed = new Set([...bg.skills, ...(SPECIES_SKILLS[`${rules.ruleset}:${sp?.id}`]?.fixed ?? [])]);
    const extraAny = SPECIES_SKILLS[`${rules.ruleset}:${sp?.id}`]?.any ?? 0;
    const picked = (b.skills ?? []).filter((s) => !fixed.has(s));
    const unknown = picked.filter((s) => !(s in SKILLS));
    if (unknown.length) errors.push(`Unknown skill: ${unknown.join(', ')}.`);
    if (new Set(b.skills).size !== (b.skills ?? []).length) errors.push('A skill is listed twice.');
    const fromClass = picked.filter((s) => cls.skillChoices.from.includes(s));
    const outside = picked.length - Math.min(fromClass.length, cls.skillChoices.choose);
    if (picked.length > cls.skillChoices.choose + extraAny || outside > extraAny)
      errors.push(`${cls.name}: choose ${cls.skillChoices.choose} skills from ${cls.skillChoices.from.join(', ')}${extraAny ? ` (+${extraAny} any from your species)` : ''}.`);
    if (picked.length < cls.skillChoices.choose) errors.push(`Choose ${cls.skillChoices.choose - picked.length} more skill${cls.skillChoices.choose - picked.length > 1 ? 's' : ''}.`);
  }

  // Spells.
  if (cls) {
    const lim = spellLimits(rules, b, fin);
    const cantrips = b.cantrips ?? [];
    const spells = b.spells ?? [];
    if (cantrips.length > lim.cantrips) errors.push(`A level ${b.level} ${cls.name} knows ${lim.cantrips} cantrips, not ${cantrips.length}.`);
    if (spells.length > lim.spells) errors.push(`A level ${b.level} ${cls.name} has ${lim.spells} spells, not ${spells.length}.`);
    for (const id of [...cantrips, ...spells]) {
      const s = findIn(rules.spells, id);
      if (!s) errors.push(`Unknown spell "${id}".`);
      else if (!s.classes.includes(cls.id)) errors.push(`${s.name} is not on the ${cls.name} spell list.`);
      else if (cantrips.includes(id) && s.level !== 0) errors.push(`${s.name} is not a cantrip.`);
      else if (spells.includes(id) && (s.level === 0 || s.level > lim.maxLevel)) errors.push(`${s.name} (level ${s.level}) is above your highest slot (${lim.maxLevel}).`);
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
  const cls = findIn(rules.classes, c.class);
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
  else if (cls?.id === 'barbarian') ac = 10 + mods.dex + mods.con;
  else if (cls?.id === 'monk' && !shield) ac = 10 + mods.dex + mods.wis;
  else ac = 10 + mods.dex;
  if (shield) ac += 2;

  const saveBonus = Object.fromEntries(ABILITIES.map((a) => [a, mods[a] + (c.saves.includes(a) ? pb : 0) - exhaustionPenalty])) as Abilities;
  const skillBonus = Object.fromEntries(Object.entries(SKILLS).map(([s, a]) => [s, mods[a] + (c.skills.includes(s) ? pb : 0) - exhaustionPenalty]));
  const spellAbility = cls?.spellAbility && cls.levels.find((l) => l.level === c.level)?.spellcasting ? cls.spellAbility : undefined;
  const sp = findIn(rules.species, c.species);
  const lim = spellLimits(rules, c, c.abilities);
  return {
    profBonus: pb,
    mods,
    ac,
    initiative: mods.dex - exhaustionPenalty,
    speed: Math.max(0, (sp?.speed ?? 30) - (rules.ruleset === 'srd52' ? 5 * c.exhaustion : 0)),
    passivePerception: 10 + skillBonus.perception,
    saveBonus,
    skillBonus,
    spellAbility,
    spellDc: spellAbility ? 8 + pb + mods[spellAbility] : undefined,
    spellAttack: spellAbility ? pb + mods[spellAbility] : undefined,
    maxSpellLevel: lim.maxLevel,
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

// ---- Counters (resource model) ----
const C = (name: string, max: number, recharge: Recharge, source: string): Counter => ({ name, current: max, max, recharge, source });

export function classCounters(rules: RulesData, cls: RulesClass, level: number, abilities: Abilities): Counter[] {
  const lv = cls.levels.find((l) => l.level === level);
  const cs = (lv?.classSpecific ?? {}) as Record<string, any>;
  const m = (a: Ability) => mod(abilities[a]);
  const pb = profBonus(level);
  const r24 = rules.ruleset === 'srd52';
  const out: Counter[] = [];
  const src = cls.name;
  switch (cls.id) {
    case 'barbarian':
      out.push(C('Rage', typeof cs.rage_count === 'number' ? cs.rage_count : 99, 'long', src));
      break;
    case 'bard':
      out.push(C('Bardic Inspiration', Math.max(1, m('cha')), level >= 5 ? 'short' : 'long', src));
      break;
    case 'cleric':
      if (cs.channel_divinity_charges) out.push(C('Channel Divinity', cs.channel_divinity_charges, 'short', src));
      break;
    case 'druid':
      if (level >= 2) out.push(C('Wild Shape', r24 ? (cs.wild_shape_uses ?? 2) : 2, 'short', src));
      break;
    case 'fighter':
      out.push(C('Second Wind', r24 ? (cs.second_wind_uses ?? 2) : 1, 'short', src));
      if (level >= 2) out.push(C('Action Surge', cs.action_surges ?? (level >= 17 ? 2 : 1), 'short', src));
      if (level >= 9) out.push(C('Indomitable', cs.indomitable_uses ?? (level >= 17 ? 3 : level >= 13 ? 2 : 1), 'long', src));
      break;
    case 'monk':
      if (level >= 2) out.push(C(r24 ? 'Focus Points' : 'Ki', cs.focus_points ?? cs.ki_points ?? level, 'short', src));
      break;
    case 'paladin':
      out.push(C('Lay on Hands', 5 * level, 'long', src));
      if (!r24) out.push(C('Divine Sense', Math.max(1, 1 + m('cha')), 'long', src));
      if (level >= 3) out.push(C('Channel Divinity', r24 ? (cs.channel_divinity_charges ?? 2) : 1, 'short', src));
      break;
    case 'ranger':
      if (r24) out.push(C("Hunter's Mark (free)", cs.favored_enemies ?? 2, 'long', src));
      break;
    case 'sorcerer':
      if (level >= 2) out.push(C('Sorcery Points', cs.sorcery_points ?? level, 'long', src));
      if (r24) out.push(C('Innate Sorcery', 2, 'long', src));
      break;
    case 'wizard':
      out.push(C('Arcane Recovery', 1, 'long', src));
      break;
  }
  // Spell slots: warlock pact slots come back on a short rest.
  const slots = lv?.spellcasting?.slots ?? [];
  slots.forEach((n, i) => n > 0 && out.push(C(`Spell slot L${i + 1}`, n, cls.id === 'warlock' ? 'short' : 'long', `${src} spellcasting`)));
  void pb;
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
export function buildCounters(rules: RulesData, c: Pick<Character, 'class' | 'species' | 'level' | 'abilities' | 'counters' | 'hitDie'>): Counter[] {
  const cls = findIn(rules.classes, c.class);
  const sp = findIn(rules.species, c.species);
  const fresh = [
    C(`Hit Dice (d${c.hitDie})`, c.level, 'long', 'Hit Dice'),
    ...(cls ? classCounters(rules, cls, c.level, c.abilities) : []),
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
    const m = /^(\d+)\s*[×x]\s*(.+)$/.exec(line) ?? /^(.+?)\s*\((\d+)\)$/.exec(line);
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
  const hp = maxHp(cls.hitDie, b.level, mod(abilities.con), b.hpRolls);
  const goldLines = (b.equipment ?? []).filter((l) => GOLD.test(l.trim()));
  const gold = goldLines.reduce((s, l) => s + Number(GOLD.exec(l.trim())![1]), 0);
  const inventory = prev?.inventory ?? autoEquip(rules, parseItems((b.equipment ?? []).filter((l) => !GOLD.test(l.trim()))));
  const fixed = new Set([...(findIn(rules.backgrounds, b.background)?.skills ?? []), ...(SPECIES_SKILLS[`${rules.ruleset}:${findIn(rules.species, b.species)?.id}`]?.fixed ?? [])]);
  const c: Character = {
    ...b,
    class: cls.id,
    subclass: findSub(cls.subclasses, b.subclass)?.id,
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
  const { ruleset, name, species, subspecies, class: cls, subclass, background, level, abilityMethod, baseAbilities, rollId, bonusChoices, asi, skills, cantrips, spells, equipment, alignment, appearance, personality, backstory, hpRolls } = c;
  return { ruleset, name, species, subspecies, class: cls, subclass, background, level, abilityMethod, baseAbilities, rollId, bonusChoices, asi, skills, cantrips, spells, equipment, alignment, appearance, personality, backstory, hpRolls };
}
