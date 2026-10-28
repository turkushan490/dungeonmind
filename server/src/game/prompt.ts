import type { GameCharacter, GameState, Ruleset } from '@dungeonmind/shared';
import { rules } from '../rules/index.js';
import { derive, itemByName } from './character.js';
import { currentCampaign, withParty } from './campaign.js';
import { readLog } from './log.js';
import type { GameRow } from './store.js';
import { clip, titleCase } from './text.js';

/** Last turns verbatim, newest last, within a character budget. */
export function recentTurns(gameId: string, budget = 12_000, maxTurns = 12): string {
  const entries = readLog(gameId, { limit: 400, kinds: ['narration', 'action', 'roll', 'change', 'refused', 'levelup', 'system'] });
  const turns = [...new Set(entries.map((e) => e.turn))].slice(-maxTurns);
  const out: string[] = [];
  let used = 0;
  for (const t of [...turns].reverse()) {
    const block = entries
      .filter((e) => e.turn === t)
      .map((e) => (e.kind === 'narration' ? `DM: ${e.text}` : e.kind === 'action' ? `${e.actor}: ${e.text}` : `[${e.text}]`))
      .join('\n');
    if (used + block.length > budget && out.length) break;
    out.unshift(`### Turn ${t}\n${clip(block, budget)}`);
    used += block.length;
  }
  return out.join('\n\n') || '(no turns yet)';
}

/** The party as the AI sees it: authoritative numbers, compact. */
export function partyJson(ruleset: Ruleset, chars: GameCharacter[], state: GameState, players: Record<string, string> = {}): string {
  const r = rules(ruleset);
  return JSON.stringify({
    characters: chars.map((c) => {
      const d = derive(r, c);
      return {
        name: c.name,
        player: players[c.userId],
        species: titleCase(c.subspecies ?? c.species),
        class: `${titleCase(c.class)}${c.subclass ? ` (${titleCase(c.subclass)})` : ''}`,
        level: c.level,
        hp: c.hp,
        maxHp: c.maxHp,
        tempHp: c.tempHp || undefined,
        ac: d.ac,
        speed: d.speed,
        abilityMods: d.mods,
        spellSaveDc: d.spellDc,
        spellAttack: d.spellAttack,
        counters: c.counters.map((k) => `${k.name} ${k.current}/${k.max}`),
        conditions: c.conditions.map((x) => (x.rounds !== undefined ? `${x.name} (${x.rounds} rounds)` : x.name)),
        concentration: c.concentration,
        cantrips: c.cantrips?.map(titleCase),
        spells: c.spells?.map(titleCase),
        weapons: c.inventory.filter((i) => i.equipped && itemByName(r, i.name)?.damage).map((i) => i.name),
        inventory: c.inventory.map((i) => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name)),
        gold: c.gold,
        xp: c.xp,
        status: c.absent ? 'away (stays quietly with the group, takes no actions)' : c.seated ? 'playing' : 'sitting out',
      };
    }),
    npcs: state.npcs.filter((n) => n.status !== 'dead' && n.status !== 'fled'),
    zones: state.zones,
    positions: state.positions,
  });
}

export function campaignFor(g: GameRow, chars: GameCharacter[]): string {
  return withParty(currentCampaign(g.id), chars, g.state.npcs);
}
