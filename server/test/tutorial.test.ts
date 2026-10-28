import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshApp, register } from './helpers.js';

let app: FastifyInstance;
let cookie: string;
let turn: typeof import('../src/game/turn.js');

beforeAll(async () => {
  // No HiveMind at all: the tutorial must work without one.
  app = await freshApp({ HIVEMIND_URL: '', HIVEMIND_TOKEN: '' });
  cookie = await register(app, 'newbie');
  turn = await import('../src/game/turn.js');
});
afterAll(() => app?.close());

const as = (method: string, url: string, payload?: unknown) => app.inject({ method: method as 'GET', url, headers: { cookie }, payload: payload as object });

describe('the tutorial', () => {
  it('plays from opening through a fight to a level-up without HiveMind', async () => {
    const { id } = (await as('POST', '/api/tutorial', {})).json();
    await turn.settled(id);
    let g = (await as('GET', `/api/games/${id}`)).json();
    expect(g).toMatchObject({ status: 'playing', visibility: 'private', settings: { tutorial: true } });
    const rook = g.characters[0];
    expect(rook.name).toBe('Rook');
    expect(g.state.choices[rook.id]).toHaveLength(4);

    const act = async () => {
      await as('POST', `/api/games/${id}/actions`, { characterId: rook.id, choice: 0 });
      await turn.settled(id);
      for (let i = 0; i < 10; i++) {
        const cur = (await as('GET', `/api/games/${id}`)).json();
        const r = cur.state.rolls.find((x: any) => !x.result && x.characterId);
        if (!r) break;
        // Natural 20s on attacks (a crit doubles the damage dice: 2 values), 8s on damage dice.
        const n = r.kind === 'damage' ? (r.crit ? 2 : 1) : r.adv && r.adv !== 'none' ? 2 : 1;
        await as('POST', `/api/games/${id}/rolls/${r.id}`, { mode: 'manual', values: Array(n).fill(r.kind === 'damage' ? 8 : 20) });
        await turn.settled(id);
      }
      return (await as('GET', `/api/games/${id}`)).json();
    };

    g = await act(); // perception, the wolf appears
    expect(g.state.combat.order.map((o: any) => o.name).sort()).toEqual(['Rook', 'Starving Wolf']);
    for (let i = 0; i < 6 && g.state.combat; i++) g = await act(); // natural 20s: the wolf goes down
    expect(g.state.combat).toBeUndefined();
    expect(g.characters[0].xp).toBe(300);
    expect(g.characters[0].levelUpPending).toBe(true);
    const up = (await as('POST', `/api/games/${id}/characters/${rook.id}/level-up`, { hp: 'fixed' })).json();
    expect(up.level).toBe(2);
    const log = (await as('GET', `/api/games/${id}/log`)).json();
    expect(log.some((e: any) => e.kind === 'roll' && /rolled by the player/.test(e.text))).toBe(true);
  });

  it('is private: nobody else sees it', async () => {
    const other = await register(app, 'other');
    const { id } = (await as('POST', '/api/tutorial', {})).json();
    expect((await app.inject({ url: `/api/games/${id}`, headers: { cookie: other } })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/games', headers: { cookie: other } })).json().spectate).toEqual([]);
  });
});
