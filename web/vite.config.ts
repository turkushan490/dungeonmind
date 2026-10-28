import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5174, proxy: { '/api': 'http://localhost:4830', '/socket.io': { target: 'http://localhost:4830', ws: true } } },
  build: { outDir: 'dist', emptyOutDir: true },
});
