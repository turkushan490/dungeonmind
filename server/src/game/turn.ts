import type { GameCharacter, GameState, Npc } from '@dungeonmind/shared';
import { db, json, tx } from '../db.js';
import { health, HiveMindError, outputJson, outputText, runCanvas, withRetry, type RunResult } from '../hivemind.js';
import { emitToGame } from '../realtime.js';
import { applyPatches, currentCampaign, initialCampaign, saveCampaign, withParty, type Patch } from './campaign.js';
import { addLog, lastLogId } from './log.js';
import { campaignFor, partyJson, recentTurns } from './prompt.js';
import { think } from './queue.js';
import { broadcast, gameCharacters, loadGame, members, saveGame, saveGameCharacter, type GameRow } from './store.js';
import { clip, sameName } from './text.js';

/** The state JSON the dnd-narrate canvas returns (see hivemind/dnd-narrate.canvas.json). */
export interface StateJson {
  deltas?: unknown[];
  xp?: unknown[];
  npcs?: Npc[];
  combat?: { start?: boolean; end?: boolean; enemies?: string[] } | null;
  zones?: unknown[];
  positions?: Record<string, unknown>;
  choices?: Record<string, unknown>;
  speakers?: { name: string; kind: string; gender?: string; age?: string }[];
  image?: string | null;
  sceneEnd?: boolean;
  summary?: string;
}

/** Hooks later milestones plug into the turn (Bookkeeper, TTS, scene images). */
export interface TurnHooks {
  /** Before narration: work out rolls/resources. Returns false when the turn must wait (refusals, pending rolls). */
  beforeNarrate?: (g: GameRow) => Promise<boolean>;
  /** Inside the turn's transaction: apply the state JSON to characters and the game state. */
  applyState?: (g: GameRow, chars: GameCharacter[], state: StateJson, results: string) => void;
  /** After the turn is saved and broadcast. */
  afterTurn?: (g: GameRow, narration: string, state: StateJson, logId: number) => void;
}
const hooks: TurnHooks[] = [];
export const addTurnHooks = (h: TurnHooks) => hooks.push(h);

/** One resolve at a time per game. */
const locks = new Map<string, Promise<void>>();
function locked(gameId: string, fn: () => Promise<void>): Promise<void> {
  const prev = locks.get(gameId) ?? Promise.resolve();
  const next = prev.then(fn, fn).finally(() => locks.get(gameId) === next && locks.delete(gameId));
  locks.set(gameId, next);
  return next;
}
/** Tests wait for background turns with this. */
export const settled = (gameId: string) => locks.get(gameId) ?? Promise.resolve();

export const playersOf = (gameId: string) => Object.fromEntries(members(gameId).map((m) => [m.userId, m.username]));

/** Characters whose action the turn waits for. */
export const activeCharacters = (chars: GameCharacter[]) => chars.filter((c) => c.seated && !c.absent && c.hp > 0 && !c.conditions.some((x) => x.name === 'dead'));

export function setPhase(g: GameRow, phase: GameState['phase'], extra: Partial<GameState> = {}) {
  g.state = { ...g.state, phase, ...extra };
  if (phase !== 'error') delete g.state.error;
  saveGame(g);
  broadcast(g);
}

/** Every DM call goes through the queue, retries on failure, and streams narration to the table. */
export async function dm(g: GameRow, canvasId: string, question: string, vars: Record<string, string>, stream = false): Promise<RunResult> {
  return think(
    g.id,
    () =>
      withRetry(
        () => {
          let text = '';
          return runCanvas(canvasId, question, {
            vars,
            onToken: stream
              ? (label, t) => {
                  if (label !== 'narration') return;
                  text += t;
                  emitToGame(g.id, 'game:stream', { gameId: g.id, text: t, full: text.length < 200 ? text : undefined });
                }
              : undefined,
          });
        },
        {
          onRetry: (attempt, err) => {
            emitToGame(g.id, 'game:stream-reset', { gameId: g.id });
            addLog(g.id, g.state.turn, 'system', `The DM stumbled (${clip(err.message, 160)}). Trying again (${attempt + 1}/3)…`);
          },
        },
      ),
    (n) => {
      if (g.state.queue === n) return;
      g.state.queue = n || undefined;
      saveGame(g);
      broadcast(g);
    },
  );
}

function fail(g: GameRow, err: unknown) {
  const msg = (err as Error).message ?? String(err);
  const fresh = loadGame(g.id) ?? g;
  fresh.state.queue = undefined;
  setPhase(fresh, 'error', { error: msg });
  addLog(g.id, fresh.state.turn, 'system', `The DM couldn't continue: ${clip(msg, 300)}. Nothing was lost; press Retry.`);
}

// ---- Start ----

export async function startGame(g: GameRow): Promise<void> {
  const h = await health();
  if (!h.ok) throw new HiveMindError(`HiveMind is not reachable: ${h.error ?? 'unknown'}`, 503, false);
  if (h.missing.length) throw new HiveMindError(`HiveMind is missing ${h.missing.join(', ')} (update HiveMind)`, 409, false);
  const chars = gameCharacters(g.id);
  if (!chars.length) throw new HiveMindError('Seat at least one character first', 400, false);
  tx(() => {
    saveCampaign(g.id, initialCampaign(g.name, g.ruleset, g.settings, chars), 'system', 0);
    g.status = 'playing';
    g.state.phase = 'opening';
    saveGame(g);
  });
  addLog(g.id, 0, 'system', `The adventure “${g.name}” begins.`);
  broadcast(g);
  void locked(g.id, () => narrateOpening(g.id));
}

async function narrateOpening(gameId: string) {
  const g = loadGame(gameId)!;
  try {
    const chars = gameCharacters(g.id);
    const r = await dm(
      g,
      'dnd-narrate',
      'Begin the adventure.',
      {
        mode: 'opening',
        tableId: g.id,
        ruleset: g.ruleset,
        campaign: campaignFor(g, chars),
        party: partyJson(g.ruleset, chars, g.state, playersOf(g.id)),
        recent: '(no turns yet)',
        actions: 'The adventure begins. Introduce the scene.',
        results: '[]',
        fix: '',
      },
      true,
    );
    await finishNarration(g.id, r, '[]');
  } catch (err) {
    fail(g, err);
  }
}

// ---- Actions ----

export interface ActionInput {
  characterId: string;
  choice?: number;
  text?: string;
}

/** A player declares what their character does. When every active character has acted, the turn resolves. */
export function submitAction(g: GameRow, userId: string, input: ActionInput, isHost: boolean): { error?: string; resolving?: boolean } {
  if (g.status !== 'playing') return { error: g.status === 'paused' ? 'The game is paused' : 'The game is not running' };
  if (g.state.phase !== 'collect') return { error: 'The DM is not waiting for actions right now' };
  const chars = gameCharacters(g.id);
  const c = chars.find((x) => x.id === input.characterId);
  if (!c) return { error: 'No such character at this table' };
  if (c.userId !== userId && !(isHost && c.absent)) return { error: "That's not your character" };
  if (!activeCharacters(chars).includes(c)) return { error: `${c.name} is not taking part right now` };
  if (g.state.combat && !g.state.combat.order.some((o) => o.characterId === c.id)) return { error: `${c.name} is not in the initiative order` };
  const options = g.state.choices[c.id] ?? [];
  let text: string;
  if (input.choice !== undefined && input.choice !== null) {
    text = options[input.choice];
    if (!text) return { error: 'That choice is not on the list' };
  } else {
    text = String(input.text ?? '').trim();
    if (!text) return { error: 'Write what you do' };
    if (text.length > 600) return { error: 'Keep it under 600 characters' };
  }
  g.state.actions[c.id] = { characterId: c.id, choice: input.choice ?? undefined, text, at: new Date().toISOString() };
  g.state.refused = g.state.refused.filter((r) => r.characterId !== c.id);
  saveGame(g);
  broadcast(g);
  const waiting = activeCharacters(chars).filter((x) => !g.state.actions[x.id]);
  if (waiting.length) return {};
  void locked(g.id, () => resolveTurn(g.id));
  return { resolving: true };
}

/** Actions in turn order: initiative order in combat, seating order otherwise. */
export function orderedActions(g: GameRow, chars: GameCharacter[]) {
  const acts = Object.values(g.state.actions);
  const pos = (id: string) => (g.state.combat ? g.state.combat.order.findIndex((o) => o.characterId === id) : chars.findIndex((c) => c.id === id));
  return acts.sort((a, b) => pos(a.characterId) - pos(b.characterId));
}

export function actionsText(g: GameRow, chars: GameCharacter[]): string {
  const players = playersOf(g.id);
  return orderedActions(g, chars)
    .map((a) => {
      const c = chars.find((x) => x.id === a.characterId)!;
      return `${c.name} (${players[c.userId] ?? 'player'}): ${a.text}`;
    })
    .join('\n');
}

// ---- Resolve ----

/** Runs (or re-runs after a failure) the current turn from the last good step. */
export async function resolveTurn(gameId: string): Promise<void> {
  const g = loadGame(gameId);
  if (!g || g.status !== 'playing') return;
  if (g.state.phase === 'opening' || (g.state.phase === 'error' && g.state.turn === 0 && !Object.keys(g.state.actions).length)) return narrateOpening(gameId);
  try {
    for (const h of hooks) if (h.beforeNarrate && !(await h.beforeNarrate(g))) return;
    const chars = gameCharacters(g.id);
    setPhase(g, 'narrating');
    const results = resultsText(g);
    const r = await dm(
      g,
      'dnd-narrate',
      actionsText(g, chars),
      {
        mode: 'turn',
        tableId: g.id,
        ruleset: g.ruleset,
        campaign: campaignFor(g, chars),
        party: partyJson(g.ruleset, chars, g.state, playersOf(g.id)),
        recent: recentTurns(g.id),
        actions: actionsText(g, chars),
        results,
        combat: g.state.combat ? JSON.stringify(g.state.combat) : 'null',
        fix: '',
      },
      true,
    );
    await finishNarration(g.id, r, results);
  } catch (err) {
    fail(g, err);
  }
}

/** The resolved dice of this turn, as the narrator sees them. */
export function resultsText(g: GameRow): string {
  return JSON.stringify(
    g.state.rolls
      .filter((r) => r.result)
      .map((r) => ({ id: r.id, actor: r.actor, roll: r.label, target: r.target, result: r.result!.text, success: r.result!.success, total: r.result!.total })),
  );
}

/** Saves a snapshot of the turn before it is applied (rerolls and rollback restore it). */
export function snapshot(g: GameRow, chars: GameCharacter[]) {
  db.prepare('INSERT OR REPLACE INTO turn_snapshots (game_id, turn, state, characters, log_from) VALUES (?, ?, ?, ?, ?)').run(g.id, g.state.turn, JSON.stringify(g.state), JSON.stringify(chars), lastLogId(g.id));
}

export function loadSnapshot(gameId: string, turn: number): { state: GameState; characters: GameCharacter[]; logFrom: number } | undefined {
  const r = db.prepare('SELECT state, characters, log_from FROM turn_snapshots WHERE game_id = ? AND turn = ?').get(gameId, turn) as Record<string, any> | undefined;
  return r ? { state: json(r.state, {} as GameState), characters: json(r.characters, []), logFrom: r.log_from } : undefined;
}

/** Narration + state JSON in: one transaction applies everything, then the Chronicler updates campaign.md. */
export async function finishNarration(gameId: string, r: RunResult, results: string) {
  const narration = outputText(r, 'narration');
  const state = outputJson<StateJson>(r, 'state');
  const g = loadGame(gameId)!;
  let logId = 0;
  tx(() => {
    const chars = gameCharacters(g.id);
    snapshot(g, chars);
    logId = addLog(g.id, g.state.turn, 'narration', narration, 'DM', { speakers: state.speakers ?? [], results: json(results, []) }).id;
    if (Array.isArray(state.npcs)) g.state.npcs = mergeNpcs(g.state.npcs, state.npcs, new Set(g.state.rolls.filter((r) => (r.kind === 'damage' || r.kind === 'heal') && r.result && !r.result.skipped && r.target).map((r) => r.target!)));
    for (const h of hooks) h.applyState?.(g, chars, state, results);
    // Choices: 4 per character, keyed by id.
    g.state.choices = {};
    for (const c of activeCharacters(chars)) {
      const key = Object.keys(state.choices ?? {}).find((k) => sameName(k, c.name));
      const list = key ? (state.choices![key] as unknown[]) : [];
      g.state.choices[c.id] = (Array.isArray(list) ? list : []).map((x) => clip(String(x), 200)).filter(Boolean).slice(0, 4);
    }
    g.state.speakers = Array.isArray(state.speakers) ? state.speakers.slice(0, 12) : [];
    for (const c of chars) saveGameCharacter(g.id, c);
    g.state.turn += 1;
    g.state.actions = {};
    g.state.rolls = [];
    g.state.adjudicated = false;
    g.state.spent = [];
    g.state.refused = [];
    g.state.queue = undefined;
    g.state.rerollVote = undefined;
    g.state.phase = g.state.approvals.length ? 'approval' : 'collect';
    saveGame(g);
  });
  emitToGame(g.id, 'game:stream-end', { gameId: g.id });
  broadcast(g);
  for (const h of hooks) h.afterTurn?.(g, narration, state, logId);
  await chronicle(g, narration, state);
}

/** Merges the DM's NPC list. NPCs the dice hit this turn keep the server's HP (the Bookkeeper applies the damage). */
export function mergeNpcs(old: Npc[], incoming: unknown[], protect: Set<string> = new Set()): Npc[] {
  const out = old.map((n) => ({ ...n }));
  for (const raw of incoming.slice(0, 40)) {
    if (!raw || typeof raw !== 'object' || typeof (raw as Npc).name !== 'string') continue;
    const n = raw as Npc;
    const num = (v: unknown, max = 100_000) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : undefined);
    const clean: Npc = {
      name: clip(n.name, 60),
      hp: num(n.hp),
      maxHp: num(n.maxHp),
      ac: num(n.ac, 40),
      dex: typeof n.dex === 'number' ? Math.max(-5, Math.min(10, Math.round(n.dex))) : undefined,
      status: ['hostile', 'neutral', 'friendly', 'dead', 'fled'].includes(n.status ?? '') ? n.status : undefined,
      voice: typeof n.voice === 'string' ? clip(n.voice, 40) : undefined,
    };
    const prev = out.find((o) => sameName(o.name, clean.name));
    const guarded = [...protect].some((p) => sameName(p, clean.name));
    if (guarded) {
      clean.hp = prev?.hp ?? clean.maxHp ?? clean.hp;
      if (clean.status === 'dead' && (clean.hp ?? 1) > 0) delete clean.status;
    }
    if (prev) Object.assign(prev, Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== undefined)));
    else out.push(clean);
  }
  return out.slice(-60);
}

/** The Chronicler: section patches for campaign.md. A failure here never blocks the game. */
export async function chronicle(g: GameRow, narration: string, state: StateJson) {
  try {
    const chars = gameCharacters(g.id);
    const md = withParty(currentCampaign(g.id), chars, g.state.npcs);
    const r = await dm(g, 'dnd-chronicle', `${narration}\n\nSummary: ${state.summary ?? ''}`, {
      mode: state.sceneEnd ? 'summary' : 'turn',
      campaign: md,
      state: JSON.stringify(state),
      tableId: g.id,
    });
    const { patches } = outputJson<{ patches?: Patch[] }>(r, 'patches');
    const next = applyPatches(md, Array.isArray(patches) ? patches : []);
    saveCampaign(g.id, next.md, 'chronicler', g.state.turn);
    emitToGame(g.id, 'game:campaign', { gameId: g.id });
  } catch (err) {
    addLog(g.id, g.state.turn, 'note', `The Chronicler couldn't update the campaign file this turn (${clip((err as Error).message, 160)}). It catches up next turn.`);
  }
}

// ---- Retry, pause, recovery ----

/** Resolves the turn in the background (one at a time per game). */
export const resolveLater = (gameId: string) => void locked(gameId, () => resolveTurn(gameId));

export function retry(g: GameRow) {
  if (g.state.phase !== 'error') return false;
  void locked(g.id, () => resolveTurn(g.id));
  return true;
}

/** After a restart, turns that were mid-flight wait for a Retry (their actions and rolls are kept). */
export function recoverInterrupted() {
  for (const r of db.prepare("SELECT id FROM games WHERE status = 'playing'").all() as { id: string }[]) {
    const g = loadGame(r.id)!;
    if (['opening', 'adjudicating', 'narrating'].includes(g.state.phase)) {
      g.state.phase = 'error';
      g.state.error = 'The server restarted while the DM was thinking. Press Retry to continue.';
      g.state.queue = undefined;
      saveGame(g);
    }
  }
}
