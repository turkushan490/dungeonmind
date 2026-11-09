import type { RollPart } from './game';
import type { Abilities, Ability, Ruleset } from './rules';

export type Recharge = 'short' | 'long' | 'dawn' | 'turn' | 'none';

/** Every limited thing: spell slots, class features, racial traits, item charges, hit dice, ammo. */
export interface Counter {
  name: string;
  current: number;
  max: number;
  recharge: Recharge;
  /** A short rest gives back this many of a long-rest counter (2024 Rage, Wild Shape, Channel Divinity: 1). */
  regain?: number;
  /** Where it comes from (class, species, item, custom). Custom counters survive a rebuild. */
  source?: string;
}

export interface Condition {
  name: string;
  /** Rounds left; absent = until removed. */
  rounds?: number;
  source?: string;
}

export interface InventoryItem {
  name: string;
  qty: number;
  equipped?: boolean;
}

export type AbilityMethod = 'standard' | 'pointbuy' | 'rolled' | 'manual';

/** What the builder (and the AI sheet / import) send: choices, not derived numbers. */
export interface CharacterBuild {
  ruleset: Ruleset;
  name: string;
  species: string;
  subspecies?: string;
  class: string;
  subclass?: string;
  background: string;
  level: number;
  abilityMethod: AbilityMethod;
  /** Scores before species/background bonuses and ASIs. */
  baseAbilities: Abilities;
  /** rolled: the server-rolled set this uses. */
  rollId?: string;
  /** 2014: choices for flexible species bonuses (half-elf). 2024: the background's +2/+1 or +1/+1/+1. */
  bonusChoices?: Partial<Abilities>;
  /** Ability Score Improvements taken so far (total points per ability). */
  asi?: Partial<Abilities>;
  skills: string[];
  cantrips?: string[];
  spells?: string[];
  equipment?: string[];
  alignment?: string;
  appearance?: string;
  personality?: string;
  backstory?: string;
  /** HP gained per level after the first (rolled at level-up); missing levels use the fixed value. */
  hpRolls?: number[];
  /** Classes taken by multiclassing; `class`/`subclass` are the first class and `level` is the total. */
  multiclass?: ClassLevels[];
}

/** One more class: its levels, and the HP rolled for each of them (missing ones use the fixed value). */
export interface ClassLevels {
  class: string;
  subclass?: string;
  level: number;
  hpRolls?: number[];
}

/** Every class of a character with its own level, the first class first (its level is what the others leave). */
export function classLevels(b: Pick<CharacterBuild, 'class' | 'subclass' | 'level' | 'hpRolls' | 'multiclass'>): ClassLevels[] {
  const more = b.multiclass ?? [];
  const first = b.level - more.reduce((s, m) => s + m.level, 0);
  return [{ class: b.class, subclass: b.subclass, level: first, hpRolls: b.hpRolls }, ...more];
}

/** What a build may pick (the builder's spell counts): totals over every class, and each class's highest spell level. */
export interface SpellLimits {
  cantrips: number;
  spells: number;
  classes: { class: string; maxLevel: number }[];
}

/** "Fighter 3 / Wizard 2", or "Fighter" with `levels: false` and one class. */
export function classLine(b: Pick<CharacterBuild, 'class' | 'subclass' | 'level' | 'multiclass'>, name: (id: string) => string, levels = true): string {
  const all = classLevels(b);
  return all.map((x) => `${name(x.class)}${levels || all.length > 1 ? ` ${x.level}` : ''}`).join(' / ');
}

export interface Character extends CharacterBuild {
  id: string;
  ownerId: string;
  xp: number;
  /** Final scores (base + bonuses + ASI). */
  abilities: Abilities;
  hp: number;
  maxHp: number;
  tempHp: number;
  hitDie: number;
  saves: Ability[];
  counters: Counter[];
  conditions: Condition[];
  concentration?: string;
  inventory: InventoryItem[];
  gold: number;
  deathSaves: { success: number; fail: number };
  exhaustion: number;
  portrait?: string;
  /** Portraits made for this character, newest first, kept until the player deletes them. */
  portraitOptions?: string[];
  /** Portraits being painted now: since when, how many, and the place in the picture queue (0 = painting). */
  portraitJob?: { since: number; count: number; position: number };
  /** Why the last portraits failed, shown until the next try. */
  portraitError?: string;
  /** XP reached the next level: the player walks through level-up in the builder. */
  levelUpPending?: boolean;
  notes?: string;
  updatedAt?: string;
}

/** Numbers the server derives from a sheet (never stored, never trusted from clients or the AI). */
export interface Derived {
  profBonus: number;
  mods: Abilities;
  ac: number;
  initiative: number;
  speed: number;
  passivePerception: number;
  saveBonus: Abilities;
  skillBonus: Record<string, number>;
  /** How each save and skill bonus is built ("WIS +3", "Proficiency +2", "Exhaustion -4"); the values add up to saveBonus / skillBonus. */
  saveParts: Record<Ability, RollPart[]>;
  skillParts: Record<string, RollPart[]>;
  spellAbility?: Ability;
  spellDc?: number;
  spellAttack?: number;
  maxSpellLevel: number;
  nextLevelXp?: number;
}
