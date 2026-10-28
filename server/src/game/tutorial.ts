import type { GameCharacter } from '@dungeonmind/shared';
import type { RunResult } from '../hivemind.js';
import type { GameRow } from './store.js';

/**
 * The tutorial's DM: a short scripted adventure that needs no HiveMind. It still goes through the real
 * turn engine, so every step (choices, checks, "I roll myself", initiative, the Bookkeeper, XP, level-up)
 * is the real thing.
 */
const out = (outputs: Record<string, unknown>): RunResult => ({
  runId: 'tutorial',
  outputs: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, { nodeId: k, type: 'llm', text: typeof v === 'string' ? v : JSON.stringify(v) }])),
});

const party = (vars: Record<string, string>): { name: string; hp: number }[] => {
  try {
    return JSON.parse(vars.party).characters;
  } catch {
    return [];
  }
};

const choicesFor = (names: string[], list: string[]) => Object.fromEntries(names.map((n) => [n, list]));

export function tutorialRun(g: GameRow, canvasId: string, question: string, vars: Record<string, string>, chars: GameCharacter[]): RunResult {
  const names = party(vars).map((c) => c.name);
  const first = names[0] ?? 'You';
  const wolf = g.state.npcs.find((n) => n.name === 'Starving Wolf');
  const inFight = !!g.state.combat;
  const stage = !g.state.npcs.length ? 'arrive' : inFight ? 'fight' : wolf?.status === 'dead' || (wolf?.hp ?? 1) <= 0 ? 'after' : 'approach';

  switch (canvasId) {
    case 'dnd-adjudicate': {
      if (stage === 'arrive' || stage === 'approach') {
        return out({
          rolls: {
            rolls: names.map((n, i) => ({ id: `p${i}`, actor: n, kind: 'check', skill: 'perception', dc: 10, reason: 'Something moves in the dark mill.' })),
            resources: [],
          },
        });
      }
      if (stage === 'fight') {
        return out({
          rolls: {
            rolls: [
              ...names.flatMap((n, i) => [
                { id: `a${i}`, actor: n, kind: 'attack', target: 'Starving Wolf', reason: 'Strike the wolf' },
                { id: `d${i}`, actor: n, kind: 'damage', target: 'Starving Wolf', dice: '1d8', onHit: `a${i}` },
              ]),
              ...(wolf && (wolf.hp ?? 0) > 0 ? [{ id: 'w1', actor: 'Starving Wolf', kind: 'attack', target: first, bonus: 4 }, { id: 'w2', actor: 'Starving Wolf', kind: 'damage', target: first, dice: '2d4+2', onHit: 'w1' }] : []),
            ],
            resources: [],
          },
        });
      }
      return out({ rolls: { rolls: [], resources: [] } });
    }
    case 'dnd-narrate': {
      if (vars.mode === 'opening')
        return out({
          narration: `Welcome to DungeonMind. This is a short tutorial with a scripted Dungeon Master, so you can learn the table without an AI.\n\nRain hammers the roof of the old mill at the edge of Hollowmere. The door hangs open. Inside, something scratches at the floorboards.\n\nPick one of the four choices below, or write your own action under "Other". The DM always waits until every player has chosen.`,
          state: {
            choices: choicesFor(names, ['Step inside, weapon ready', 'Listen at the door', 'Call out into the dark', 'Light a torch first']),
            zones: [{ name: 'Doorway', distances: { 'Mill floor': 20 } }, { name: 'Mill floor', distances: {} }],
            positions: { Doorway: names },
            npcs: [{ name: 'Old Miller (missing)', status: 'neutral' }],
            speakers: [{ name: 'narrator', kind: 'narrator' }],
            image: null,
            sceneEnd: false,
            summary: 'The party arrives at the mill.',
          },
        });
      if (stage === 'arrive' || stage === 'approach')
        return out({
          narration: `Your eyes adjust. Those were Perception checks: the server rolled a d20 and added your bonus from the sheet (or you rolled your own die with "I roll myself"). The results are in the story log.\n\nFrom behind the millstone a starving wolf slinks out, ribs showing, teeth bared. It growls, low and hungry.\n\nA fight! The server just rolled initiative: the order is shown on the Board. Choose how to fight.`,
          state: {
            npcs: [{ name: 'Starving Wolf', hp: 11, maxHp: 11, ac: 13, dex: 2, status: 'hostile' }],
            combat: { start: true, enemies: ['Starving Wolf'] },
            zones: [{ name: 'Doorway', distances: { 'Mill floor': 20 } }, { name: 'Mill floor', distances: {} }],
            positions: { 'Mill floor': ['Starving Wolf', ...names] },
            choices: choicesFor(names, ['Attack the wolf', 'Attack the wolf with everything', 'Strike, then step back', 'Shout and swing']),
            speakers: [{ name: 'narrator', kind: 'narrator' }],
            sceneEnd: false,
            summary: 'A starving wolf attacks.',
          },
        });
      if (stage === 'fight') {
        const dealt = g.state.rolls.filter((r) => r.kind === 'damage' && r.target === 'Starving Wolf' && r.result && !r.result.skipped).reduce((s, r) => s + r.result!.total, 0);
        const down = (wolf?.hp ?? 11) - dealt <= 0;
        return out({
          narration: `Steel and teeth in the dark. Every number you see was rolled and applied by the server: attacks against the wolf's Armor Class, damage only after a hit, and the wolf's bite against you. Your hit points on the sheet changed by exactly the dice.\n\n${down ? 'The wolf yelps once and lies still.' : 'The wolf circles, bleeding but not beaten.'} Look at the Board for HP and positions.`,
          state: {
            combat: down ? { end: true } : null,
            xp: down ? [{ pc: 'all', amount: 300, reason: 'surviving the mill (tutorial)' }] : [],
            npcs: [{ name: 'Starving Wolf', status: down ? 'dead' : 'hostile' }],
            choices: choicesFor(names, down ? ['Search the mill', 'Tend your wounds', 'Look for the miller', 'Rest a while'] : ['Attack the wolf', 'Attack again', 'Press the attack', 'Finish it']),
            speakers: [{ name: 'narrator', kind: 'narrator' }],
            sceneEnd: down,
            summary: down ? 'The wolf is dead.' : 'The fight goes on.',
          },
        });
      }
      return out({
        narration: `The mill falls quiet. You earned 300 XP: that's enough for level 2, so a level-up button appeared on your sheet. Open it to pick fixed or rolled hit points.\n\nThe host can now give the party a short or long rest (Board → Short rest / Long rest) to recover hit points and used resources.\n\nThat's the tutorial. Start a real adventure from the lobby: the AI Dungeon Master takes it from there.`,
        state: {
          choices: choicesFor(names, ['Look around once more', 'Head back to the lobby', 'Rest', 'Search the millstone']),
          speakers: [{ name: 'narrator', kind: 'narrator' }],
          sceneEnd: true,
          summary: 'Tutorial complete.',
        },
      });
    }
    case 'dnd-chronicle':
      return out({ patches: { patches: [{ section: 'Timeline', op: 'append', text: `- Turn ${g.state.turn}: ${question.split('\n')[0].slice(0, 80)}` }] } });
    case 'dnd-ask':
      return out({ answer: 'In the tutorial the DM is scripted. In a real game this answers rules questions and what your character knows, without moving the story. The Guide tab explains everything.' });
  }
  void chars;
  return out({});
}
