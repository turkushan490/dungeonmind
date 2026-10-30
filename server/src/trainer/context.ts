import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelRef, RunEvent } from '../hivemind.js';

/**
 * A simulated game's context (M9): seeded dice, the models to run with (HiveMind `modelOverride`) and the live feed.
 * It follows the game's async work (turn locks, the DM queue), so the real engine runs unchanged.
 */
export interface SimContext {
  simId: string;
  source: 'sim' | 'eval';
  /** Which DM model is being compared ("current" = the canvases' own models). */
  modelKey: string;
  models?: Record<string, ModelRef>;
  rng: () => number;
  onEvent?: (canvasId: string, ev: RunEvent) => void;
}

export const simStore = new AsyncLocalStorage<SimContext>();
export const simContext = () => simStore.getStore();

/** mulberry32: small, fast, good enough for dice. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const seedOf = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
