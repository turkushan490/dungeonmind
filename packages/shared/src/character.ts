import type { Abilities, Ability, Ruleset } from './rules';

export type Recharge = 'short' | 'long' | 'dawn' | 'turn' | 'none';

/** Every limited thing: spell slots, class features, racial traits, item charges, hit dice, ammo. */
export interface Counter {
  name: string;
  current: number;
  max: number;
  recharge: Recharge;
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
  spellAbility?: Ability;
  spellDc?: number;
  spellAttack?: number;
  maxSpellLevel: number;
  nextLevelXp?: number;
}
