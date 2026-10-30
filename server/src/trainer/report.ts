import { newId } from '../crypto.js';
import { db, json } from '../db.js';
import { clip } from '../game/text.js';
import { canvasFiles, outputText, runCanvas } from '../hivemind.js';
import { live } from './live.js';
import { toRecord, turnSignals } from './records.js';
import { scoreboard, type ModelStats } from './sim.js';

/**
 * M9 §3 Report: "Make improvement report" over the selected runs plus the bad records from real games. The
 * dnd-report canvas writes Markdown; it streams to "Watch the AI" and is kept in a history list.
 */
const PROMPT_CANVASES = ['dnd-adjudicate', 'dnd-narrate', 'dnd-chronicle'];

/** What the report canvas gets: the scoreboard, the errors with real example turns, and the current prompts. */
export function reportVars(simIds: string[]): { scoreboard: string; errors: string; prompts: string } {
  const sims = simIds.length ? (db.prepare(`SELECT id, created_at, results FROM trainer_sims WHERE id IN (${simIds.map(() => '?').join(',')})`).all(...simIds) as Record<string, any>[]) : [];
  const board = sims.flatMap((s) => Object.entries(json<Record<string, ModelStats>>(s.results, {})).map(([k, v]) => ({ run: s.id, at: s.created_at, ...scoreboard(k, v) })));

  const bad = [
    ...(simIds.length ? (db.prepare(`SELECT r.*, g.ruleset FROM lab_records r JOIN games g ON g.id = r.game_id WHERE r.sim_id IN (${simIds.map(() => '?').join(',')}) AND r.label = 'bad' ORDER BY r.id DESC LIMIT 60`).all(...simIds) as Record<string, any>[]) : []),
    ...(db.prepare("SELECT r.*, g.ruleset FROM lab_records r JOIN games g ON g.id = r.game_id WHERE r.source = 'game' AND r.label = 'bad' ORDER BY r.id DESC LIMIT 60").all() as Record<string, any>[]),
  ];
  const counts = new Map<string, number>();
  const examples = bad.map((r) => {
    const rec = toRecord(r, r.ruleset);
    const problems = [...(rec.judge?.errors ?? []).map((e) => `${e.type}: ${e.detail}`), ...rec.signals, ...turnSignals(rec.gameId, rec.turn)];
    for (const p of problems) {
      const k = p.split(':')[0].replace(/\(.*\)/, '').trim();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return { source: rec.source, canvas: rec.canvas, node: rec.node, turn: rec.turn, model: rec.model, problems: [...new Set(problems)].slice(0, 6), asked: clip(r.question ?? '', 400), answered: clip(rec.output, 800) };
  });
  const prompts = canvasFiles()
    .filter((c) => PROMPT_CANVASES.includes(c.id))
    .flatMap((c) => c.nodes.filter((n) => n.type === 'llm').map((n) => `### ${c.id} / ${n.label}\nsystem:\n${clip(String(n.config.system ?? ''), 4000)}\n\nprompt:\n${clip(String(n.config.prompt ?? ''), 1500)}`))
    .join('\n\n');
  return {
    scoreboard: JSON.stringify(board, null, 1),
    errors: JSON.stringify({ counts: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])), examples: examples.slice(0, 40) }, null, 1),
    prompts,
  };
}

/** Starts a report in the background; the Markdown streams to `report:<id>` and is saved as it grows. */
export function startReport(simIds: string[], title?: string): { id: string; done: Promise<void> } {
  const id = newId();
  db.prepare("INSERT INTO trainer_reports (id, title, status, sim_ids) VALUES (?, ?, 'running', ?)").run(id, title ?? `Improvement report (${simIds.length} run${simIds.length === 1 ? '' : 's'} + real games)`, JSON.stringify(simIds));
  const stream = `report:${id}`;
  const done = (async () => {
    let md = '';
    let saved = 0;
    try {
      const r = await runCanvas('dnd-report', 'Write the improvement report.', {
        vars: reportVars(simIds),
        onEvent: (ev) => {
          if (ev.type !== 'token' && ev.type !== 'thinking') return;
          const thinking = ev.type === 'thinking' || !!ev.thinking;
          live(stream, thinking ? 'report-thinking' : 'report-token', ev.text);
          if (thinking || !ev.text) return;
          md += ev.text;
          if (md.length - saved > 400) {
            db.prepare('UPDATE trainer_reports SET md = ? WHERE id = ?').run(md, id);
            saved = md.length;
          }
        },
      });
      md = outputText(r, 'report');
      db.prepare("UPDATE trainer_reports SET md = ?, status = 'done' WHERE id = ?").run(md, id);
      live(stream, 'done', 'Report ready');
    } catch (err) {
      db.prepare("UPDATE trainer_reports SET md = ?, status = 'error', error = ? WHERE id = ?").run(md, (err as Error).message, id);
      live(stream, 'done', `Failed: ${(err as Error).message}`);
    }
  })();
  return { id, done };
}
