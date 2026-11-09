import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { FakeHiveMind } from './fake-hivemind.js';
import { unzipSync, strFromU8 } from 'fflate';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { register, setupGame } from './helpers.js';

let app: FastifyInstance;
let url: string;
const sockets: Socket[] = [];
const hm = new FakeHiveMind();

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dm-hidden-'));
  process.env.AUTH_MODE = 'builtin';
  await hm.start();
  process.env.HIVEMIND_URL = hm.url;
  process.env.HIVEMIND_TOKEN = hm.token;
  const { buildApp } = await import('../src/app.js');
  app = await buildApp({ logger: false, web: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});
afterAll(async () => {
  sockets.forEach((s) => s.close());
  await app?.close();
  await hm.stop();
});

function open(cookie: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(url, { path: '/socket.io', transports: ['websocket'], extraHeaders: { cookie }, reconnection: false });
    sockets.push(socket);
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

function expectHidden(rolls: any[]) {
  expect(rolls[0]).not.toHaveProperty('dc');
  expect(rolls[1]).not.toHaveProperty('targetAc');
  expect(rolls[2].result.total).toBe(18);
}

describe('hidden roll targets', () => {
  it('redacts game details, exports, and broadcasts for non-hosts without changing stored state', async () => {
    const t = await setupGame(app);
    const spectator = await register(app, 'spectator');
    const { loadGame, saveGame, detail, broadcast } = await import('../src/game/store.js');
    const g = loadGame(t.id)!;
    g.visibility = 'public';
    g.status = 'playing';
    g.settings.hideTargets = true;
    g.state.rolls = [
      { id: 'save', actor: 'A', kind: 'save', label: 'Save', dice: '1d20', bonus: 0, dc: 15 },
      { id: 'attack', actor: 'A', kind: 'attack', label: 'Attack', dice: '1d20', bonus: 0, targetAc: 17 },
      { id: 'resolved', actor: 'A', kind: 'save', label: 'Save', dice: '1d20', bonus: 0, dc: 14, result: { total: 18, text: 'Success', dice: [18], manual: false } },
    ];
    g.state.npcs = [{ name: 'Guard', ac: 17 }];
    g.state.rolls[0].label = 'Save vs DC 15';
    g.state.rolls[0].reason = 'DC 15 trap';
    g.state.rolls[2].result!.text = 'Save vs DC 14';
    g.state.choices = { player: ['Try DC 15'] };
    g.state.refused = [{ characterId: 'player', reason: 'DC 15 trap' }];
    g.state.streaming = 'Guard AC 17';
    g.state.error = 'Failed DC 15';
    g.state.scenePrompt = 'Guard AC 17';
    saveGame(g);
    const original = structuredClone(g.state);
    expectHidden(detail(g, 'player').state.rolls);
    const playerState = detail(g, 'player').state;
    expect(JSON.stringify(playerState)).not.toMatch(/(?:AC|DC) \d+/);
    expect(playerState.npcs[0]).not.toHaveProperty('ac');
    expect(playerState.rolls[0].label).toBe('Save');
    expect(playerState.rolls[0].reason).toBe('DC ? trap');
    expect(playerState.rolls[2].result!.text).toBe('Save');
    expectHidden(detail(g, 'spectator').state.rolls);
    expectHidden(detail(g, 'invited').state.rolls);
    expect(g.state).toEqual(original);
    expect(detail(g, 'host').state.rolls).toEqual(original.rolls);
    for (const cookie of [t.pl, spectator]) {
      const res = await t.as(cookie, 'GET', `/api/games/${t.id}`);
      expect(res.statusCode).toBe(200);
      expectHidden(res.json().state.rolls);
      const zip = await t.as(cookie, 'GET', `/api/games/${t.id}/export.zip`);
      expect(zip.statusCode).toBe(200);
      expectHidden(JSON.parse(strFromU8(unzipSync(zip.rawPayload)['game.json'])).state.rolls);
    }
    const host = await open(t.host);
    const player = await open(t.pl);
    for (const socket of [host, player]) {
      expect(await new Promise<boolean>((resolve) => socket.emit('game:join', t.id, resolve))).toBe(true);
    }
    const hostUpdate = new Promise<any>((resolve) => host.once('game:update', resolve));
    const playerUpdate = new Promise<any>((resolve) => player.once('game:update', resolve));
    broadcast(g);
    expect((await hostUpdate).state.rolls).toEqual(original.rolls);
    expectHidden((await playerUpdate).state.rolls);
    g.settings.hideTargets = false;
    expect(detail(g, 'player').state.rolls).toEqual(original.rolls);
    const visibleUpdate = new Promise<any>((resolve) => player.once('game:update', resolve));
    broadcast(g);
    expect((await visibleUpdate).state.rolls).toEqual(original.rolls);
  });
});


describe('target redaction at delivery', () => {
  it('redacts old and new real rolls, concentration, campaign versions and exports for every non-host role', async () => {
    const t = await setupGame(app);
    const spectator = await register(app, 'watcher');
    const invited = await register(app, 'invitee');
    expect((await t.as(t.host, 'POST', `/api/games/${t.id}/invites`, { username: 'invitee' })).statusCode).toBe(200);
    const store = await import('../src/game/store.js');
    const { buildRolls, resolveRoll } = await import('../src/game/rolls.js');
    const { logRoll } = await import('../src/game/engine.js');
    const { addLog, readLog } = await import('../src/game/log.js');
    const { saveCampaign } = await import('../src/game/campaign.js');
    const { campaignFor } = await import('../src/game/prompt.js');
    const { applyDamage } = await import('../src/game/bookkeeper.js');
    const { rules } = await import('../src/rules/index.js');
    const { redactTargets, logFor } = await import('../src/game/hidden.js');
    const g = store.loadGame(t.id)!;
    g.visibility = 'public';
    g.status = 'playing';
    const chars = store.gameCharacters(g.id);
    g.state.npcs = [{ name: 'Guard', hp: 20, maxHp: 20, ac: 13 }];
    const rolls = buildRolls(rules(g.ruleset), chars, g.state.npcs, { rolls: [
      { actor: chars[0].name, kind: 'attack', weapon: 'Longsword', target: 'Guard' },
      { actor: chars[1].name, kind: 'save', ability: 'str', dc: 15 },
      { actor: chars[0].name, kind: 'check', dc: 15, reason: 'DC 15 because the ledge is slippery' },
    ] });
    for (const r of rolls.slice(0, 2)) {
      resolveRoll(r, rolls, [12]);
      logRoll(g, r);
    }
    expect(rolls[0].result!.text).toContain('vs AC 13');
    expect(rolls[1].result!.text).toContain('vs DC 15');
    g.state.rolls = rolls;
    store.saveGame(g);
    saveCampaign(g.id, '# Tale\n\n## Current scene\nGuard: AC 13. The ledge is DC 15.', 'host', 0);
    const campaign = (await t.as(t.host, 'GET', `/api/games/${g.id}/campaign`)).json();
    const version = campaign.versions[0].id;
    // Both concentration text formats come from the real damage path.
    for (const conBonus of [100, -100]) {
      const c = { ...structuredClone(chars[1]), hp: 40, maxHp: 40, concentration: 'Bless' };
      const text = applyDamage(c, 2, { conBonus, ruleset: g.ruleset }).find((x) => x.includes('vs DC'))!;
      expect(text).toContain('vs DC 10');
      expect(redactTargets(text)).not.toContain('vs DC');
      addLog(g.id, 0, 'change', text);
    }
    const original = structuredClone(g.state);
    addLog(g.id, 0, 'roll', 'Legacy vs AC 13', 'Guard', { dc: 15, targetAc: 13, total: 18 });
    const fullLog = readLog(g.id);
    expect((await t.as(t.host, 'PUT', `/api/games/${g.id}`, { hideTargets: true })).statusCode).toBe(200);
    const hiddenGame = store.loadGame(g.id)!;
    for (const role of ['player', 'spectator', 'invited'] as const) {
      const state = store.stateFor(hiddenGame, role);
      expect(state.npcs[0]).not.toHaveProperty('ac');
      expect(state.rolls[2].reason).toBe('DC ? because the ledge is slippery');
      for (const r of state.rolls) {
        expect(r).not.toHaveProperty('dc');
        expect(r).not.toHaveProperty('targetAc');
        if (r.result) {
          expect(r.result.text).not.toMatch(/(?:AC|DC) \d+/);
        }
      }
    }
    for (const cookie of [t.pl, spectator, invited, t.host]) {
      const host = cookie === t.host;
      const detail = (await t.as(cookie, 'GET', `/api/games/${g.id}`)).json();
      const logResponse = await t.as(cookie, 'GET', `/api/games/${g.id}/log`);
      expect(logResponse.statusCode).toBe(200);
      const log = logResponse.json();
      if (host) {
        expect(detail.state).toEqual(original);
        expect(log).toEqual(fullLog);
      } else {
        expect(detail.state.npcs[0]).not.toHaveProperty('ac');
        expect(JSON.stringify(log)).not.toMatch(/(?:AC|DC) \d+/);
        for (const entry of log.filter((e: any) => e.kind === 'roll')) {
          expect(entry.data.hidden).toBe(true);
          for (const key of ['dc', 'targetAc']) expect(entry.data).not.toHaveProperty(key);
        }
      }
      for (const path of ['/campaign', `/campaign?version=${version}`, '/export.md']) {
        const res = await t.as(cookie, 'GET', `/api/games/${g.id}${path}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.includes('AC 13')).toBe(host);
        expect(res.body.includes('DC 15')).toBe(host);
      }
      const zip = await t.as(cookie, 'GET', `/api/games/${g.id}/export.zip`);
      expect(zip.statusCode).toBe(200);
      const files = unzipSync(zip.rawPayload);
      expect(strFromU8(files['game.md']).includes('AC 13')).toBe(host);
      const json = JSON.parse(strFromU8(files['game.json']));
      expect(json.log).toEqual(log);
      expect(json.state).toEqual(detail.state);
    }
    expect(campaignFor(hiddenGame, chars)).toContain('AC 13');
    expect(store.loadGame(g.id)!.state).toEqual(original);
    expect(readLog(g.id)).toEqual(fullLog);
    const host = await open(t.host);
    const player = await open(t.pl);
    const watcher = await open(spectator);
    for (const socket of [host, player, watcher]) expect(await new Promise<boolean>((resolve) => socket.emit('game:join', g.id, resolve))).toBe(true);
    const entries = [host, player, watcher].map((socket) => new Promise<any>((resolve) => socket.once('game:log', resolve)));
    logRoll(hiddenGame, rolls[0]);
    const pushed = await Promise.all(entries);
    expect(pushed[0].entry.text).toContain('vs AC 13');
    for (const payload of pushed.slice(1)) {
      expect(payload.entry.text).toBe(redactTargets(rolls[0].result!.text));
      for (const key of ['targetAc']) expect(payload.entry.data).not.toHaveProperty(key);
    }
    const changes = [host, player].map((socket) => new Promise<any>((resolve) => socket.once('game:log', resolve)));
    addLog(g.id, 0, 'change', fullLog.find((e) => e.kind === 'change')!.text);
    const changed = await Promise.all(changes);
    expect(changed[0].entry.text).toContain('vs DC 10');
    expect(changed[1].entry.text).toBe(redactTargets(changed[0].entry.text));
    // Actual engine resolutions while hiding still retain the host's full result.
    hiddenGame.state.phase = 'rolling';
    hiddenGame.state.rolls = [{ ...rolls[0], result: undefined }];
    const { playerRoll } = await import('../src/game/engine.js');
    // Keep a pending second roll to avoid starting the next DM turn.
    hiddenGame.state.rolls.push({ ...rolls[2], id: 'still-waiting' });
    expect(playerRoll(hiddenGame, rolls[0].id, chars[0].userId, true, [12])).toEqual({ done: false });
    expect(hiddenGame.state.rolls[0].result!.text).toContain('vs AC 13');
    expect(readLog(g.id).at(-1)!.text).toContain('vs AC 13');
    expect((await t.as(t.host, 'PUT', `/api/games/${g.id}`, { hideTargets: false })).statusCode).toBe(200);
    const visible = store.loadGame(g.id)!;
    expect(store.stateFor(visible, 'player')).toBe(visible.state);
    expect(logFor(visible, 'player', fullLog[0])).toBe(fullLog[0]);
    await new Promise<boolean>((resolve) => player.emit('game:join', g.id, resolve));
    const visiblePush = new Promise<any>((resolve) => player.once('game:log', resolve));
    const entry = addLog(g.id, 0, 'roll', rolls[0].result!.text, rolls[0].actor, fullLog[0].data);
    expect((await visiblePush).entry).toEqual(entry);
    expect((await t.as(t.pl, 'GET', `/api/games/${g.id}/log`)).json()).toEqual(readLog(g.id));
    expect((await t.as(t.pl, 'GET', `/api/games/${g.id}/campaign`)).json().md).toContain('AC 13');
    host.close(); player.close(); watcher.close();
  });

  it('buffers hidden narration across token boundaries while the host receives full text', async () => {
    const t = await setupGame(app);
    const store = await import('../src/game/store.js');
    const { dm } = await import('../src/game/turn.js');
    const g = store.loadGame(t.id)!;
    g.settings.hideTargets = true;
    store.saveGame(g);
    const host = await open(t.host);
    const player = await open(t.pl);
    for (const socket of [host, player]) expect(await new Promise<boolean>((resolve) => socket.emit('game:join', g.id, resolve))).toBe(true);
    const hostText: string[] = [];
    const playerText: string[] = [];
    host.on('game:stream', (p) => hostText.push(p.text));
    player.on('game:stream', (p) => playerText.push(p.text));
    const text = 'Guard has AC 13. The slippery ledge requires DC 15.';
    hm.canvases.set('dnd-narrate', { id: 'dnd-narrate', nodes: [] });
    hm.onRun = () => ({ stream: { label: 'narration', text }, outputs: { narration: text } });
    await dm(g, 'dnd-narrate', 'Tell the scene', {}, true);
    // The fake streams 12-character tokens, so "AC 13" arrives split; the player still gets it live, minus the number.
    await vi.waitFor(() => expect(playerText.join('')).toBe('Guard has AC ?. The slippery ledge requires DC ?.'));
    expect(playerText.length).toBeGreaterThan(1);
    expect(playerText.every((t) => !/\d/.test(t))).toBe(true);
    await vi.waitFor(() => expect(hostText.join('')).toBe(text));
    g.settings.hideTargets = false;
    store.saveGame(g);
    hostText.length = 0; playerText.length = 0;
    const end = new Promise<void>((resolve) => player.once('game:stream-written', () => resolve()));
    await dm(g, 'dnd-narrate', 'Tell it again', {}, true);
    await end;
    expect(hostText.join('')).toBe(text);
    expect(playerText.join('')).toBe(text);
    host.close(); player.close();
  });
});
