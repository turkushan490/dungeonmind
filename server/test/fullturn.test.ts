import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeHiveMind, type FakeCall, type FakeRun } from './fake-hivemind.js';
import { CANVASES, freshApp, setupGame } from './helpers.js';

let app: FastifyInstance;
const hm = new FakeHiveMind();
let turn: typeof import('../src/game/turn.js');
let t: Awaited<ReturnType<typeof setupGame>>;
let combat: 'start' | 'end' | null = 'start';

function narrate(c: FakeCall): FakeRun {
  const party = JSON.parse(c.vars.party).characters.map((x: any) => x.name);
  return {
    outputs: {
      narration: `Narration ${c.vars.mode} turn. Results: ${c.vars.results.length}`,
      state: JSON.stringify({
        deltas: [{ pc: 'Esva', hp: -99, addItems: ['Bell Shard'] }],
        xp: c.vars.mode === 'turn' ? [{ pc: 'all', amount: 300, reason: 'drove off the hag' }] : [],
        npcs: [{ name: 'The Bell-Hag', hp: 30, maxHp: 30, ac: 15, dex: 2, status: 'hostile' }],
        combat: combat === 'start' ? { start: true, enemies: ['The Bell-Hag'] } : combat === 'end' ? { end: true } : null,
        zones: [{ name: 'Belfry', distances: { 'Flooded nave': 40 } }, { name: 'Flooded nave', distances: {} }],
        positions: { Belfry: ['The Bell-Hag'], 'Flooded nave': party },
        choices: Object.fromEntries(party.map((n: string) => [n, ['Attack', 'Defend', 'Pray', 'Flee']])),
        speakers: [{ name: 'narrator', kind: 'narrator' }],
        summary: 'Fight.',
        sceneEnd: false,
      }),
    },
  };
}

beforeAll(async () => {
  await hm.start();
  app = await freshApp({ HIVEMIND_URL: hm.url, HIVEMIND_TOKEN: hm.token });
  turn = await import('../src/game/turn.js');
  for (const id of CANVASES) hm.canvases.set(id, { id, nodes: [] });
  hm.onRun = (c) => {
    if (c.canvasId === 'dnd-narrate') return narrate(c);
    if (c.canvasId === 'dnd-chronicle') return { outputs: { patches: '{"patches":[]}' } };
    if (c.canvasId === 'dnd-adjudicate') {
      if (c.vars.actions.includes('Channel Divinity')) return { outputs: { rolls: JSON.stringify({ rolls: [], resources: [{ pc: 'Esva', name: 'Channel Divinity', amount: 1 }] }) } };
      return {
        outputs: {
          rolls: JSON.stringify({
            rolls: [
              { id: 'a1', actor: 'Turks', kind: 'attack', target: 'The Bell-Hag', targetAc: 15, weapon: 'Longsword', reason: 'swing' },
              { id: 'a2', actor: 'Turks', kind: 'damage', target: 'The Bell-Hag', dice: '1d8+3', onHit: 'a1', weapon: 'Longsword' },
              { id: 'h1', actor: 'The Bell-Hag', kind: 'attack', target: 'Esva', bonus: 5, targetAc: 18 },
              { id: 'h2', actor: 'The Bell-Hag', kind: 'damage', target: 'Esva', dice: '2d6+3', onHit: 'h1' },
            ],
            resources: [{ pc: 'Esva', name: '1st level spell slot', amount: 1 }],
          }),
        },
      };
    }
    return { outputs: {} };
  };
  t = await setupGame(app, { rerolls: 2, endLevel: 3 });
});
afterAll(async () => {
  await app?.close();
  await hm.stop();
});

const game = async () => (await t.as(t.host, 'GET', `/api/games/${t.id}`)).json();
const esva = async () => (await game()).characters.find((c: any) => c.name === 'Esva');

describe('the full turn loop', () => {
  it('opening starts combat: initiative, zones, NPCs', async () => {
    await t.as(t.host, 'POST', `/api/games/${t.id}/start`);
    await turn.settled(t.id);
    const g = await game();
    expect(g.state.combat.order.map((o: any) => o.name).sort()).toEqual(['Esva', 'The Bell-Hag', 'Turks']);
    expect(g.state.zones.map((z: any) => z.name)).toEqual(['Belfry', 'Flooded nave']);
    expect(g.state.positions['Flooded nave']).toEqual(['Turks', 'Esva']);
    // No dice backed the -99: the host decides.
    expect(g.state.approvals[0]).toMatchObject({ kind: 'delta', amount: -99, name: 'Esva' });
    expect(g.state.phase).toBe('approval');
    await t.as(t.host, 'POST', `/api/games/${t.id}/approvals/${g.state.approvals[0].id}`, { approve: false });
    expect((await game()).state.phase).toBe('collect');
    expect((await esva()).hp).toBe((await esva()).maxHp);
    combat = null;
  });

  it('refuses an action whose resource is used up; nothing is spent, the player picks again', async () => {
    const e = await esva();
    await t.as(t.host, 'PATCH', `/api/games/${t.id}/characters/${t.plChar}/override`, { counters: { 'Channel Divinity': 0 } });
    expect((await t.as(t.pl, 'PATCH', `/api/games/${t.id}/characters/${t.plChar}/override`, { hp: 1 })).statusCode).toBe(403);
    await t.as(t.host, 'POST', `/api/games/${t.id}/actions`, { characterId: t.hostChar, choice: 0 });
    await t.as(t.pl, 'POST', `/api/games/${t.id}/actions`, { characterId: t.plChar, text: 'I use Channel Divinity to turn the hag' });
    await turn.settled(t.id);
    const g = await game();
    expect(g.state.phase).toBe('collect');
    // A level 1 cleric has no Channel Divinity yet (it comes at level 2).
    expect(g.state.refused).toEqual([{ characterId: t.plChar, reason: 'Esva has no Channel Divinity.' }]);
    expect(g.state.actions[t.hostChar]).toBeDefined();
    expect(g.state.actions[t.plChar]).toBeUndefined();
    expect((await esva()).counters.find((k: any) => k.name === 'Spell slot L1').current).toBe(e.counters.find((k: any) => k.name === 'Spell slot L1').current);
  });

  it('spends resources, rolls NPC dice itself, and waits for the players’ rolls', async () => {
    await t.as(t.pl, 'POST', `/api/games/${t.id}/actions`, { characterId: t.plChar, text: 'I cast Guiding Bolt' });
    await turn.settled(t.id);
    const g = await game();
    expect(g.state.phase).toBe('rolling');
    expect((await esva()).counters.find((k: any) => k.name === 'Spell slot L1').current).toBe(1);
    const hagAttack = g.state.rolls.find((r: any) => r.actor === 'The Bell-Hag' && r.kind === 'attack');
    expect(hagAttack.result).toBeDefined();
    expect(hagAttack.targetAc).toBe(18); // Esva's real AC (chain mail + shield)
    const mine = g.state.rolls.find((r: any) => r.actor === 'Turks' && r.kind === 'attack');
    expect(mine.result).toBeUndefined();
    expect(mine.bonus).toBe(5);
  });

  it('“I roll myself” is checked; then the damage roll unlocks', async () => {
    const g = await game();
    const atk = g.state.rolls.find((r: any) => r.actor === 'Turks' && r.kind === 'attack');
    const dmg = g.state.rolls.find((r: any) => r.actor === 'Turks' && r.kind === 'damage');
    expect((await t.as(t.pl, 'POST', `/api/games/${t.id}/rolls/${atk.id}`, { mode: 'server' })).json().error).toMatch(/not your roll/);
    expect((await t.as(t.host, 'POST', `/api/games/${t.id}/rolls/${dmg.id}`, { mode: 'server' })).json().error).toMatch(/waits for another/);
    expect((await t.as(t.host, 'POST', `/api/games/${t.id}/rolls/${atk.id}`, { mode: 'manual', values: [25] })).json().error).toMatch(/d20 shows 1-20/);
    expect((await t.as(t.host, 'POST', `/api/games/${t.id}/rolls/${atk.id}`, { mode: 'manual', values: [15] })).statusCode).toBe(200);
    const log = (await t.as(t.pl, 'GET', `/api/games/${t.id}/log`)).json();
    expect(log.filter((e: any) => e.kind === 'roll').at(-1).text).toMatch(/d20 15 \+ 5 = 20 vs AC 15 — hit \(rolled by the player\)/);
    const r = await t.as(t.host, 'POST', `/api/games/${t.id}/rolls/${dmg.id}`, { mode: 'server' });
    expect(r.json().done).toBe(true);
    await turn.settled(t.id);
  });

  it('the Bookkeeper applies the dice, not the AI’s numbers', async () => {
    const g = await game();
    expect(['collect', 'approval']).toContain(g.state.phase);
    const log = (await t.as(t.pl, 'GET', `/api/games/${t.id}/log`)).json();
    const rolls = log.filter((e: any) => e.kind === 'roll');
    const turksDmg = rolls.find((e: any) => e.actor === 'Turks' && e.data.kind === 'damage').data.total;
    const hagHit = rolls.find((e: any) => e.actor === 'The Bell-Hag' && e.data.kind === 'attack').data.success;
    const hagDmgEntry = rolls.find((e: any) => e.actor === 'The Bell-Hag' && e.data.kind === 'damage');
    const hag = g.state.npcs.find((n: any) => n.name === 'The Bell-Hag');
    expect(hag.hp).toBe(30 - turksDmg); // the AI kept saying 30
    const e = g.characters.find((c: any) => c.name === 'Esva');
    if (hagHit) {
      expect(e.hp).toBe(Math.max(0, e.maxHp - hagDmgEntry.data.total));
      expect(log.some((x: any) => x.kind === 'note' && /the DM wrote -99, the dice say/.test(x.text))).toBe(true);
    } else expect(g.state.approvals[0]?.amount ?? -99).toBe(-99);
    expect(e.inventory.some((i: any) => i.name === 'Bell Shard')).toBe(true);
    // narration got the real results
    expect(hm.callsOf('dnd-narrate').at(-1)!.vars.results).toContain('vs AC 15 — hit');
    // round 2 of the fight
    expect(g.state.combat.round).toBe(2);
    for (const a of g.state.approvals) await t.as(t.host, 'POST', `/api/games/${t.id}/approvals/${a.id}`, { approve: false });
  });

  it('XP crosses the threshold: banner, then the level-up step', async () => {
    const g = await game();
    const turks = g.characters.find((c: any) => c.name === 'Turks');
    expect(turks.xp).toBe(300);
    expect(turks.levelUpPending).toBe(true);
    const log = (await t.as(t.pl, 'GET', `/api/games/${t.id}/log`)).json();
    expect(log.some((e: any) => e.kind === 'levelup' && /Turks reached level 2/.test(e.text))).toBe(true);
    expect((await t.as(t.pl, 'POST', `/api/games/${t.id}/characters/${t.hostChar}/level-up`, { hp: 'fixed' })).statusCode).toBe(404);
    expect((await t.as(t.host, 'POST', `/api/games/${t.id}/characters/${t.hostChar}/level-up`, { hp: 11 })).json().error).toMatch(/d10 shows 1-10/);
    const up = (await t.as(t.host, 'POST', `/api/games/${t.id}/characters/${t.hostChar}/level-up`, { hp: 'fixed' })).json();
    expect(up).toMatchObject({ level: 2, maxHp: turks.maxHp + 6 + Math.floor((turks.abilities.con - 10) / 2) });
    expect(up.levelUpPending).toBeUndefined();
    expect(up.counters.find((k: any) => k.name === 'Action Surge')).toMatchObject({ max: 1 });
  });

  it('a reroll needs the majority and keeps the dice', async () => {
    const before = await game();
    const n = hm.callsOf('dnd-narrate').length;
    const results = hm.callsOf('dnd-narrate').at(-1)!.vars.results;
    const r = (await t.as(t.host, 'POST', `/api/games/${t.id}/reroll`)).json();
    expect(r).toEqual({ ok: true }); // 1 of 2 votes: still open
    expect((await game()).state.rerollVote.by).toBeDefined();
    expect((await t.as(t.pl, 'POST', `/api/games/${t.id}/reroll/vote`, { yes: true })).json()).toEqual({ result: 'pass' });
    await turn.settled(t.id);
    const after = await game();
    expect(hm.callsOf('dnd-narrate').length).toBe(n + 1);
    expect(hm.callsOf('dnd-narrate').at(-1)!.vars.results).toBe(results);
    expect(after.state.rerollsLeft).toBe(before.state.rerollsLeft - 1);
    expect(after.state.turn).toBe(before.state.turn);
    // Only one narration of that turn is visible.
    const log = (await t.as(t.pl, 'GET', `/api/games/${t.id}/log`)).json();
    expect(log.filter((e: any) => e.kind === 'narration' && e.turn === before.state.turn - 1)).toHaveLength(1);
  });

  it('a vote can fail', async () => {
    await t.as(t.pl, 'POST', `/api/games/${t.id}/reroll`);
    expect((await t.as(t.host, 'POST', `/api/games/${t.id}/reroll/vote`, { yes: false })).json()).toEqual({ result: 'fail' });
    expect((await game()).state.rerollVote).toBeUndefined();
  });

  it('no resting mid-fight; a long rest after it restores everything', async () => {
    for (const a of (await game()).state.approvals) await t.as(t.host, 'POST', `/api/games/${t.id}/approvals/${a.id}`, { approve: false });
    expect((await t.as(t.host, 'POST', `/api/games/${t.id}/rest`, { kind: 'long' })).json().error).toMatch(/fight/);
    combat = 'end';
    hm.onRun = ((orig) => (c: FakeCall) => (c.canvasId === 'dnd-adjudicate' ? { outputs: { rolls: '{"rolls":[],"resources":[]}' } } : orig(c)))(hm.onRun);
    await t.as(t.host, 'POST', `/api/games/${t.id}/actions`, { characterId: t.hostChar, choice: 1 });
    await t.as(t.pl, 'POST', `/api/games/${t.id}/actions`, { characterId: t.plChar, choice: 1 });
    await turn.settled(t.id);
    // If the hag's dice dropped Esva to 0 HP, the turn waits for her death saving throw: roll it.
    for (const r of (await game()).state.rolls.filter((x: any) => !x.result)) await t.as(t.pl, 'POST', `/api/games/${t.id}/rolls/${r.id}`, { mode: 'server' });
    await turn.settled(t.id);
    let g = await game();
    expect(g.state.combat).toBeUndefined();
    for (const a of g.state.approvals) await t.as(t.host, 'POST', `/api/games/${t.id}/approvals/${a.id}`, { approve: false });
    expect((await t.as(t.host, 'POST', `/api/games/${t.id}/rest`, { kind: 'long' })).statusCode).toBe(200);
    g = await game();
    const e = g.characters.find((c: any) => c.name === 'Esva');
    // A long rest heals the living; a character still at 0 HP (unstable) doesn't recover by resting.
    if (!e.conditions.some((x: any) => x.name === 'unconscious' || x.name === 'dead')) expect(e.hp).toBe(e.maxHp);
    // The dead don't rest; everyone else gets their slots back.
    if (!e.conditions.some((x: any) => x.name === 'dead')) expect(e.counters.find((k: any) => k.name === 'Spell slot L1').current).toBe(2);
    const turks = g.characters.find((c: any) => c.name === 'Turks');
    expect(turks.hp).toBe(turks.maxHp);
    expect(e.counters.find((k: any) => k.name === 'Channel Divinity')).toBeUndefined(); // level 1 cleric: none yet
  });
});
