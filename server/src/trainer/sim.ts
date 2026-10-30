import type { CharacterBuild, GameCharacter } from '@dungeonmind/shared';
import { newId } from '../crypto.js';
import { db, json, tx } from '../db.js';
import { buildCharacter } from '../game/character.js';
import { playerRoll } from '../game/engine.js';
import { readLog } from '../game/log.js';
import { DEFAULT_SETTINGS, freshState, gameCharacters, loadGame, saveGame } from '../game/store.js';
import { activeCharacters, resolveLater, retry, settled, startGame, submitAction } from '../game/turn.js';
import { clip } from '../game/text.js';
import { outputJson, outputText, runCanvas, type ModelRef, type RunEvent } from '../hivemind.js';
import { rules } from '../rules/index.js';
import { seeded, seedOf, simStore, type SimContext } from './context.js';
import { live } from './live.js';
import { turnSignals } from './records.js';

/**
 * M9 §5: the headless simulator. Sim games are real games (flagged `sim`, hidden from the lobby) played by fake
 * players through the real engine, Bookkeeper and canvases, with seeded dice. The judge checks every turn the
 * Bookkeeper flags plus a random sample of the others. Comparing models uses HiveMind's `models` run override.
 */
export const PERSONAS = ['reckless fighter', 'rules-lawyer', 'sneaky rogue', 'healer', 'typo-heavy casual'] as const;

/** Fixed eval scenarios (the nightly decision compares models on exactly these, with the same seeds). */
export const EVAL_SCENARIOS = [
  'The party guards a caravan on a muddy forest road at dusk. Four goblins burst from the brush, two with shortbows on a ridge, while the panicked mule drags the lead wagon toward a ravine.',
  'In a flooded crypt, the party must cross a chamber of rising black water. A drowned priest guards the only stair up, and one of them is already wounded and low on spells.',
];

export interface SimSettings {
  /** DM models to compare; empty = the canvases' current models. */
  models: ModelRef[];
  /** Also play with the canvases' current models (no override). */
  includeCurrent?: boolean;
  games: number;
  turns: number;
  /** Scenario ids from the table; empty = all of them. */
  scenarioIds: string[];
  /** Share of the turns the Bookkeeper did NOT flag that the judge checks too (0-1). */
  judgeSample: number;
  /** Eval runs: the scenarios themselves. */
  scenarios?: string[];
  gameIds?: string[];
}

export interface ModelStats {
  games: number;
  turns: number;
  jsonOk: number;
  jsonTotal: number;
  errors: { rules: number; number: number; resource: number; contradiction: number; json: number };
  judged: number;
  storySum: number;
  storyN: number;
  tokens: number;
  tokenMs: number;
  turnMs: number;
}

export interface Scoreboard {
  model: string;
  games: number;
  turns: number;
  jsonValid: number;
  rulesPer100: number;
  numberPer100: number;
  resourcePer100: number;
  errorsPer100: number;
  story: number | null;
  tokensPerSec: number | null;
  secondsPerTurn: number | null;
}

const emptyStats = (): ModelStats => ({ games: 0, turns: 0, jsonOk: 0, jsonTotal: 0, errors: { rules: 0, number: 0, resource: 0, contradiction: 0, json: 0 }, judged: 0, storySum: 0, storyN: 0, tokens: 0, tokenMs: 0, turnMs: 0 });

const round1 = (n: number) => Math.round(n * 10) / 10;
export function scoreboard(model: string, s: ModelStats): Scoreboard {
  const per100 = (n: number) => (s.turns ? round1((n / s.turns) * 100) : 0);
  return {
    model,
    games: s.games,
    turns: s.turns,
    jsonValid: s.jsonTotal ? round1((s.jsonOk / s.jsonTotal) * 100) : 100,
    rulesPer100: per100(s.errors.rules),
    numberPer100: per100(s.errors.number),
    resourcePer100: per100(s.errors.resource),
    errorsPer100: per100(s.errors.rules + s.errors.number + s.errors.resource),
    story: s.storyN ? round1(s.storySum / s.storyN) : null,
    tokensPerSec: s.tokenMs ? round1(s.tokens / (s.tokenMs / 1000)) : null,
    secondsPerTurn: s.turns ? round1(s.turnMs / s.turns / 1000) : null,
  };
}

export const modelKey = (m?: ModelRef) => (m ? `${m.providerId}/${m.model}` : 'current');

const BASE = { ruleset: 'srd51' as const, level: 1, abilityMethod: 'standard' as const, background: 'acolyte', species: 'human' };
const BUILDS: Record<(typeof PERSONAS)[number], CharacterBuild> = {
  'reckless fighter': { ...BASE, name: 'Brann', class: 'fighter', baseAbilities: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, skills: ['athletics', 'perception'], equipment: ['Chain Mail', 'Longsword', 'Shield', '10 gp'] } as CharacterBuild,
  'rules-lawyer': { ...BASE, name: 'Quill', class: 'wizard', baseAbilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 }, skills: ['arcana', 'history'], cantrips: ['fire-bolt', 'light', 'mage-hand'], spells: ['magic-missile', 'shield', 'sleep', 'burning-hands', 'detect-magic', 'mage-armor'], equipment: ['Quarterstaff', 'Dagger'] } as CharacterBuild,
  'sneaky rogue': { ...BASE, name: 'Vex', class: 'rogue', baseAbilities: { str: 8, dex: 15, con: 13, int: 14, wis: 12, cha: 10 }, skills: ['stealth', 'acrobatics', 'deception', 'perception'], equipment: ['Leather Armor', 'Shortsword', 'Dagger', "Thieves' Tools", '20 Arrows', '10 gp'] } as CharacterBuild,
  healer: { ...BASE, name: 'Esva', class: 'cleric', subclass: 'life', baseAbilities: { str: 13, dex: 10, con: 14, int: 8, wis: 15, cha: 12 }, skills: ['medicine', 'persuasion'], cantrips: ['sacred-flame', 'guidance', 'light'], spells: ['cure-wounds', 'bless', 'guiding-bolt'], equipment: ['Chain Mail', 'Mace', 'Shield'] } as CharacterBuild,
  'typo-heavy casual': { ...BASE, name: 'Dobb', class: 'fighter', baseAbilities: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 }, skills: ['athletics', 'intimidation'], equipment: ['Chain Mail', 'Greataxe', '10 gp'] } as CharacterBuild,
};

const JSON_NODES = ['rolls', 'state', 'patches'];
const validJson = (s: string) => {
  try {
    JSON.parse(s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
    return true;
  } catch {
    return false;
  }
};

/** Which scoreboard column a Bookkeeper note or refusal counts in. */
export function noteKind(signal: string): 'rules' | 'number' | 'resource' {
  if (/^Refused|resource|spending|spell slot|not in the inventory|counter/i.test(signal)) return 'resource';
  if (/HP|gp|XP|gold/i.test(signal)) return 'number';
  return 'rules';
}

const stopped = new Set<string>();
const running = new Map<string, Promise<Record<string, ModelStats>>>();

export const simRow = (id: string) => db.prepare('SELECT * FROM trainer_sims WHERE id = ?').get(id) as Record<string, any> | undefined;

/** Starts a run in the background; `done` resolves with the stats per model. */
export function startSim(hostId: string, settings: SimSettings, kind: 'sim' | 'eval' = 'sim'): { id: string; done: Promise<Record<string, ModelStats>> } {
  const id = newId();
  db.prepare("INSERT INTO trainer_sims (id, kind, status, settings) VALUES (?, ?, 'running', ?)").run(id, kind, JSON.stringify(settings));
  const done = runSim(id, hostId, settings, kind).finally(() => running.delete(id));
  running.set(id, done);
  done.catch(() => {});
  return { id, done };
}

export const stopSim = (id: string) => void stopped.add(id);
export const isRunning = (id: string) => running.has(id);

/** After a restart nothing is running any more. */
export function recoverSims() {
  db.prepare("UPDATE trainer_sims SET status = 'stopped', error = 'The server restarted' WHERE status = 'running'").run();
}

/** Deletes a run with its games (and so their records). */
export function deleteSim(id: string) {
  stopSim(id);
  const row = simRow(id);
  if (!row) return;
  const gameIds = json<SimSettings>(row.settings, {} as SimSettings).gameIds ?? [];
  tx(() => {
    for (const g of gameIds) db.prepare('DELETE FROM games WHERE id = ? AND sim = 1').run(g);
    db.prepare('DELETE FROM lab_records WHERE sim_id = ?').run(id);
    db.prepare('DELETE FROM trainer_sims WHERE id = ?').run(id);
  });
}

async function runSim(id: string, hostId: string, settings: SimSettings, kind: 'sim' | 'eval'): Promise<Record<string, ModelStats>> {
  const stream = `sim:${id}`;
  const stats: Record<string, ModelStats> = {};
  const save = (status = 'running', error?: string) =>
    db.prepare(`UPDATE trainer_sims SET status = ?, results = ?, settings = ?, error = ?${status === 'running' ? '' : ", finished_at = datetime('now')"} WHERE id = ?`).run(status, JSON.stringify(stats), JSON.stringify(settings), error ?? null, id);
  const scenarios = settings.scenarios?.length
    ? settings.scenarios
    : (settings.scenarioIds.length
        ? (db.prepare(`SELECT text FROM trainer_scenarios WHERE id IN (${settings.scenarioIds.map(() => '?').join(',')}) ORDER BY created_at`).all(...settings.scenarioIds) as { text: string }[])
        : (db.prepare('SELECT text FROM trainer_scenarios ORDER BY created_at').all() as { text: string }[])
      ).map((s) => s.text);
  if (!scenarios.length) scenarios.push(...EVAL_SCENARIOS);
  const variants: (ModelRef | undefined)[] = settings.models.length ? [...settings.models, ...(settings.includeCurrent ? [undefined] : [])] : [undefined];
  try {
    for (const m of variants) {
      const key = modelKey(m);
      const s = (stats[key] = emptyStats());
      for (let gi = 0; gi < settings.games && !stopped.has(id); gi++) {
        const ctx: SimContext = {
          simId: id,
          source: kind,
          modelKey: key,
          models: m ? { '*': m } : undefined,
          // The same seed per game number for every model: they get the same dice.
          rng: seeded(seedOf(`${kind === 'eval' ? 'eval' : id}:${gi}`)),
          onEvent: (canvas, ev) => relay(stream, key, canvas, ev, s),
        };
        await simStore.run(ctx, () => playGame(id, hostId, scenarios[gi % scenarios.length], gi, settings, s, stream, key, () => save()));
        save();
      }
    }
    save(stopped.has(id) ? 'stopped' : 'done');
    live(stream, 'done', stopped.has(id) ? 'Stopped' : 'Finished');
  } catch (err) {
    save('error', (err as Error).message);
    live(stream, 'done', `Failed: ${(err as Error).message}`);
    throw err;
  } finally {
    stopped.delete(id);
  }
  return stats;
}

const lastToken = new Map<string, number>();
/** DM tokens and thinking to "Watch the AI", and the tokens/s counter. */
function relay(stream: string, key: string, canvas: string, ev: RunEvent, s: ModelStats) {
  if (ev.type !== 'token' && ev.type !== 'thinking') return;
  const thinking = ev.type === 'thinking' || !!ev.thinking;
  live(stream, thinking ? 'dm-thinking' : 'dm-token', ev.text, { model: key, canvas, node: ev.label });
  if (thinking) return;
  const now = Date.now();
  const prev = lastToken.get(stream);
  s.tokens++;
  if (prev && now - prev < 5000) s.tokenMs += now - prev;
  lastToken.set(stream, now);
}

function createGame(hostId: string, scenario: string, gi: number, settings: SimSettings): string {
  const id = newId();
  const personas = [0, 1, 2].map((k) => PERSONAS[(gi + k) % PERSONAS.length]);
  const s = { ...DEFAULT_SETTINGS, endLevel: 5, rerolls: 0, sceneImages: false, approvalXp: 1_000_000, approvalGold: 1_000_000, pitch: { title: clip(scenario.split(/[.!?]/)[0] || 'Simulation', 80), hook: scenario } };
  tx(() => {
    db.prepare("INSERT INTO games (id, host_id, name, ruleset, visibility, settings, state, sim) VALUES (?, ?, ?, 'srd51', 'private', ?, ?, 1)").run(id, hostId, `Sim: ${s.pitch.title}`, JSON.stringify(s), JSON.stringify(freshState(0)));
    db.prepare("INSERT INTO game_members (game_id, user_id, role, status) VALUES (?, ?, 'host', 'joined')").run(id, hostId);
    personas.forEach((p, i) => {
      const c: GameCharacter = { ...buildCharacter(rules('srd51'), BUILDS[p], { id: newId(), ownerId: hostId }), userId: hostId, seated: true, absent: false, persona: p } as GameCharacter;
      db.prepare('INSERT INTO game_characters (id, game_id, user_id, data, position) VALUES (?, ?, ?, ?, ?)').run(c.id, id, hostId, JSON.stringify(c), i);
    });
  });
  settings.gameIds = [...(settings.gameIds ?? []), id];
  return id;
}

async function playGame(simId: string, hostId: string, scenario: string, gi: number, settings: SimSettings, s: ModelStats, stream: string, key: string, onTurn: () => void) {
  const gameId = createGame(hostId, scenario, gi, settings);
  s.games++;
  live(stream, 'game', `Game ${gi + 1} (${key}): ${clip(scenario, 160)}`, { gameId, model: key });
  await startGame(loadGame(gameId)!);
  await settled(gameId);
  let errorsInRow = 0;
  let turnStart = Date.now();
  let lastTurn = 0;
  for (let guard = 0; guard < settings.turns * 12 && !stopped.has(simId); guard++) {
    const g = loadGame(gameId)!;
    if (g.state.turn > lastTurn) {
      // A turn was told: score it, then go on.
      for (let t = lastTurn; t < g.state.turn; t++) await scoreTurn(gameId, t, settings, s, stream, key);
      s.turnMs += Date.now() - turnStart;
      turnStart = Date.now();
      lastTurn = g.state.turn;
      errorsInRow = 0;
      live(stream, 'counters', undefined, scoreboard(key, s));
      onTurn();
      if (lastTurn >= settings.turns) break;
    }
    if (g.state.phase === 'collect') {
      const chars = activeCharacters(gameCharacters(gameId)).filter((c) => !g.state.actions[c.id]);
      if (!chars.length) break;
      const scene = readLog(gameId, { limit: 20, kinds: ['narration'] }).at(-1)?.text ?? scenario;
      for (const c of chars) {
        const text = await playerAction(g.ruleset, c, scene, g.state.choices[c.id] ?? []);
        live(stream, 'player', `${c.name} (${(c as GameCharacter & { persona?: string }).persona}): ${text}`, { model: key });
        submitAction(loadGame(gameId)!, hostId, { characterId: c.id, text }, true);
      }
    } else if (g.state.phase === 'rolling') {
      const pending = g.state.rolls.filter((r) => !r.result);
      let done = false;
      for (const r of pending) done = !!playerRoll(loadGame(gameId)!, r.id, hostId, true).done || done;
      if (done) resolveLater(gameId);
    } else if (g.state.phase === 'approval') {
      // Simulated hosts keep the server's numbers.
      g.state.approvals = [];
      g.state.phase = 'collect';
      saveGame(g);
    } else if (g.state.phase === 'error') {
      if (/json/i.test(g.state.error ?? '')) {
        s.jsonTotal++;
        s.errors.json++;
      }
      live(stream, 'bookkeeper', `The DM failed: ${g.state.error}`, { model: key });
      if (++errorsInRow > 2) break;
      retry(g);
    } else if (g.status !== 'playing') break;
    await settled(gameId);
  }
  const g = loadGame(gameId);
  if (g) {
    g.status = 'ended';
    g.state.phase = 'ended';
    saveGame(g);
  }
}

async function playerAction(ruleset: string, c: GameCharacter & { persona?: string }, scene: string, choices: string[]): Promise<string> {
  try {
    const r = await runCanvas('dnd-player', 'What do you do?', {
      vars: {
        ruleset,
        persona: c.persona ?? 'reckless fighter',
        character: JSON.stringify({ name: c.name, class: c.class, level: c.level, hp: c.hp, maxHp: c.maxHp, counters: c.counters, inventory: c.inventory.map((i) => i.name), spells: c.spells, cantrips: c.cantrips }),
        scene: clip(scene, 4000),
        choices: choices.join('\n') || '(none)',
      },
    });
    return clip(outputText(r, 'action'), 600);
  } catch {
    return choices[0] ?? 'I look around carefully.';
  }
}

/** Scores one told turn: JSON validity, the Bookkeeper's notes and (when flagged or sampled) the judge. */
async function scoreTurn(gameId: string, turn: number, settings: SimSettings, s: ModelStats, stream: string, key: string) {
  const rows = db.prepare("SELECT * FROM lab_records WHERE game_id = ? AND turn = ? AND canvas != 'dnd-chronicle'").all(gameId, turn) as Record<string, any>[];
  s.turns++;
  for (const r of rows.filter((r) => JSON_NODES.includes(r.node))) {
    s.jsonTotal++;
    if (validJson(r.output ?? '')) s.jsonOk++;
    else s.errors.json++;
  }
  const signals = turnSignals(gameId, turn);
  for (const sig of signals) s.errors[noteKind(sig)]++;
  if (signals.length) live(stream, 'bookkeeper', signals.join('\n'), { model: key, turn });
  else live(stream, 'bookkeeper', 'Bookkeeper: OK', { model: key, turn });
  const narration = rows.find((r) => r.canvas === 'dnd-narrate' && r.node === 'narration');
  const state = rows.find((r) => r.canvas === 'dnd-narrate' && r.node === 'state');
  if (!narration || (!signals.length && Math.random() >= settings.judgeSample)) return;
  const vars = json<Record<string, string>>(narration.vars, {});
  try {
    const verdictRun = await runCanvas('dnd-judge', 'Judge this turn.', {
      vars: { ruleset: vars.ruleset ?? 'srd51', party: vars.party ?? '', actions: vars.actions ?? narration.question, results: vars.results ?? '[]', notes: signals.join('\n') || '(none)', narration: narration.output ?? '', state: state?.output ?? '(missing)' },
      onEvent: (ev) => (ev.type === 'token' || ev.type === 'thinking') && live(stream, ev.type === 'thinking' || ev.thinking ? 'judge-thinking' : 'judge-token', ev.text, { model: key }),
    });
    const v = outputJson<{ errors?: { type: string; detail: string }[]; story?: number; corrected?: { narration?: string; state?: unknown } | null }>(verdictRun, 'verdict');
    const errors = Array.isArray(v.errors) ? v.errors.filter((e) => e && typeof e.type === 'string').slice(0, 30) : [];
    s.judged++;
    for (const e of errors) {
      const k = e.type === 'roll' ? 'rules' : e.type === 'number' || e.type === 'resource' || e.type === 'contradiction' || e.type === 'json' ? e.type : 'rules';
      s.errors[k]++;
    }
    if (typeof v.story === 'number') {
      s.storySum += Math.max(1, Math.min(10, v.story));
      s.storyN++;
    }
    const judge = JSON.stringify({ errors, story: v.story, corrected: v.corrected ?? null });
    const label = errors.length || signals.length ? 'bad' : 'good';
    const corrected = (r: Record<string, any> | undefined) =>
      r?.node === 'narration' ? (typeof v.corrected?.narration === 'string' ? v.corrected.narration : null) : v.corrected?.state !== undefined ? JSON.stringify(v.corrected.state) : null;
    for (const r of [narration, state].filter(Boolean)) db.prepare('UPDATE lab_records SET judge = ?, label = ?, corrected = ? WHERE id = ?').run(judge, label, corrected(r), r!.id);
    live(stream, 'judge', errors.length ? errors.map((e) => `${e.type}: ${e.detail}`).join('\n') : 'No errors', { model: key, story: v.story, corrected: v.corrected ?? null, turn });
  } catch (err) {
    live(stream, 'judge', `The judge failed: ${(err as Error).message}`, { model: key });
  }
}

/** Every model's scoreboard over all finished sim runs (the DM model picker needs ≥90% JSON over ≥20 turns). */
export function allSimStats(): Record<string, ModelStats> {
  const out: Record<string, ModelStats> = {};
  for (const r of db.prepare("SELECT results FROM trainer_sims WHERE status != 'running'").all() as { results: string }[]) {
    for (const [k, v] of Object.entries(json<Record<string, ModelStats>>(r.results, {}))) {
      const o = (out[k] ??= emptyStats());
      o.turns += v.turns;
      o.jsonOk += v.jsonOk;
      o.jsonTotal += v.jsonTotal;
    }
  }
  return out;
}
