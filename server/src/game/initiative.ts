import type { CombatState, GameCharacter, InitiativeEntry, Npc, RulesData } from '@dungeonmind/shared';
import { derive } from './character.js';
import { rollD20 } from './dice.js';
import { sameName } from './text.js';

/**
 * Rolls initiative for the party and the enemies: d20 + DEX (the PC's derived initiative). Highest first;
 * ties go to the higher bonus, then player characters before NPCs, then by name (stable).
 */
export function rollInitiative(rules: RulesData, chars: GameCharacter[], npcs: Npc[], enemies: string[] = [], d20: (bonus: number) => number = (b) => rollD20(b).natural): CombatState {
  const order: InitiativeEntry[] = [];
  for (const c of chars.filter((x) => x.seated && !x.conditions.some((k) => k.name === 'dead'))) {
    const bonus = derive(rules, c).initiative;
    const roll = d20(bonus);
    order.push({ name: c.name, characterId: c.id, roll, bonus, total: roll + bonus });
  }
  const foes = npcs.filter((n) => n.status !== 'dead' && n.status !== 'fled' && (n.status === 'hostile' || enemies.some((e) => sameName(e, n.name))));
  for (const e of enemies) if (!foes.some((f) => sameName(f.name, e)) && !chars.some((c) => sameName(c.name, e))) foes.push({ name: e, status: 'hostile' });
  for (const n of foes) {
    const bonus = n.dex ?? 0;
    const roll = d20(bonus);
    order.push({ name: n.name, roll, bonus, total: roll + bonus });
  }
  return { round: 1, turn: 0, order: sortInitiative(order) };
}

export function sortInitiative(order: InitiativeEntry[]): InitiativeEntry[] {
  return [...order].sort((a, b) => b.total - a.total || b.bonus - a.bonus || Number(!!b.characterId) - Number(!!a.characterId) || a.name.localeCompare(b.name));
}

/** Dead or fled NPCs leave the order; returns true when no hostile is left (combat ends). */
export function pruneCombat(combat: CombatState, chars: GameCharacter[], npcs: Npc[]): boolean {
  combat.order = combat.order.filter((o) => {
    if (o.characterId) return chars.some((c) => c.id === o.characterId && !c.conditions.some((k) => k.name === 'dead'));
    const n = npcs.find((x) => sameName(x.name, o.name));
    return !n || (n.status !== 'dead' && n.status !== 'fled' && (n.hp === undefined || n.hp > 0));
  });
  return !combat.order.some((o) => !o.characterId);
}

/** A new round: back to the top of the order. */
export function nextRound(combat: CombatState): CombatState {
  return { ...combat, round: combat.round + 1, turn: 0 };
}
