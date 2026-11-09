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
  subspecies: { id: string; name: string; abilityBonuses: Partial<Abilities>; traits: string[]; speed?: number; source?: string }[];
  languages?: string[];
}

export interface RulesBackground {
  id: string;
  name: string;
  skills: string[];
  tools?: string[];
  languages?: number;
  source?: string;
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
  /** Hand-written numbers the server rolls with (server/data/<ruleset>/spell-effects.json). */
  effect?: SpellEffect;
}

/**
 * What a spell does in numbers. Dice may use "mod" for the caster's spellcasting modifier ("1d8+mod").
 * Everything is per target, and per ray, dart or beam when the spell has a `count`.
 */
export interface SpellEffect {
  /** A spell attack roll; damage follows on a hit. */
  attack?: 'melee' | 'ranged';
  /** The target makes this saving throw against the caster's spell save DC. */
  save?: Ability;
  /** A made save still takes half the damage. */
  half?: boolean;
  /** Hits without a roll (Magic Missile). */
  autoHit?: boolean;
  /** Extra damage on the caster's own attack hits (smites, Hex, Hunter's Mark). */
  rider?: boolean;
  /** Damage parts; several for spells like Flame Strike (fire + radiant). A type the caster picks lists the options: "acid|cold|fire"; "weapon" is the weapon's type. */
  damage?: { dice: string; type: string; upcast?: string }[];
  heal?: string;
  tempHp?: string;
  /** Added to the first damage part (or the healing) per slot level above the spell's level; a part's own `upcast` is for spells where several grow (2024 Flame Strike). */
  upcast?: string;
  /** `upcast` comes once per this many slot levels above (2014 Spiritual Weapon: 2). */
  upcastEvery?: number;
  /** Cantrips at character level 5, 11 and 17: "dice" means 2, 3, 4 times the dice; "count" means 2, 3, 4 beams. */
  scales?: 'dice' | 'count';
  /** Separate rays, darts or beams, each with its own damage. */
  count?: number;
  /** More of `count` per slot level above. */
  countUpcast?: number;
  /** "20-foot-radius sphere": every creature in it is a target. */
  area?: string;
  /** Conditions a target gets on a hit or failed save (or simply when cast, without attack or save). */
  conditions?: { name: string; rounds?: number }[];
  /** Ongoing or conditional parts the story has to handle ("2d4 acid again at the end of its next turn"). */
  note?: string;
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
  /** Saving throw bonuses the stat block lists (proficient saves); the others are the ability modifier. */
  saves?: Partial<Abilities>;
  /** Skill bonuses by skill id ("perception": 9). */
  skills?: Record<string, number>;
  cr: number;
  xp: number;
  senses?: string;
  languages?: string;
  traits: string[];
  actions: string[];
}

export interface RulesEntry {
  source?: string;
  id: string;
  name: string;
  desc: string;
  /** Feature: class id; trait: species ids. */
  owner?: string;
  level?: number;
  /** Class features: hand-written numbers the server uses (server/data/<ruleset>/class-features.json). */
  effect?: FeatureEffect;
}

/**
 * A number that grows with the class level: a plain number, a formula over `level` (the class level), `pb`,
 * the ability modifiers (`str`…`cha`) and the class table's number columns ("max(1, cha)", "5 * level", "rage_count"),
 * or a step table by class level ({ "1": 2, "3": 3 }).
 */
export type LevelValue = number | string | Record<string, number>;

/**
 * What a class or subclass feature does in numbers. Everything is per class level, so a feature reads the same
 * for a single class and for one class of a multiclass character.
 */
export interface FeatureEffect {
  /** Only for this subclass (the imported features don't say which ones are a subclass's). */
  subclass?: string;
  /**
   * A limited-use counter. A later feature naming the same counter changes it (Font of Inspiration: recharge "short").
   * `regain`: a short rest gives back this many of a long-rest counter (2024 Rage: 1).
   */
  counter?: { name?: string; uses?: LevelValue; recharge?: 'short' | 'long' | 'dawn' | 'turn'; regain?: number };
  /** Spending the counter puts this condition on the character (Rage: "raging"). */
  grants?: { name: string; rounds?: number };
  /** The parts below work only while the character has this condition. */
  while?: string;
  /**
   * Extra damage on the character's own hits. `dice` is a dice expression ("1d8"), a LevelValue for a flat bonus
   * ("rage_damage_bonus"), or a step table of dice ({ "1": "1d6", "3": "2d6" }). "weapon" damage takes the weapon's type.
   * `ask`: only when the adjudicator names the feature on the damage roll (the server can't see the conditions).
   * `slot`: spends a spell slot, with `upcast` dice per slot level above 1st, up to `max` (2014 Divine Smite).
   * `name`: what the table calls it when that isn't the feature's name (Blessed Strikes: "Divine Strike").
   * `on`: "melee" counts Unarmed Strikes too; a type the character picks lists the options ("cold|fire").
   */
  damage?: {
    name?: string;
    dice: string | Record<string, string>;
    type: string;
    on: 'weapon' | 'melee' | 'melee-weapon' | 'str-melee' | 'finesse-or-ranged';
    once?: 'turn';
    ask?: boolean;
    slot?: { upcast: string; max: string };
  };
  /** Healing the server rolls when a heal roll names the feature ("1d10+level"). */
  heal?: string;
  /** Advantage on the character's own d20 tests; `spell`: only spell attacks. */
  advantage?: { kind: 'attack' | 'save' | 'check'; ability?: Ability; spell?: boolean }[];
  /** Damage types halved. */
  resist?: string[];
  /** Weapon attacks score a critical hit on this natural roll or higher (Improved Critical: 19). */
  critOn?: number;
  /** What the story has to handle. */
  note?: string;
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
