// Renders the SVG icon to PNGs: templates/icon.png (Unraid) and web/public/icon-192/512.png (home screen, Android).
// Run once after changing the icon: PLAYWRIGHT_PATH=... node scripts/icon-png.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || 'playwright');
const svg = readFileSync('templates/icon.svg', 'utf8');
const browser = await chromium.launch();
for (const [size, out, bg] of [
  [256, 'templates/icon.png', 'transparent'],
  [192, 'web/public/icon-192.png', '#0d1117'],
  [512, 'web/public/icon-512.png', '#0d1117'],
]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const pad = bg === 'transparent' ? 0 : Math.round(size * 0.1);
  await page.setContent(`<html><body style="margin:0;background:${bg};display:flex;align-items:center;justify-content:center;height:100vh">${svg.replace('<svg ', `<svg width="${size - 2 * pad}" height="${size - 2 * pad}" `)}</body></html>`);
  await page.screenshot({ path: out, omitBackground: bg === 'transparent' });
  await page.close();
}
await browser.close();
