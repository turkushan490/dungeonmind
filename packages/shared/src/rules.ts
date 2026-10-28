// Normalized SRD data, the same shape for both rulesets (built by scripts/import-srd.mjs).

export const RULESETS = ['srd51', 'srd52'] as const;
export type Ruleset = (typeof RULESETS)[number];
export const RULESET_NAMES: Record<Ruleset, string> = { srd51: 'D&D 5e 2014 (SRD 5.1)', srd52: 'D&D 5e 2024 (SRD 5.2)' };

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type Ability = (typeof ABILITIES)[number];
export type Abilities = Record<Ability, number>;

export interface RulesClassLevel {
  level: number;
  profBonus: number;
  features: string[];
  /** Cantrips/known/prepared counts and slots per spell level 1-9. */
  spellcasting?: { cantrips?: number; known?: number; prepared?: number; slots: number[] };
  /** e.g. rage_count, ki_points, sorcery_points, invocations_known. */
  classSpecific?: Record<string, unknown>;
  /** 2014: ability score improvements so far. */
  asi?: number;
}

export interface RulesClass {
  id: string;
  name: string;
  hitDie: number;
  saves: Ability[];
  skillChoices: { choose: number; from: string[] };
  proficiencies: string[];
  spellAbility?: Ability;
  subclasses: { id: string; name: string; desc?: string }[];
  levels: RulesClassLevel[];
  /** Plain-text starting equipment hints for the builder. */
  equipment: string[];
}

export interface RulesSpecies {
  id: string;
  name: string;
  speed: number;
  size: string;
  /** 2014: fixed racial bonuses. 2024: empty (the background gives the bonuses). */
  abilityBonuses: Partial<Abilities>;
  traits: string[];
  subspecies: { id: string; name: string; abilityBonuses: Partial<Abilities>; traits: string[] }[];
  languages?: string[];
}

export interface RulesBackground {
  id: string;
  name: string;
  skills: string[];
  /** 2024: the three abilities the +2/+1 (or +1/+1/+1) go to. */
  abilityOptions?: Ability[];
  feat?: string;
  feature?: string;
  equipment: string[];
}

export interface RulesSpell {
  id: string;
  name: string;
  level: number;
  school: string;
  classes: string[];
  castingTime: string;
  range: string;
  duration: string;
  concentration: boolean;
  ritual: boolean;
  components: string;
  desc: string;
  higher?: string;
  attack?: string;
  save?: Ability;
  damage?: string;
}

export interface RulesItem {
  id: string;
  name: string;
  category: string;
  cost?: string;
  weight?: number;
  damage?: string;
  damageType?: string;
  /** Two-handed / versatile damage. */
  damage2?: string;
  properties?: string[];
  range?: { normal: number; long?: number };
  armor?: { base: number; dexBonus: boolean; maxBonus?: number; stealthDisadvantage?: boolean; strMin?: number };
  rarity?: string;
  magic?: boolean;
  desc?: string;
}

export interface RulesMonster {
  id: string;
  name: string;
  size: string;
  type: string;
  ac: number;
  hp: number;
  hitDice: string;
  speed: string;
  abilities: Abilities;
  cr: number;
  xp: number;
  senses?: string;
  languages?: string;
  traits: string[];
  actions: string[];
}

export interface RulesEntry {
  id: string;
  name: string;
  desc: string;
  /** Feature: class id; trait: species ids. */
  owner?: string;
  level?: number;
}

export interface RulesData {
  ruleset: Ruleset;
  classes: RulesClass[];
  species: RulesSpecies[];
  backgrounds: RulesBackground[];
  feats: RulesEntry[];
  spells: RulesSpell[];
  items: RulesItem[];
  monsters: RulesMonster[];
  conditions: RulesEntry[];
  skills: { id: string; name: string; ability: Ability }[];
  features: RulesEntry[];
  traits: RulesEntry[];
  rules: RulesEntry[];
}

/** XP needed for each level (same in both rulesets). Index = level. */
export const XP_TABLE = [0, 0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];

export const profBonus = (level: number) => 2 + Math.floor((Math.max(1, Math.min(20, level)) - 1) / 4);
export const mod = (score: number) => Math.floor((score - 10) / 2);
export const SKILLS: Record<string, Ability> = {
  acrobatics: 'dex',
  'animal-handling': 'wis',
  arcana: 'int',
  athletics: 'str',
  deception: 'cha',
  history: 'int',
  insight: 'wis',
  intimidation: 'cha',
  investigation: 'int',
  medicine: 'wis',
  nature: 'int',
  perception: 'wis',
  performance: 'cha',
  persuasion: 'cha',
  religion: 'int',
  'sleight-of-hand': 'dex',
  stealth: 'dex',
  survival: 'wis',
};
