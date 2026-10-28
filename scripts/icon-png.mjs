// Renders templates/icon.svg to templates/icon.png (Unraid wants a PNG). Run once after changing the icon.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || 'playwright');
import { readFileSync } from 'node:fs';
const svg = readFileSync('templates/icon.svg', 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="256" height="256" ')}</body></html>`);
await page.screenshot({ path: 'templates/icon.png', omitBackground: true });
await browser.close();
