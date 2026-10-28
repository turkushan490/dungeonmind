import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeHiveMind, type FakeCall, type FakeRun } from './fake-hivemind.js';
import { CANVASES, freshApp, setupGame } from './helpers.js';

let app: FastifyInstance;
const hm = new FakeHiveMind();
let turn: typeof import('../src/game/turn.js');

export const narrateAnswer = (c: FakeCall, extra: Record<string, unknown> = {}) => {
  const party = JSON.parse(c.vars.party).characters.map((x: any) => x.name);
  return {
    stream: { label: 'narration', text: `The marsh breathes. (${c.vars.mode})` },
    outputs: {
      narration: `The marsh breathes. (${c.vars.mode})`,
      state: JSON.stringify({
        choices: Object.fromEntries(party.map((n: string) => [n, [`${n} looks around`, `${n} listens`, `${n} waits`, `${n} prays`]])),
        npcs: [{ name: 'The Bell-Hag', hp: 30, maxHp: 30, ac: 13, status: 'hostile' }],
        speakers: [{ name: 'narrator', kind: 'narrator' }],
        summary: 'Things happened.',
        sceneEnd: false,
        ...extra,
      }),
    },
  };
};

beforeAll(async () => {
  await hm.start();
  app = await freshApp({ HIVEMIND_URL: hm.url, HIVEMIND_TOKEN: hm.token });
  turn = await import('../src/game/turn.js');
  for (const id of CANVASES) hm.canvases.set(id, { id, nodes: [] });
});
afterAll(async () => {
  await app?.close();
  await hm.stop();
});

let failNarrate = 0;
beforeEach(() => {
  failNarrate = 0;
  hm.onRun = (c): FakeRun => {
    if (c.canvasId === 'dnd-narrate') {
      if (failNarrate > 0) {
        failNarrate--;
        return { error: 'Invalid JSON after repair' };
      }
      return narrateAnswer(c);
    }
    if (c.canvasId === 'dnd-chronicle') return { outputs: { patches: JSON.stringify({ patches: [{ section: 'Timeline', op: 'append', text: `- Turn: ${c.question.slice(0, 20)}` }, { section: 'Party status', op: 'replace', text: 'HACKED' }] }) } };
    if (c.canvasId === 'dnd-ask') return { outputs: { answer: 'Grappling uses Athletics.' } };
    if (c.canvasId === 'dnd-adjudicate') return { outputs: { rolls: JSON.stringify({ rolls: [], resources: [], refused: [] }) } };
    return { outputs: {} };
  };
});

describe('the game loop', () => {
  let t: Awaited<ReturnType<typeof setupGame>>;
  const game = async () => (await t.as(t.host, 'GET', `/api/games/${t.id}`)).json();

  it('refuses to start without a compatible HiveMind', async () => {
    t = await setupGame(app);
    const before = hm.features;
    hm.features = ['vars'];
    const r = await t.as(t.host, 'POST', `/api/games/${t.id}/start`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/jsonMode/);
    hm.features = before;
  });

  it('starts: writes campaign.md, narrates the opening, offers choices', async () => {
    expect((await t.as(t.pl, 'POST', `/api/games/${t.id}/start`)).statusCode).toBe(403);
    expect((await t.as(t.host, 'POST', `/api/games/${t.id}/start`)).statusCode).toBe(200);
    await turn.settled(t.id);
    const g = await game();
    expect(g.status).toBe('playing');
    expect(g.state.phase).toBe('collect');
    expect(g.state.turn).toBe(1);
    expect(g.state.choices[t.hostChar]).toEqual(['Turks looks around', 'Turks listens', 'Turks waits', 'Turks prays']);
    expect(hm.callsOf('dnd-narrate')[0].vars.mode).toBe('opening');
    const camp = (await t.as(t.pl, 'GET', `/api/games/${t.id}/campaign`)).json();
    expect(camp.md).toContain('## 1. How to run');
    expect(camp.md).toContain('Drowned Bells');
    expect(camp.md).toContain('| Turks |');
    // The Chronicler appended to the timeline, and could not touch the party table.
    expect(camp.md).toContain('- Turn:');
    expect(camp.md).not.toContain('HACKED');
  });

  it('waits for every seated player before the DM acts', async () => {
    const r1 = await t.as(t.host, 'POST', `/api/games/${t.id}/actions`, { characterId: t.hostChar, choice: 1 });
    expect(r1.json()).toEqual({});
    expect((await game()).state.phase).toBe('collect');
    // Not your character, not on the list, too long.
    expect((await t.as(t.host, 'POST', `/api/games/${t.id}/actions`, { characterId: t.plChar, text: 'x' })).statusCode).toBe(400);
    expect((await t.as(t.pl, 'POST', `/api/games/${t.id}/actions`, { characterId: t.plChar, choice: 7 })).statusCode).toBe(400);
    expect((await t.as(t.pl, 'POST', `/api/games/${t.id}/actions`, { characterId: t.plChar, text: 'x'.repeat(700) })).statusCode).toBe(400);
    const n = hm.callsOf('dnd-narrate').length;
    const r2 = await t.as(t.pl, 'POST', `/api/games/${t.id}/actions`, { characterId: t.plChar, text: 'I sing to the bells' });
    expect(r2.json().resolving).toBe(true);
    await turn.settled(t.id);
    const call = hm.callsOf('dnd-narrate')[n];
    expect(call.vars.actions).toContain('Turks (');
    expect(call.vars.actions).toContain(': Turks listens');
    expect(call.vars.actions).toContain('I sing to the bells');
    expect(call.vars.recent).toContain('The marsh breathes. (opening)');
    expect(JSON.parse(call.vars.party).characters[0]).toMatchObject({ name: 'Turks', hp: 12, ac: 18 });
    const g = await game();
    expect(g.state).toMatchObject({ phase: 'collect', turn: 2, actions: {} });
    const log = (await t.as(t.pl, 'GET', `/api/games/${t.id}/log`)).json();
    expect(log.filter((e: any) => e.kind === 'action').map((e: any) => e.text)).toEqual(['Turks listens', 'I sing to the bells']);
    expect(log.filter((e: any) => e.kind === 'narration')).toHaveLength(2);
  });

  it('retries a failed DM call automatically, without using a reroll', async () => {
    failNarrate = 1;
    await t.as(t.host, 'POST', `/api/games/${t.id}/actions`, { characterId: t.hostChar, choice: 0 });
    await t.as(t.pl, 'POST', `/api/games/${t.id}/actions`, { characterId: t.plChar, choice: 0 });
    await turn.settled(t.id);
    const g = await game();
    expect(g.state).toMatchObject({ phase: 'collect', turn: 3, rerollsLeft: 2 });
    const log = (await t.as(t.pl, 'GET', `/api/games/${t.id}/log`)).json();
    expect(log.some((e: any) => /stumbled/.test(e.text))).toBe(true);
  }, 30_000);

  it('keeps the turn when every retry fails, and continues on Retry', async () => {
    failNarrate = 3;
    await t.as(t.host, 'POST', `/api/games/${t.id}/actions`, { characterId: t.hostChar, choice: 2 });
    await t.as(t.pl, 'POST', `/api/games/${t.id}/actions`, { characterId: t.plChar, text: 'I hold my breath' });
    await turn.settled(t.id);
    let g = await game();
    expect(g.state.phase).toBe('error');
    expect(g.state.error).toMatch(/Invalid JSON/);
    expect(Object.keys(g.state.actions)).toHaveLength(2);
    expect(g.state.turn).toBe(3);
    expect((await t.as(t.pl, 'POST', `/api/games/${t.id}/retry`)).statusCode).toBe(200);
    await turn.settled(t.id);
    g = await game();
    expect(g.state).toMatchObject({ phase: 'collect', turn: 4 });
    const last = hm.callsOf('dnd-narrate').at(-1)!;
    expect(last.vars.actions).toContain('I hold my breath');
  }, 30_000);

  it('answers Ask the DM without moving the story', async () => {
    const before = (await game()).state;
    await t.as(t.pl, 'POST', `/api/games/${t.id}/ask`, { question: 'How does grappling work?' });
    await new Promise((r) => setTimeout(r, 300));
    const log = (await t.as(t.pl, 'GET', `/api/games/${t.id}/log`)).json();
    expect(log.at(-1)).toMatchObject({ kind: 'answer', text: 'Grappling uses Athletics.' });
    expect((await game()).state.turn).toBe(before.turn);
  });

  it('skips an absent player so the others can go on', async () => {
    await t.as(t.host, 'POST', `/api/games/${t.id}/actions`, { characterId: t.hostChar, choice: 0 });
    const r = await t.as(t.host, 'PATCH', `/api/games/${t.id}/characters/${t.plChar}/seat`, { absent: true });
    expect(r.statusCode).toBe(200);
    await turn.settled(t.id);
    const g = await game();
    expect(g.state.turn).toBe(5);
    expect(g.state.choices[t.plChar]).toBeUndefined();
    await t.as(t.host, 'PATCH', `/api/games/${t.id}/characters/${t.plChar}/seat`, { absent: false });
  });

  it('pauses and resumes', async () => {
    await t.as(t.host, 'POST', `/api/games/${t.id}/status`, { status: 'paused' });
    expect((await t.as(t.host, 'POST', `/api/games/${t.id}/actions`, { characterId: t.hostChar, choice: 0 })).json().error).toMatch(/paused/);
    await t.as(t.host, 'POST', `/api/games/${t.id}/status`, { status: 'playing' });
    expect((await game()).status).toBe('playing');
  });

  it('a turn interrupted by a restart waits for Retry', async () => {
    const { db } = await import('../src/db.js');
    const row = db.prepare('SELECT state FROM games WHERE id = ?').get(t.id) as { state: string };
    db.prepare('UPDATE games SET state = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.state), phase: 'narrating' }), t.id);
    turn.recoverInterrupted();
    expect((await game()).state).toMatchObject({ phase: 'error', error: expect.stringMatching(/restarted/) });
  });

  it('exports the save file with campaign and story', async () => {
    const r = await t.as(t.pl, 'GET', `/api/games/${t.id}/export.md`);
    expect(r.headers['content-type']).toMatch(/markdown/);
    expect(r.body).toContain('# Test Tale');
    expect(r.body).toContain('The marsh breathes.');
    expect(r.body).toContain('**Turks:**');
  });

  it('lets the host edit campaign.md and keeps every version', async () => {
    const before = (await t.as(t.host, 'GET', `/api/games/${t.id}/campaign`)).json();
    const md = before.md.replace('## 9. Rulings made\n_(nothing yet)_', '## 9. Rulings made\nFlanking gives advantage.');
    expect((await t.as(t.pl, 'PUT', `/api/games/${t.id}/campaign`, { md })).statusCode).toBe(403);
    await t.as(t.host, 'PUT', `/api/games/${t.id}/campaign`, { md });
    const after = (await t.as(t.pl, 'GET', `/api/games/${t.id}/campaign`)).json();
    expect(after.md).toContain('Flanking gives advantage.');
    expect(after.versions.length).toBe(before.versions.length + 1);
    expect(after.versions[0].author).toBe('host');
  });
});
