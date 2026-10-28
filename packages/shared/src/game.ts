import type { Character, Derived } from './character';
import type { Ruleset } from './rules';

export type GameStatus = 'setup' | 'playing' | 'paused' | 'ended';

export interface SetupField {
  id: string;
  label: string;
  type: 'select' | 'slider' | 'text' | 'multi';
  options?: string[];
  min?: number;
  max?: number;
  default?: string | number | string[];
  help?: string;
}

export interface Pitch {
  title: string;
  hook: string;
  tone?: string;
  themes?: string[];
}

export interface GameSettings {
  startLevel: number;
  endLevel: number;
  maxPlayers: number;
  /** One player may run more than one character. */
  multiChars: boolean;
  /** Rerolls for the whole group (narration rerolls; dice stay fixed). */
  rerolls: number;
  xpMode: 'xp' | 'milestone';
  /** Accept "manual" ability scores (3-18 typed in) from imported sheets. */
  allowManualScores: boolean;
  /** XP or gold above this in one turn needs the host's approval. */
  approvalXp: number;
  approvalGold: number;
  wishes?: string;
  pitches?: Pitch[];
  pitch?: Pitch;
  form?: { title?: string; summary?: string; fields: SetupField[] };
  formValues?: Record<string, string | number | string[]>;
  /** House rules / tone notes for the campaign file. */
  houseRules?: string;
  /** Illustrate new scenes with HiveMind images (default on). */
  sceneImages?: boolean;
  /** The scripted tutorial (no HiveMind). */
  tutorial?: boolean;
  /** Opt-in: this game's DM turns may be exported as training data for HiveMind's Lab. */
  labExport?: boolean;
}

export interface GameMember {
  userId: string;
  username: string;
  role: 'host' | 'player';
  status: 'invited' | 'joined';
  online?: boolean;
}

export interface GameSummary {
  id: string;
  name: string;
  ruleset: Ruleset;
  status: GameStatus;
  visibility: 'public' | 'private';
  host: string;
  players: number;
  updatedAt: string;
  myRole?: 'host' | 'player' | 'invited' | 'spectator';
}

/** A character inside a game (a copy of a library character). */
export interface GameCharacter extends Character {
  userId: string;
  /** Takes part in turns (false = sitting this one out). */
  seated: boolean;
  /** The player is away: the character stays quietly with the group. */
  absent: boolean;
}

/** A creature the DM tracks (from the state JSON). */
export interface Npc {
  name: string;
  hp?: number;
  maxHp?: number;
  ac?: number;
  dex?: number;
  status?: 'hostile' | 'neutral' | 'friendly' | 'dead' | 'fled';
  voice?: string;
}

export interface Zone {
  name: string;
  /** Feet to other zones. */
  distances: Record<string, number>;
}

export interface InitiativeEntry {
  name: string;
  /** Player character id, or undefined for NPCs. */
  characterId?: string;
  roll: number;
  bonus: number;
  total: number;
}

export interface CombatState {
  round: number;
  order: InitiativeEntry[];
  /** Index into order whose turn it is. */
  turn: number;
}

export type Phase =
  | 'lobby'
  | 'opening'
  | 'collect'
  | 'adjudicating'
  | 'rolling'
  | 'narrating'
  | 'approval'
  | 'error'
  | 'paused'
  | 'ended';

export interface DeclaredAction {
  characterId: string;
  /** Picked choice index (0-3) or undefined for "Other". */
  choice?: number;
  text: string;
  at: string;
}

/** One roll the server is waiting on (the player picks server roll or "I roll myself"). */
export interface PendingRoll {
  id: string;
  actor: string;
  characterId?: string;
  kind: 'attack' | 'save' | 'check' | 'damage' | 'heal' | 'initiative' | 'death' | 'concentration' | 'hitdie';
  label: string;
  /** What to roll: "1d20" (+ adv) or a damage expression. */
  dice: string;
  adv?: 'adv' | 'dis' | 'none';
  bonus: number;
  dc?: number;
  targetAc?: number;
  target?: string;
  damageType?: string;
  /** Only rolled if this attack hit / this save failed. */
  onHit?: string;
  onFail?: string;
  crit?: boolean;
  /** Damage after a successful save: half. */
  half?: boolean;
  /** The server rolls this one itself (NPCs, away players). */
  auto?: boolean;
  reason?: string;
  result?: RollOutcome;
}

export interface RollOutcome {
  dice: number[];
  /** d20 tests: the die that counts. */
  natural?: number;
  total: number;
  manual: boolean;
  success?: boolean;
  crit?: boolean;
  fumble?: boolean;
  skipped?: boolean;
  text: string;
}

export interface Approval {
  id: string;
  kind: 'xp' | 'gold' | 'delta';
  characterId: string;
  name: string;
  amount: number;
  reason: string;
}

export interface GameState {
  phase: Phase;
  turn: number;
  /** Choices per character id. */
  choices: Record<string, string[]>;
  actions: Record<string, DeclaredAction>;
  rolls: PendingRoll[];
  /** The adjudicator already ran for this turn's actions (rolls are fixed from here on). */
  adjudicated?: boolean;
  /** Resources spent this turn (refunded on a refused action). */
  spent: { characterId: string; name: string; amount: number }[];
  refused: { characterId: string; reason: string }[];
  npcs: Npc[];
  zones: Zone[];
  positions: Record<string, string[]>;
  combat?: CombatState;
  approvals: Approval[];
  error?: string;
  /** "The DM is thinking… (#2 in queue)". */
  queue?: number;
  rerollsLeft: number;
  rerollVote?: { by: string; votes: Record<string, boolean>; turn: number };
  sceneImage?: string;
  /** Live narration while it streams. */
  streaming?: string;
  speakers?: { name: string; kind: string; gender?: string; age?: string }[];
  /** NPC name → the voice the narrator gives them (kept for the whole game). */
  voices?: Record<string, { voice: string; fx: string }>;
}

export interface LogEntry {
  id: number;
  turn: number;
  kind: 'narration' | 'action' | 'roll' | 'system' | 'change' | 'ask' | 'answer' | 'refused' | 'note' | 'image' | 'levelup';
  actor?: string;
  text: string;
  data?: Record<string, unknown>;
  at: string;
}

export interface GameDetail {
  id: string;
  name: string;
  ruleset: Ruleset;
  status: GameStatus;
  visibility: 'public' | 'private';
  hostId: string;
  settings: GameSettings;
  members: GameMember[];
  characters: GameCharacter[];
  state: GameState;
  /** Server-derived numbers per game character id (AC, saves, spell DC…). */
  derived: Record<string, Derived>;
  myRole: 'host' | 'player' | 'invited' | 'spectator';
}
