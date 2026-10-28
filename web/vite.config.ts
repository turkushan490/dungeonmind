import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** @3d-dice/dice-box loads its physics (ammo.wasm) and themes from a static folder at runtime. */
function diceAssets(): Plugin {
  return {
    name: 'dice-box-assets',
    buildStart() {
      const pkg = dirname(createRequire(import.meta.url).resolve('@3d-dice/dice-box/package.json'));
      const from = join(pkg, 'dist', 'assets');
      if (existsSync(from)) cpSync(from, join(__dirname, 'public', 'assets', 'dice-box'), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), diceAssets()],
  server: { port: 5174, proxy: { '/api': 'http://localhost:4830', '/socket.io': { target: 'http://localhost:4830', ws: true } } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2500 },
});
