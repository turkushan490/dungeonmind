import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeHiveMind, M9_FEATURES, type FakeCall, type FakeRun } from './fake-hivemind.js';
import { CANVASES, freshApp, register, registerAdmin, settle, setupGame } from './helpers.js';

let app: FastifyInstance;
const hm = new FakeHiveMind();
const BASE_FEATURES = [...hm.features];
let admin: string;
let player: string;
let turn: typeof import('../src/game/turn.js');
let db: typeof import('../src/db.js')['db'];
const TRAINER_CANVASES = ['dnd-player', 'dnd-judge', 'dnd-scenarios', 'dnd-report'];

/** Models that "cheat" HP (the Bookkeeper holds it back and the judge flags it). */
const BAD = /bad/;
let cheatAll = false;

function narrate(c: FakeCall): FakeRun {
  const party: string[] = JSON.parse(c.vars.party).characters.map((x: any) => x.name);
  const cheat = cheatAll || BAD.test(c.models?.['*']?.model ?? '');
  return {
    stream: { label: 'narration', text: 'The fog lifts.' },
    outputs: {
      narration: 'The fog lifts.',
      state: JSON.stringify({
        deltas: cheat ? [{ pc: party[0], hp: -3 }] : [],
        choices: Object.fromEntries(party.map((n) => [n, ['Attack', 'Defend', 'Pray', 'Flee']])),
        summary: 'Fog.',
      }),
    },
  };
}

const as = (cookie: string, method: string, url: string, payload?: unknown) => app.inject({ method: method as 'GET', url, headers: { cookie }, payload: payload as object });
const refreshFeatures = (f: string[]) => {
  hm.features = f;
  return as(admin, 'GET', '/api/hivemind/health');
};
const until = async (fn: () => boolean | Promise<boolean>, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const records = (where: string, ...args: unknown[]) => db.prepare(`SELECT * FROM lab_records WHERE ${where} ORDER BY id`).all(...(args as string[])) as Record<string, any>[];

beforeAll(async () => {
  await hm.start();
  app = await freshApp({ HIVEMIND_URL: hm.url, HIVEMIND_TOKEN: hm.token });
  turn = await import('../src/game/turn.js');
  db = (await import('../src/db.js')).db;
  for (const id of [...CANVASES, ...TRAINER_CANVASES]) hm.canvases.set(id, { id, nodes: [] });
  hm.onRun = (c) => {
    if (c.canvasId === 'dnd-narrate') return narrate(c);
    if (c.canvasId === 'dnd-adjudicate') return { outputs: { rolls: JSON.stringify({ rolls: [], resources: [] }) } };
    if (c.canvasId === 'dnd-chronicle') return { outputs: { patches: JSON.stringify({ patches: [{ section: 'Current scene', op: 'replace', text: `Fog on the moor (${c.vars.mode}).` }] }) } };
    if (c.canvasId === 'dnd-player') return { outputs: { action: `I ${c.vars.persona === 'healer' ? 'heal' : 'attack'} the nearest foe.` } };
    if (c.canvasId === 'dnd-judge')
      return { stream: { label: 'verdict', text: '{}' }, outputs: { verdict: JSON.stringify(c.vars.notes === '(none)' ? { errors: [], story: 8, corrected: null } : { errors: [{ type: 'number', detail: 'HP without a roll' }], story: 5, corrected: { state: { deltas: [] } } }) } };
    if (c.canvasId === 'dnd-scenarios') return { outputs: { scenarios: JSON.stringify({ scenarios: Array.from({ length: Number(c.vars.count) }, (_, i) => `Scenario ${i + 1} about ${c.question}.`) }) } };
    if (c.canvasId === 'dnd-report') return { stream: { label: 'report', text: '# DungeonMind improvement report' }, outputs: { report: '# DungeonMind improvement report\n\n## Top errors\n- HP without dice' } };
    if (c.canvasId === 'dnd-setup') return { outputs: { pitch: JSON.stringify({ pitches: [{ title: 'Fog', hook: 'Fog rolls in.' }] }) } };
    if (c.canvasId === 'dnd-ask') return { outputs: { answer: 'A d20.' } };
    return { outputs: {} };
  };
  admin = await registerAdmin(app, 'trainadmin');
  player = await register(app, 'notadmin');
});
afterAll(async () => {
  await app?.close();
  await hm.stop();
});

describe('admin-only guards', () => {
  it('refuses players and anonymous callers on every Trainer route', async () => {
    const routes: [string, string][] = [
      ['GET', '/api/trainer/status'],
      ['PUT', '/api/trainer/settings'],
      ['POST', '/api/trainer/train-now'],
      ['POST', '/api/trainer/candidate'],
      ['GET', '/api/trainer/scenarios'],
      ['POST', '/api/trainer/scenarios'],
      ['POST', '/api/trainer/sims'],
      ['GET', '/api/trainer/records'],
      ['POST', '/api/trainer/reports'],
      ['GET', '/api/trainer/dm-models'],
      ['GET', '/api/trainer/live'],
    ];
    for (const [method, url] of routes) {
      expect((await as(player, method, url, {})).statusCode, `${method} ${url}`).toBe(403);
      expect((await app.inject({ method: method as 'GET', url })).statusCode, `${method} ${url}`).toBe(401);
    }
    // A player's API token is not enough for the nightly callback either.
    const tok = (await as(player, 'POST', '/api/tokens', { name: 'x' })).json().token;
    expect((await app.inject({ method: 'POST', url: '/api/trainer/candidate', headers: { authorization: `Bearer ${tok}` }, payload: {} })).statusCode).toBe(403);
  });
});

describe('the training disclaimer gate', () => {
  it('sign-up needs it, stores it, and older accounts are asked once', async () => {
    const no = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'nodisc', password: 'Password!23', adult: true } });
    expect(no.statusCode).toBe(400);
    expect(no.json().error).toContain('Games you play here are used to train the AI Dungeon Master.');
    const cookie = await register(app, 'withdisc');
    expect((await as(cookie, 'GET', '/api/auth/me')).json().trainingAccepted).toBe(true);
    expect((db.prepare("SELECT training_at FROM users WHERE username = 'withdisc'").get() as any).training_at).toBeTruthy();

    db.prepare("UPDATE users SET training_at = NULL WHERE username = 'withdisc'").run();
    expect((await as(cookie, 'GET', '/api/auth/me')).json().trainingAccepted).toBe(false);
    expect((await as(cookie, 'POST', '/api/auth/adult', { confirm: true })).statusCode).toBe(400);
    expect((await as(cookie, 'POST', '/api/auth/adult', { confirm: true, training: true })).statusCode).toBe(200);
    expect((await as(cookie, 'GET', '/api/auth/me')).json().trainingAccepted).toBe(true);
  });
});

let t: Awaited<ReturnType<typeof setupGame>>;

/** Both players act; the host rejects any held-back change. */
async function playTurn() {
  await t.as(t.host, 'POST', `/api/games/${t.id}/actions`, { characterId: t.hostChar, choice: 0 });
  await t.as(t.pl, 'POST', `/api/games/${t.id}/actions`, { characterId: t.plChar, choice: 1 });
  await turn.settled(t.id);
  const g = (await t.as(t.host, 'GET', `/api/games/${t.id}`)).json();
  for (const a of g.state.approvals) await t.as(t.host, 'POST', `/api/games/${t.id}/approvals/${a.id}`, { approve: false });
  return g;
}

describe('collecting from every game', () => {
  it('records each DM block with the question+vars fallback, then the exact messages with nodeInputs', async () => {
    await refreshFeatures(BASE_FEATURES);
    t = await setupGame(app, { rerolls: 2 });
    await t.as(t.host, 'POST', `/api/games/${t.id}/start`);
    await turn.settled(t.id);
    const opening = records('game_id = ? AND turn = 0', t.id);
    expect(opening.map((r) => `${r.canvas}/${r.node}`)).toEqual(['dnd-narrate/narration', 'dnd-narrate/state', 'dnd-chronicle/patches']);
    expect(opening.every((r) => r.source === 'game' && r.label === 'pending')).toBe(true);
    const msgs = JSON.parse(opening[0].messages);
    expect(msgs[0].content).toContain('DungeonMind canvas dnd-narrate');
    expect(msgs[1].content).toContain('## party');
    expect(opening[0].output).toBe('The fog lifts.');

    await refreshFeatures([...BASE_FEATURES, 'nodeInputs']);
    await playTurn();
    const t1 = records("game_id = ? AND turn = 1 AND canvas = 'dnd-narrate'", t.id);
    expect(JSON.parse(t1[0].messages)[0].content).toBe('exact system prompt of dnd-narrate/narration');
    expect(records("game_id = ? AND turn = 1 AND canvas = 'dnd-adjudicate'", t.id)).toHaveLength(1);
  });

  it('labels: good once final, bad on Bookkeeper notes, a passed reroll or a 👎; bad turns become scenarios', async () => {
    // Turn 0 is final now (turn 1 was told) and had nothing wrong.
    expect(records('game_id = ? AND turn = 0', t.id).every((r) => r.label === 'good')).toBe(true);
    cheatAll = true;
    await playTurn(); // turn 2: HP without dice → Bookkeeper note
    cheatAll = false;
    expect(records("game_id = ? AND turn = 2 AND canvas = 'dnd-narrate'", t.id).every((r) => r.label === 'bad')).toBe(true);
    expect(records('game_id = ? AND turn = 1', t.id).every((r) => r.label === 'good')).toBe(true);
    const outcome = db.prepare("SELECT * FROM trainer_scenarios WHERE source = 'outcome' AND game_id = ?").all(t.id) as any[];
    expect(outcome).toHaveLength(1);
    expect(outcome[0]).toMatchObject({ turn: 2, text: 'Fog on the moor (turn).' });

    await playTurn(); // turn 3: clean
    const log = (await t.as(t.host, 'GET', `/api/games/${t.id}/log`)).json();
    const n3 = log.filter((e: any) => e.kind === 'narration' && e.turn === 3)[0];
    expect((await t.as(t.pl, 'POST', `/api/games/${t.id}/log/${n3.id}/vote`, { up: true })).json()).toMatchObject({ up: 1, down: 0 });
    // One vote per player: changing it replaces it.
    expect((await t.as(t.pl, 'POST', `/api/games/${t.id}/log/${n3.id}/vote`, { up: false })).json()).toMatchObject({ up: 0, down: 1 });
    expect((await t.as(player, 'POST', `/api/games/${t.id}/log/${n3.id}/vote`, { up: false })).statusCode).toBe(403); // a spectator
    expect((await t.as(t.host, 'GET', `/api/games/${t.id}/votes`)).json()[n3.id]).toMatchObject({ up: 0, down: 1 });
    expect(records("game_id = ? AND turn = 3 AND canvas = 'dnd-narrate'", t.id).every((r) => r.label === 'bad')).toBe(true);
    await t.as(t.pl, 'POST', `/api/games/${t.id}/log/${n3.id}/vote`, { up: null });
    expect(records("game_id = ? AND turn = 3 AND canvas = 'dnd-narrate'", t.id).every((r) => r.label === 'pending')).toBe(true);

    // A passed reroll of turn 3.
    await t.as(t.host, 'POST', `/api/games/${t.id}/reroll`);
    await t.as(t.pl, 'POST', `/api/games/${t.id}/reroll/vote`, { yes: true });
    await turn.settled(t.id);
    const rerolled = records("game_id = ? AND turn = 3 AND canvas = 'dnd-narrate'", t.id);
    expect(rerolled.slice(0, 2).every((r) => r.label === 'bad' && r.signals.includes('reroll'))).toBe(true);
    expect(rerolled.slice(2).every((r) => r.label === 'pending')).toBe(true); // the new telling
  });

  it('records the setup and Ask the DM calls too, and nothing for games that opted out', async () => {
    await t.as(t.pl, 'POST', `/api/games/${t.id}/ask`, { question: 'What do I roll?' });
    await until(() => records("game_id = ? AND canvas = 'dnd-ask'", t.id).length === 1);
    const out = await setupGame(app);
    await settle(app, out.host, await out.as(out.host, 'POST', `/api/games/${out.id}/pitches`, { wishes: 'fog' }));
    expect(records("game_id = ? AND canvas = 'dnd-setup'", out.id)).toHaveLength(1);
    await out.as(out.host, 'PUT', `/api/games/${out.id}`, { noTraining: true });
    const before = records('game_id = ?', out.id).length;
    await out.as(out.host, 'POST', `/api/games/${out.id}/start`);
    await turn.settled(out.id);
    expect(records('game_id = ?', out.id)).toHaveLength(before);
  });
});

describe('scenarios', () => {
  it('add, edit, delete, bulk add', async () => {
    const a = (await as(admin, 'POST', '/api/trainer/scenarios', { text: 'A bridge collapses.' })).json();
    expect(a).toMatchObject({ source: 'manual', text: 'A bridge collapses.' });
    expect((await as(admin, 'PUT', `/api/trainer/scenarios/${a.id}`, { text: 'A rope bridge collapses.' })).statusCode).toBe(200);
    const bulk = (await as(admin, 'POST', '/api/trainer/scenarios/bulk', { text: 'One\n\n  Two  \nThree' })).json();
    expect(bulk.map((s: any) => s.text)).toEqual(['One', 'Two', 'Three']);
    let list = (await as(admin, 'GET', '/api/trainer/scenarios')).json();
    expect(list.find((s: any) => s.id === a.id).text).toBe('A rope bridge collapses.');
    await as(admin, 'DELETE', `/api/trainer/scenarios/${a.id}`);
    list = (await as(admin, 'GET', '/api/trainer/scenarios')).json();
    expect(list.some((s: any) => s.id === a.id)).toBe(false);
    expect((await as(admin, 'POST', '/api/trainer/scenarios', { text: ' ' })).statusCode).toBe(400);
  });

  it('writes 20 with AI from a theme', async () => {
    const r = await settle(app, admin, await as(admin, 'POST', '/api/trainer/scenarios/ai', { theme: 'haunted mines' }));
    expect(r.json()).toHaveLength(20);
    expect(r.json()[0]).toMatchObject({ source: 'ai', text: 'Scenario 1 about haunted mines.' });
    expect(hm.callsOf('dnd-scenarios').at(-1)!.vars.count).toBe('20');
  });

  it('takes the current situation from a campaign', async () => {
    const games = (await as(admin, 'GET', '/api/trainer/games')).json();
    expect(games.some((g: any) => g.id === t.id)).toBe(true);
    const s = (await as(admin, 'POST', '/api/trainer/scenarios/from-game', { gameId: t.id })).json();
    expect(s).toMatchObject({ source: 'campaign', gameId: t.id, text: 'Fog on the moor (turn).' });
  });
});

let simId: string;
describe('the simulator', () => {
  it('needs modelOverride to compare models', async () => {
    await refreshFeatures(BASE_FEATURES);
    const r = await as(admin, 'POST', '/api/trainer/sims', { models: [{ providerId: 'ollama', model: 'x' }], games: 1, turns: 1 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/HiveMind needs updating/);
  });

  it('plays real engine turns with fake players, records them as sim and scores each model', async () => {
    await refreshFeatures([...BASE_FEATURES, ...M9_FEATURES]);
    await as(admin, 'PUT', '/api/trainer/settings', { judgeSample: 0 });
    const ids = (await as(admin, 'GET', '/api/trainer/scenarios')).json().map((s: any) => s.id).slice(0, 1);
    simId = (await as(admin, 'POST', '/api/trainer/sims', { models: [{ providerId: 'ollama', model: 'good-model' }, { providerId: 'ollama', model: 'bad-model' }], games: 1, turns: 3, scenarioIds: ids })).json().id;
    await until(async () => (await as(admin, 'GET', `/api/trainer/sims/${simId}`)).json().status !== 'running');
    const sim = (await as(admin, 'GET', `/api/trainer/sims/${simId}`)).json();
    expect(sim.status).toBe('done');
    const good = sim.scoreboard.find((s: any) => s.model === 'ollama/good-model');
    const bad = sim.scoreboard.find((s: any) => s.model === 'ollama/bad-model');
    expect(good).toMatchObject({ games: 1, turns: 3, jsonValid: 100, errorsPer100: 0, story: null });
    expect(bad.errorsPer100).toBeGreaterThan(0);
    expect(bad.story).toBe(5); // the judge checked every turn the Bookkeeper flagged

    const recs = records('sim_id = ?', simId);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every((r) => r.source === 'sim')).toBe(true);
    const judged = recs.filter((r) => r.judge);
    expect(judged.length).toBeGreaterThan(0);
    expect(judged.every((r) => r.model === 'ollama/bad-model' && r.label === 'bad')).toBe(true);
    expect(judged.find((r) => r.node === 'state')!.corrected).toBe('{"deltas":[]}');
    // The model under test via the run override; the players keep their own model.
    const narrations = hm.callsOf('dnd-narrate').filter((c) => c.models);
    expect(new Set(narrations.map((c) => c.models!['*'].model))).toEqual(new Set(['good-model', 'bad-model']));
    expect(hm.callsOf('dnd-player').length).toBeGreaterThanOrEqual(9);
    expect(hm.callsOf('dnd-player').every((c) => !c.models)).toBe(true);
    // Sim games stay out of the lobby.
    const lobby = (await as(admin, 'GET', '/api/games')).json();
    expect([...lobby.mine, ...lobby.spectate].some((g: any) => g.name.startsWith('Sim:'))).toBe(false);
  }, 60_000);

  it('repeats the same dice for the same seed', async () => {
    const { seeded } = await import('../src/trainer/context.js');
    const a = seeded(42);
    const b = seeded(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('every run can be deleted, with its games and records', async () => {
    const other = (await as(admin, 'POST', '/api/trainer/sims', { games: 1, turns: 1 })).json().id;
    await until(async () => (await as(admin, 'GET', `/api/trainer/sims/${other}`)).json().status !== 'running');
    expect(records('sim_id = ?', other).length).toBeGreaterThan(0);
    const gameIds = JSON.parse((db.prepare('SELECT settings FROM trainer_sims WHERE id = ?').get(other) as any).settings).gameIds;
    await as(admin, 'DELETE', `/api/trainer/sims/${other}`);
    expect(records('sim_id = ?', other)).toHaveLength(0);
    expect(db.prepare('SELECT 1 FROM games WHERE id = ?').get(gameIds[0])).toBeUndefined();
    expect((await as(admin, 'GET', `/api/trainer/sims/${other}`)).statusCode).toBe(404);
  }, 30_000);
});

describe('review', () => {
  it('accepts the judge correction, edits, rejects and deletes records', async () => {
    const bad = (await as(admin, 'GET', '/api/trainer/records?label=bad')).json();
    expect(bad.total).toBeGreaterThan(0);
    const judged = bad.records.find((r: any) => r.corrected);
    expect((await as(admin, 'PUT', `/api/trainer/records/${judged.id}`, { action: 'accept' })).statusCode).toBe(200);
    const game = bad.records.find((r: any) => r.source === 'game' && !r.corrected);
    expect(game.reasons.length).toBeGreaterThan(0);
    expect((await as(admin, 'PUT', `/api/trainer/records/${game.id}`, { action: 'accept' })).statusCode).toBe(400);
    expect((await as(admin, 'PUT', `/api/trainer/records/${game.id}`, { action: 'edit', corrected: 'Better narration.' })).statusCode).toBe(200);
    const other = bad.records.find((r: any) => r.id !== judged.id && r.id !== game.id);
    await as(admin, 'PUT', `/api/trainer/records/${other.id}`, { action: 'reject' });
    const labels = Object.fromEntries((db.prepare(`SELECT id, label, corrected FROM lab_records WHERE id IN (${judged.id}, ${game.id}, ${other.id})`).all() as any[]).map((r) => [r.id, r]));
    expect(labels[judged.id].label).toBe('accepted');
    expect(labels[game.id]).toMatchObject({ label: 'accepted', corrected: 'Better narration.' });
    expect(labels[other.id].label).toBe('rejected');
    await as(admin, 'DELETE', `/api/trainer/records/${other.id}`);
    expect(records('id = ?', other.id)).toHaveLength(0);
  });
});

describe('the dataset push', () => {
  it('pushes good and accepted records as chat examples, each only once', async () => {
    const { pushDataset } = await import('../src/trainer/nightly.js');
    const want = records("label IN ('good', 'accepted') AND source != 'eval'").length;
    const first = await pushDataset();
    expect(first.pushed).toBe(want);
    const ds = [...hm.datasets.values()].find((d) => d.name === 'DungeonMind DM')!;
    expect(ds.items).toHaveLength(want);
    expect(ds.items.every((i: any) => i.messages.at(-1).role === 'assistant' && i.messages.slice(0, -1).every((m: any) => m.role !== 'assistant'))).toBe(true);
    expect(ds.items.some((i: any) => i.messages.at(-1).content === 'Better narration.')).toBe(true); // the correction, not the bad answer
    expect((await pushDataset()).pushed).toBe(0);
    expect(ds.items).toHaveLength(want);
  });

  it('the 02:45 task pushes once a day while nightly is on', async () => {
    const { tick } = await import('../src/jobs.js');
    const { registerNightly } = await import('../src/trainer/nightly.js');
    registerNightly();
    const id = Number((db.prepare("SELECT id FROM lab_records WHERE label = 'pending' LIMIT 1").get() as any).id);
    db.prepare("UPDATE lab_records SET label = 'good' WHERE id = ?").run(id);
    const ds = [...hm.datasets.values()].find((d) => d.name === 'DungeonMind DM')!;
    const n = ds.items.length;
    await tick(new Date(2026, 9, 30, 2, 45)); // nightly is off
    expect(ds.items).toHaveLength(n);
    await as(admin, 'PUT', '/api/trainer/settings', { nightly: true });
    await tick(new Date(2026, 9, 30, 2, 50));
    expect(ds.items).toHaveLength(n + 1);
    await tick(new Date(2026, 9, 30, 2, 55));
    expect(ds.items).toHaveLength(n + 1);
  });
});

describe('the nightly workflow', () => {
  it('is installed in HiveMind with its 03:00 schedule and a dm_ callback token', async () => {
    const r = (await as(admin, 'PUT', '/api/trainer/settings', { nightly: true, base: 'unsloth/Qwen3-8B', callbackUrl: 'https://dm.example.com/' })).json();
    expect(r.nightly.ok).toBe(true);
    const wf = hm.canvases.get('dnd-nightly');
    const train = wf.nodes.find((n: any) => n.type === 'train');
    expect(train.config).toMatchObject({ dataset: 'DungeonMind DM', base: 'unsloth/Qwen3-8B', minNewExamples: 100, nightly: true, wait: true });
    const http = wf.nodes.find((n: any) => n.type === 'http');
    expect(http.config.url).toBe('https://dm.example.com/api/trainer/candidate');
    const token = http.config.headers.authorization.replace('Bearer ', '');
    expect(token).toMatch(/^dm_/);
    expect(hm.schedules.get('dnd-nightly')).toMatchObject({ time: '03:00', enabled: true });
    // The token works for the callback (it acts as the admin).
    expect((await app.inject({ method: 'POST', url: '/api/trainer/candidate', headers: { authorization: `Bearer ${token}` }, payload: { status: 'skipped', examples: 12 } })).statusCode).toBe(202);
    await until(() => !!db.prepare('SELECT 1 FROM trainer_results').get());
    const status = (await as(admin, 'GET', '/api/trainer/status')).json();
    expect(status.last).toMatchObject({ status: 'skipped', promoted: false, reason: 'there were not enough new examples (12)' });
    expect(status).toMatchObject({ window: { start: '03:00', end: '08:00' }, nextRun: '03:00', features: { schedules: true, modelOverride: true } });
    expect(status.dataset.size).toBeGreaterThan(0);
  });

  it('says HiveMind needs updating instead of failing on an old HiveMind', async () => {
    await refreshFeatures(BASE_FEATURES);
    const r = (await as(admin, 'PUT', '/api/trainer/settings', { nightly: true })).json();
    expect(r.nightly).toMatchObject({ ok: false, error: 'HiveMind needs updating (schedules)' });
    const s = (await as(admin, 'GET', '/api/trainer/status')).json();
    expect(s.features).toEqual({ modelOverride: false, nodeInputs: false, scopedTraining: false, trainEvents: false, trainingWindow: false, schedules: false });
    expect(s.window).toBeNull();
    expect((await settle(app, admin, await as(admin, 'POST', '/api/trainer/train-now'))).json().error).toMatch(/HiveMind needs updating \(scopedTraining\)/);
    await refreshFeatures([...BASE_FEATURES, ...M9_FEATURES]);
  });
});

describe('the promotion decision', () => {
  it('promotes only with fewer errors/100 and JSON valid % not lower', async () => {
    const { decide } = await import('../src/trainer/nightly.js');
    const sb = (errorsPer100: number, jsonValid: number) => ({ model: 'm', games: 2, turns: 20, jsonValid, rulesPer100: 0, numberPer100: 0, resourcePer100: 0, errorsPer100, story: null, tokensPerSec: null, secondsPerTurn: null });
    expect(decide(sb(5, 100), sb(10, 100)).promote).toBe(true);
    expect(decide(sb(10, 100), sb(10, 100)).promote).toBe(false);
    expect(decide(sb(5, 95), sb(10, 100))).toMatchObject({ promote: false, reason: expect.stringMatching(/JSON/) });
    expect(decide(sb(12, 100), sb(10, 90)).promote).toBe(false);
  });

  it('runs the eval sim on a candidate and promotes the better one through dm-model', async () => {
    await as(admin, 'PUT', '/api/settings/hivemind', { models: { story: { providerId: 'ollama', model: 'bad-old' }, json: { providerId: 'ollama', model: 'bad-old' } } });
    const before = db.prepare('SELECT COUNT(*) AS n FROM trainer_results').get() as { n: number };
    expect((await as(admin, 'POST', '/api/trainer/candidate', { status: 'done', model: 'dungeonmind-dm-7', jobId: 'j1', examples: 150 })).statusCode).toBe(202);
    await until(() => (db.prepare('SELECT COUNT(*) AS n FROM trainer_results').get() as { n: number }).n > before.n, 120_000);
    const last = (await as(admin, 'GET', '/api/trainer/status')).json().last;
    expect(last).toMatchObject({ promoted: true, model: 'dungeonmind-dm-7', examples: 150 });
    expect(last.candidate.errorsPer100).toBeLessThan(last.current.errorsPer100);
    expect((await as(admin, 'GET', '/api/settings/hivemind')).json().models.story.model).toBe('dungeonmind-dm-7');
    // Fixed eval scenarios, 2 games × 10 turns per model, recorded as eval (never pushed).
    const evalRecs = records('sim_id = ?', last.simId);
    expect(evalRecs.every((r) => r.source === 'eval')).toBe(true);
    const sim = (await as(admin, 'GET', `/api/trainer/sims/${last.simId}`)).json();
    expect(sim.scoreboard.map((s: any) => [s.games, s.turns])).toEqual([
      [2, 20],
      [2, 20],
    ]);
    expect(last.reportId).toBeTruthy();

    // A worse candidate is not promoted.
    const n = (db.prepare('SELECT COUNT(*) AS n FROM trainer_results').get() as { n: number }).n;
    await as(admin, 'POST', '/api/trainer/candidate', { status: 'done', model: 'dungeonmind-bad-8', examples: 120 });
    await until(() => (db.prepare('SELECT COUNT(*) AS n FROM trainer_results').get() as { n: number }).n > n, 120_000);
    const kept = (await as(admin, 'GET', '/api/trainer/status')).json().last;
    expect(kept).toMatchObject({ promoted: false, model: 'dungeonmind-bad-8' });
    expect(kept.reason).toMatch(/not fewer/);
    expect((await as(admin, 'GET', '/api/settings/hivemind')).json().models.story.model).toBe('dungeonmind-dm-7');
  }, 240_000);

  it('Train now pushes, starts training in HiveMind and follows it', async () => {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM trainer_results').get() as { n: number }).n;
    const r = await settle(app, admin, await as(admin, 'POST', '/api/trainer/train-now'));
    expect(r.statusCode).toBe(200);
    const job = hm.trainJobs.get(r.json().jobId)!;
    expect(job.body).toMatchObject({ base: 'unsloth/Qwen3-8B', name: 'dungeonmind-dm', allowSmall: true, nightly: false, datasetId: expect.any(String) });
    // The training stream reaches "Watch the AI" (admins only), without the HiveMind token.
    await until(async () => (await as(admin, 'GET', `/api/trainer/live/${encodeURIComponent(`train:${job.id}`)}`)).json().some((e: any) => e.type === 'done'));
    const events = (await as(admin, 'GET', `/api/trainer/live/${encodeURIComponent(`train:${job.id}`)}`)).json();
    expect(events.filter((e: any) => e.type === 'loss').map((e: any) => e.data.loss)).toEqual([1.5, 0.9]);
    expect(JSON.stringify(events)).not.toContain(hm.token);
    // Then the same candidate pipeline as at night.
    await until(() => (db.prepare('SELECT COUNT(*) AS n FROM trainer_results').get() as { n: number }).n > n, 120_000);
    expect((await as(admin, 'GET', '/api/trainer/status')).json().last).toMatchObject({ model: 'dungeonmind-dm-1', promoted: false });
  }, 180_000);
});

describe('the improvement report', () => {
  it('sends the scoreboard, the errors with example turns and the current prompts, and keeps a history', async () => {
    const { id } = (await as(admin, 'POST', '/api/trainer/reports', { simIds: [simId] })).json();
    await until(async () => (await as(admin, 'GET', `/api/trainer/reports/${id}`)).json().status !== 'running');
    const call = hm.callsOf('dnd-report').filter((c) => c.vars.scoreboard.includes('good-model')).at(-1)!;
    expect(Object.keys(call.vars).sort()).toEqual(['errors', 'prompts', 'scoreboard']);
    const board = JSON.parse(call.vars.scoreboard);
    expect(board.map((b: any) => b.model).sort()).toEqual(['ollama/bad-model', 'ollama/good-model']);
    expect(board[0]).toHaveProperty('errorsPer100');
    const errors = JSON.parse(call.vars.errors);
    expect(Object.keys(errors.counts).length).toBeGreaterThan(0);
    expect(errors.examples.some((e: any) => e.source === 'sim')).toBe(true);
    expect(errors.examples.some((e: any) => e.source === 'game')).toBe(true); // bad records from real games too
    expect(call.vars.prompts).toContain('### dnd-narrate / narration');
    const rep = (await as(admin, 'GET', `/api/trainer/reports/${id}`)).json();
    expect(rep).toMatchObject({ status: 'done', md: expect.stringContaining('## Top errors') });
    const dl = await as(admin, 'GET', `/api/trainer/reports/${id}/download`);
    expect(dl.headers['content-type']).toContain('text/markdown');
    expect((await as(admin, 'GET', '/api/trainer/reports')).json().some((r: any) => r.id === id)).toBe(true);
    await as(admin, 'DELETE', `/api/trainer/reports/${id}`);
    expect((await as(admin, 'GET', '/api/trainer/reports')).json().some((r: any) => r.id === id)).toBe(false);
  });
});

describe('the DM model picker', () => {
  it('offers only trained dungeonmind-* models, the curated list and well-tested models', async () => {
    hm.models = [
      { providerId: 'ollama', id: 'dungeonmind-dm-7' },
      { providerId: 'ollama', id: 'qwen3:8b' },
      { providerId: 'ollama', id: 'llama3:70b' },
    ];
    const r = (await as(admin, 'GET', '/api/trainer/dm-models')).json();
    const models = r.options.map((o: any) => o.model);
    expect(models).toEqual(expect.arrayContaining(['dungeonmind-dm-7', 'hf.co/LatitudeGames/Wayfarer-2-12B-GGUF:Q4_K_M', 'qwen3:8b', 'qwen3.5:9b']));
    expect(models).not.toContain('llama3:70b');
    expect(r.options.find((o: any) => o.model === 'qwen3:8b').installed).toBe(true);
    expect(r.options.find((o: any) => o.model === 'qwen3.5:9b').installed).toBe(false);
    // good-model had 100% valid JSON over ≥ 20 eval turns? Only sims of ≥ 20 turns count.
    expect(r.options.filter((o: any) => o.why === 'tested').every((o: any) => o.jsonValid >= 90 && o.turns >= 20)).toBe(true);
  });
});
