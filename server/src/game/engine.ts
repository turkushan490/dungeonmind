import type { GameCharacter, PendingRoll } from '@dungeonmind/shared';
import { tx } from '../db.js';
import { outputJson } from '../hivemind.js';
import { rules } from '../rules/index.js';
import { applyDamage, applyDeltas, applyHeal, applySpend, applyXp, checkResources, damageNpc, deathSave, healNpc, levelCheck, rechargeTurn, tickConditions } from './bookkeeper.js';
import { derive } from './character.js';
import { rollInitiative, nextRound, pruneCombat } from './initiative.js';
import { addLog } from './log.js';
import { campaignFor, partyJson, recentTurns } from './prompt.js';
import { buildRolls, ready, resolveRoll, rollEffects, type Adjudication } from './rolls.js';
import { broadcast, gameCharacters, loadGame, saveGame, saveGameCharacter, type GameRow } from './store.js';
import { clip, sameName } from './text.js';
import { actionsText, addTurnHooks, dm, orderedActions, playersOf, setPhase, type StateJson } from './turn.js';
import { cleanZones } from './zones.js';

/** Rolls the server makes itself: NPCs, and characters whose player is away. Returns true if anything moved. */
export function autoResolve(g: GameRow, chars: GameCharacter[]): boolean {
  let moved = false;
  for (let pass = 0; pass < 40; pass++) {
    const r = g.state.rolls.find((x) => ready(x, g.state.rolls) && (x.auto || chars.find((c) => c.id === x.characterId)?.absent));
    if (!r) break;
    resolveRoll(r, g.state.rolls);
    logRoll(g, r);
    moved = true;
  }
  // Children skipped by a parent's result get logged too.
  return moved;
}

export function logRoll(g: GameRow, r: PendingRoll) {
  addLog(g.id, g.state.turn, 'roll', r.result!.text, r.actor, { rollId: r.id, kind: r.kind, dice: r.result!.dice, total: r.result!.total, manual: r.result!.manual, success: r.result!.success, crit: r.result!.crit });
}

export const pendingRolls = (g: GameRow) => g.state.rolls.filter((r) => !r.result);

/** Rolls of downed characters: a death saving throw each turn. */
function deathRolls(chars: GameCharacter[], start: number): PendingRoll[] {
  return chars
    .filter((c) => c.seated && c.hp <= 0 && !c.conditions.some((x) => x.name === 'dead' || x.name === 'stable'))
    .map((c, i) => ({ id: `d${start + i}`, actor: c.name, characterId: c.id, kind: 'death' as const, label: `${c.name} death saving throw`, dice: '1d20', adv: 'none' as const, bonus: 0, dc: 10 }));
}

/** M6 step 2-3: adjudicate, check and spend resources, set up the rolls. False = the turn waits (refusal or rolls). */
async function beforeNarrate(g: GameRow): Promise<boolean> {
  if (g.state.adjudicated) {
    if (!pendingRolls(g).length) return true;
    setPhase(g, 'rolling');
    return false;
  }
  setPhase(g, 'adjudicating');
  const chars = gameCharacters(g.id);
  const out = await dm(g, 'dnd-adjudicate', actionsText(g, chars), {
    tableId: g.id,
    ruleset: g.ruleset,
    campaign: campaignFor(g, chars),
    party: partyJson(g.ruleset, chars, g.state, playersOf(g.id)),
    recent: recentTurns(g.id, 6000, 4),
    actions: actionsText(g, chars),
    combat: g.state.combat ? JSON.stringify(g.state.combat) : 'null',
  });
  const adj = outputJson<Adjudication>(out, 'rolls');
  const fresh = loadGame(g.id)!;
  Object.assign(g, fresh);
  const check = checkResources(chars, adj.resources ?? []);
  const refused = [
    ...(Array.isArray(adj.refused) ? adj.refused : [])
      .map((r) => ({ characterId: chars.find((c) => sameName(c.name, r?.pc))?.id ?? '', reason: clip(String(r?.reason ?? 'Not possible right now.'), 200) }))
      .filter((r) => r.characterId && g.state.actions[r.characterId]),
    ...check.refused,
  ];
  if (refused.length) {
    // Nothing is spent; the refused players pick again, the others keep their action.
    for (const r of refused) {
      delete g.state.actions[r.characterId];
      addLog(g.id, g.state.turn, 'refused', r.reason, chars.find((c) => c.id === r.characterId)?.name);
    }
    g.state.refused = refused.filter((r, i, a) => a.findIndex((x) => x.characterId === r.characterId) === i);
    setPhase(g, 'collect');
    return false;
  }
  tx(() => {
    // The declared actions go into the story first, then the dice.
    for (const a of orderedActions(g, chars)) addLog(g.id, g.state.turn, 'action', a.text, chars.find((c) => c.id === a.characterId)?.name);
    const spent = applySpend(chars, check.spend);
    for (const c of chars) saveGameCharacter(g.id, c);
    g.state.spent = check.spend;
    const r = rules(g.ruleset);
    g.state.rolls = [...buildRolls(r, chars, g.state.npcs, adj), ...deathRolls(chars, 1)];
    g.state.adjudicated = true;
    if (spent.length) addLog(g.id, g.state.turn, 'change', spent.join(' · '));
    autoResolve(g, chars);
    g.state.phase = pendingRolls(g).length ? 'rolling' : 'narrating';
    saveGame(g);
  });
  broadcast(g);
  return !pendingRolls(g).length;
}

/** M6 step 6: the Bookkeeper applies the turn to every character, inside the turn's transaction. */
function applyState(g: GameRow, chars: GameCharacter[], state: StateJson) {
  const r = rules(g.ruleset);
  const changes: string[] = [];
  const notes: string[] = [];
  // 1. Dice effects: the server's numbers.
  const { pcs, foes } = rollEffects(g.state.rolls, chars, g.state.npcs);
  const backed = new Map<string, number>();
  for (const [id, e] of pcs) {
    const c = chars.find((x) => x.id === id)!;
    if (e.damage) changes.push(...applyDamage(c, e.damage, { crit: e.crit, ruleset: g.ruleset, conBonus: derive(r, c).saveBonus.con }));
    if (e.heal) changes.push(...applyHeal(c, e.heal));
    backed.set(id, e.heal - e.damage);
  }
  for (const [name, e] of foes) {
    const n = g.state.npcs.find((x) => x.name === name)!;
    if (e.damage) changes.push(damageNpc(n, e.damage));
    if (e.heal) changes.push(healNpc(n, e.heal));
  }
  for (const roll of g.state.rolls.filter((x) => x.kind === 'death' && x.result?.natural)) {
    const c = chars.find((x) => x.id === roll.characterId);
    if (c) changes.push(deathSave(c, roll.result!.natural!));
  }
  // 2. The AI's other proposed changes, clamped.
  const d = applyDeltas(chars, state.deltas ?? [], { backed, settings: g.settings });
  const x = applyXp(chars, state.xp ?? [], g.settings);
  changes.push(...d.changes, ...x.changes);
  notes.push(...d.notes, ...x.notes);
  g.state.approvals.push(...d.approvals, ...x.approvals);
  // 3. Combat and the zone board.
  const known = [...chars.map((c) => c.name), ...g.state.npcs.map((n) => n.name)];
  if (state.combat?.start && !g.state.combat) {
    g.state.combat = rollInitiative(r, chars, g.state.npcs, Array.isArray(state.combat.enemies) ? state.combat.enemies.map(String) : []);
    addLog(g.id, g.state.turn, 'roll', `Initiative: ${g.state.combat.order.map((o) => `${o.name} ${o.total}`).join(', ')}`, undefined, { initiative: g.state.combat.order });
  } else if (g.state.combat) {
    const over = pruneCombat(g.state.combat, chars, g.state.npcs);
    if (state.combat?.end || over) {
      g.state.combat = undefined;
      changes.push('The fight is over.');
    } else g.state.combat = nextRound(g.state.combat);
  }
  if (Array.isArray(state.zones) && state.zones.length) {
    const z = cleanZones(state.zones, state.positions, known);
    g.state.zones = z.zones;
    g.state.positions = z.positions;
  } else if (state.positions) g.state.positions = cleanZones(g.state.zones, state.positions, known).positions;
  // 4. Time passes: durations tick, per-turn features recharge, XP checked against the level table.
  changes.push(...tickConditions(chars));
  rechargeTurn(chars);
  for (const line of levelCheck(chars, g.settings.endLevel)) addLog(g.id, g.state.turn, 'levelup', line);
  if (changes.length) addLog(g.id, g.state.turn, 'change', changes.join(' · '));
  for (const n of notes) addLog(g.id, g.state.turn, 'note', n, 'Bookkeeper');
}

let registered = false;
export function registerEngine() {
  if (registered) return;
  registered = true;
  addTurnHooks({ beforeNarrate, applyState });
}

/** A player rolls (server or "I roll myself"); when the last roll is in, the DM narrates. */
export function playerRoll(g: GameRow, rollId: string, userId: string, isHost: boolean, manual?: number[]): { error?: string; done?: boolean } {
  if (g.state.phase !== 'rolling') return { error: 'No rolls are waiting' };
  const r = g.state.rolls.find((x) => x.id === rollId);
  if (!r) return { error: 'No such roll' };
  if (r.result) return { error: 'Already rolled' };
  if (!ready(r, g.state.rolls)) return { error: 'That roll waits for another one first' };
  const chars = gameCharacters(g.id);
  const c = chars.find((x) => x.id === r.characterId);
  if (!c || (c.userId !== userId && !isHost)) return { error: "That's not your roll" };
  try {
    resolveRoll(r, g.state.rolls, manual);
  } catch (err) {
    return { error: (err as Error).message };
  }
  logRoll(g, r);
  autoResolve(g, chars);
  const done = !pendingRolls(g).length;
  if (done) g.state.phase = 'narrating';
  saveGame(g);
  broadcast(g);
  return { done };
}
