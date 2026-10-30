import { newId } from '../crypto.js';
import { db, json } from '../db.js';
import { hasFeature, runInputs, type ChatMessage, type RunResult } from '../hivemind.js';
import { parseSections } from '../game/campaign.js';
import type { GameRow } from '../game/store.js';
import { clip } from '../game/text.js';
import { simContext } from './context.js';

/**
 * M9 §1-2: every HiveMind call of a game is kept in lab_records, one row per LLM block: the exact messages it sent
 * (HiveMind `nodeInputs`, else question + vars) and what it answered. Labels: good / bad / pending, and after
 * review accepted / rejected.
 */
export type Label = 'good' | 'bad' | 'pending' | 'accepted' | 'rejected';
export type Source = 'game' | 'sim' | 'eval';

export interface LabRecord {
  id: number;
  gameId: string;
  turn: number;
  canvas: string;
  node?: string;
  messages: ChatMessage[];
  output: string;
  label: Label;
  source: Source;
  corrected?: string;
  signals: string[];
  judge?: { errors: { type: string; detail: string }[]; story?: number; corrected?: unknown };
  simId?: string;
  model?: string;
  pushedAt?: string;
  at: string;
}

/** The question and the vars as one user message: what the DM was asked when HiveMind can't say the exact input. */
export function fallbackMessages(canvas: string, ruleset: string, node: string | undefined, question: string, vars: Record<string, string>): ChatMessage[] {
  return [
    { role: 'system', content: `DungeonMind canvas ${canvas} (${ruleset})${node ? `, block "${node}"` : ''}. Mode: ${vars.mode ?? '-'}.` },
    { role: 'user', content: `${question}\n\n${Object.entries(vars).filter(([k]) => k !== 'tableId').map(([k, v]) => `## ${k}\n${v}`).join('\n\n')}` },
  ];
}

export function toRecord(r: Record<string, any>, ruleset = 'srd51'): LabRecord {
  const outputs = json<Record<string, string>>(r.outputs, {});
  const output = r.output ?? Object.entries(outputs).map(([k, v]) => (Object.keys(outputs).length > 1 ? `## ${k}\n${v}` : v)).join('\n\n');
  return {
    id: r.id,
    gameId: r.game_id,
    turn: r.turn,
    canvas: r.canvas,
    node: r.node ?? undefined,
    messages: json<ChatMessage[] | null>(r.messages, null) ?? fallbackMessages(r.canvas, ruleset, r.node ?? undefined, r.question, json(r.vars, {})),
    output,
    label: r.label,
    source: r.source,
    corrected: r.corrected ?? undefined,
    signals: json<string[]>(r.signals, []),
    judge: json(r.judge, undefined),
    simId: r.sim_id ?? undefined,
    model: r.model ?? undefined,
    pushedAt: r.pushed_at ?? undefined,
    at: r.at,
  };
}

/** One chat example (system/user/assistant) for the HiveMind dataset: the input, and the correction when there is one. */
export function toExample(rec: LabRecord): { messages: ChatMessage[] } {
  const input = rec.messages.filter((m) => m.role !== 'assistant');
  return { messages: [...input, { role: 'assistant', content: rec.corrected ?? rec.output }] };
}

/** Records a finished HiveMind call. Never throws: recording must not break a game. */
export async function recordCall(g: GameRow, canvas: string, question: string, vars: Record<string, string>, result: RunResult, turn = g.state.turn): Promise<number[]> {
  if (g.settings.tutorial || g.settings.noTraining) return [];
  try {
    const ctx = simContext();
    let inputs: Record<string, ChatMessage[]> = {};
    if (await hasFeature('nodeInputs').catch(() => false)) inputs = await runInputs(result).catch(() => ({}));
    const ids: number[] = [];
    for (const [node, o] of Object.entries(result.outputs)) {
      if (o.type && o.type !== 'llm') continue;
      const messages = inputs[node]?.length ? inputs[node] : fallbackMessages(canvas, g.ruleset, node, question, vars);
      const row = db
        .prepare('INSERT INTO lab_records (game_id, turn, canvas, node, question, vars, outputs, messages, output, source, sim_id, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
        .get(g.id, turn, canvas, node, question, JSON.stringify(vars), JSON.stringify({ [node]: o.text }), JSON.stringify(messages), o.text, ctx?.source ?? 'game', ctx?.simId ?? null, ctx?.modelKey ?? null) as { id: number };
      ids.push(row.id);
    }
    return ids;
  } catch (err) {
    console.warn('lab record failed:', (err as Error).message);
    return [];
  }
}

/** What went wrong in a turn: Bookkeeper refusals and notes, and 👎 votes on its narration. */
export function turnSignals(gameId: string, turn: number): string[] {
  const notes = (db.prepare("SELECT kind, actor, text FROM game_log WHERE game_id = ? AND turn = ? AND hidden = 0 AND kind IN ('note', 'refused')").all(gameId, turn) as Record<string, string>[]).map(
    (n) => (n.kind === 'refused' ? `Refused${n.actor ? ` (${n.actor})` : ''}: ${n.text}` : `Bookkeeper: ${n.text}`),
  );
  const down = (db.prepare("SELECT COUNT(*) AS n FROM narration_votes v JOIN game_log l ON l.id = v.log_id WHERE l.game_id = ? AND l.turn = ? AND l.hidden = 0 AND v.up = 0").get(gameId, turn) as { n: number }).n;
  return [...notes, ...(down ? [`👎 from ${down} player${down === 1 ? '' : 's'}`] : [])];
}

/**
 * Labels a turn's records. Bad: a Bookkeeper refusal or note, a passed reroll, or a 👎. Good: none of that, once
 * the turn is final (the next turn was told, so no reroll can come any more). Reviewed and judged records keep theirs.
 */
export function labelTurn(gameId: string, turn: number, final: boolean) {
  const rows = db.prepare("SELECT id, signals, source FROM lab_records WHERE game_id = ? AND turn = ? AND label IN ('pending', 'good', 'bad') AND judge IS NULL").all(gameId, turn) as Record<string, any>[];
  if (!rows.length) return;
  const signals = turnSignals(gameId, turn);
  let bad = false;
  for (const r of rows) {
    const label: Label = signals.length || json<string[]>(r.signals, []).length ? 'bad' : final ? 'good' : 'pending';
    db.prepare('UPDATE lab_records SET label = ? WHERE id = ?').run(label, r.id);
    if (label === 'bad' && r.source === 'game') bad = true;
  }
  if (bad) addOutcomeScenario(gameId, turn);
}

/** A passed reroll: the narration of that turn was bad. */
export function markRerolled(gameId: string, turn: number) {
  for (const r of db.prepare("SELECT id, signals FROM lab_records WHERE game_id = ? AND turn = ? AND canvas = 'dnd-narrate' AND label IN ('pending', 'good', 'bad')").all(gameId, turn) as Record<string, any>[]) {
    const signals = [...json<string[]>(r.signals, []), 'A reroll vote passed'];
    db.prepare("UPDATE lab_records SET signals = ?, label = 'bad' WHERE id = ?").run(JSON.stringify(signals), r.id);
  }
  if (db.prepare("SELECT 1 FROM lab_records WHERE game_id = ? AND turn = ? AND source = 'game'").get(gameId, turn)) addOutcomeScenario(gameId, turn);
}

/** The situation just before a turn: the "Current scene" of the campaign file as it was then. */
export function situationBefore(gameId: string, turn: number): string | undefined {
  const v = db.prepare('SELECT md FROM campaign_versions WHERE game_id = ? AND turn <= ? ORDER BY id DESC LIMIT 1').get(gameId, turn) as { md: string } | undefined;
  if (!v) return;
  return clip(parseSections(v.md)['Current scene'] || v.md, 2000);
}

/** "From outcomes": the situation before each turn labelled bad becomes a scenario, once. */
export function addOutcomeScenario(gameId: string, turn: number) {
  const text = situationBefore(gameId, turn);
  if (!text?.trim()) return;
  db.prepare("INSERT OR IGNORE INTO trainer_scenarios (id, text, source, game_id, turn) VALUES (?, ?, 'outcome', ?, ?)").run(newId(), text, gameId, turn);
}
