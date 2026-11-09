import type { FastifyInstance } from 'fastify';
import type { PendingRoll } from '@dungeonmind/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { freshApp, setupGame } from './helpers.js';

let app: FastifyInstance;
let game: import('../src/game/store.js').GameRow;
let engine: typeof import('../src/game/engine.js');
let rolls: typeof import('../src/game/rolls.js');
let log: typeof import('../src/game/log.js');
let store: typeof import('../src/game/store.js');

beforeAll(async () => {
  app = await freshApp({ AUTH_MODE: 'builtin' });
  const table = await setupGame(app);
  store = await import('../src/game/store.js');
  engine = await import('../src/game/engine.js');
  rolls = await import('../src/game/rolls.js');
  log = await import('../src/game/log.js');
  game = store.loadGame(table.id)!;
  game.status = 'playing';
});
afterAll(async () => { await app?.close(); });

function record(r: PendingRoll, manual: number[], timedOut = false) {
  rolls.resolveRoll(r, [r], manual, { timedOut });
  engine.logRoll(game, r);
  return log.readLog(game.id).at(-1)!.data!;
}

function base(kind: PendingRoll['kind']): PendingRoll {
  return { id: kind, actor: 'Hero', kind, label: kind, dice: '1d20', bonus: 4, parts: [{ label: 'STR', value: 4 }] };
}

describe('roll log data', () => {
  it('records attack details, bonus dice, advantage sources and timeout', () => {
    const r = { ...base('attack'), targetAc: 15, dcReason: 'Armor', adv: 'adv' as const,
      advFrom: [{ adv: 'adv' as const, from: 'The DM' }],
      bonusDice: [{ from: 'Bless', dice: '1d4', condition: 'blessed' }] };
    expect(record(r, [8, 12, 3], true)).toMatchObject({
      rollId: 'attack', kind: 'attack', dice: [8, 12], natural: 12, bonus: 4,
      parts: [{ label: 'STR', value: 4 }], bonusRolls: [{ from: 'Bless', dice: '1d4', total: 3 }],
      advFrom: [{ adv: 'adv', from: 'The DM' }], targetAc: 15, dcReason: 'Armor', margin: 4,
      total: 19, success: true, manual: true, timedOut: true,
    });
  });

  it('records a save DC and margin', () => {
    expect(record({ ...base('save'), dc: 18, dcReason: 'Trap' }, [10])).toMatchObject({
      natural: 10, bonus: 4, dc: 18, dcReason: 'Trap', margin: -4, success: false,
    });
  });

  it('keeps complete target details in storage even while hiding targets', () => {
    game.settings.hideTargets = true;
    try {
      for (const r of [{ ...base('save'), dc: 15, dcReason: 'Trap' }, { ...base('attack'), targetAc: 15, dcReason: 'Armor' }]) {
        const data = record(r, [12]);
        expect(data.hidden).toBeUndefined();
        expect(data).toMatchObject({ dcReason: r.dcReason, margin: 1 });
        expect(data).toHaveProperty(r.kind === 'save' ? 'dc' : 'targetAc', 15);
      }
    } finally { game.settings.hideTargets = false; }
  });

  it('keeps damage and heal rolls free of d20 fields and preserves skipped children', () => {
    for (const kind of ['damage', 'heal'] as const) {
      const data = record({ ...base(kind), dice: '1d6+2', parts: undefined }, [4], true);
      expect(data).toMatchObject({ kind, total: 6, timedOut: true });
      for (const key of ['natural', 'bonus', 'parts', 'advFrom']) expect(data).not.toHaveProperty(key);
    }
    const child = { ...base('damage'), result: { dice: [], total: 0, manual: false, skipped: true, text: 'No damage' } };
    engine.logRoll(game, child);
    expect(log.readLog(game.id).at(-1)!.data).toEqual({ rollId: 'damage', kind: 'damage', dice: [], total: 0, manual: false });
  });

  it('logs sheet parts for an asked free check and leaves fun rolls unchanged', () => {
    const c = store.gameCharacters(game.id).find((x) => x.seated)!;
    expect(engine.freeRoll(game, { id: c.userId!, username: 'Player' }, { characterId: c.id, skill: 'athletics' })).toEqual({});
    expect(log.readLog(game.id).at(-1)!.data).toMatchObject({ rollId: 'asked', kind: 'check', parts: expect.any(Array), bonus: expect.any(Number) });
    expect(engine.freeRoll(game, { id: 'other-player', username: 'Player' }, { expr: '1d6' })).toEqual({});
    const fun = log.readLog(game.id).at(-1)!.data!;
    expect(fun.kind).toBe('free');
    expect(fun).not.toHaveProperty('parts');
    expect(fun).not.toHaveProperty('rollId');
  });

  it('passes no undefined values to the logger and reads older entries', () => {
    const add = vi.spyOn(log, 'addLog');
    try {
      record(base('check'), [10]);
      const data = add.mock.calls.at(-1)![5]!;
      expect(Object.values(data)).not.toContain(undefined);
    } finally { add.mockRestore(); }
    log.addLog(game.id, 1, 'roll', 'Old roll', 'Hero', { rollId: 'old', kind: 'check', dice: [10], total: 10, manual: false });
    expect(log.readLog(game.id).at(-1)!.data).toEqual({ rollId: 'old', kind: 'check', dice: [10], total: 10, manual: false });
  });
});
