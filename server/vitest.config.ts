import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@dungeonmind/shared': new URL('../packages/shared/src/index.ts', import.meta.url).pathname } },
  test: { testTimeout: 20_000, hookTimeout: 30_000 },
});
