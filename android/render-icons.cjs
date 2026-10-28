// Renders the DungeonMind icon into the Android launcher icons (run once after changing the icon).
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs');
const svg = fs.readFileSync('www/icon.svg', 'utf8');
const D = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
(async () => {
  const b = await chromium.launch();
  const shot = async (size, inner, round, out, bg) => {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    await p.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;background:${bg};${round ? 'border-radius:50%;overflow:hidden;' : ''}">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</body></html>`);
    await p.screenshot({ path: out, omitBackground: bg === 'transparent' });
    await p.close();
  };
  for (const [d, f] of Object.entries(D)) {
    const dir = `android/app/src/main/res/mipmap-${d}`;
    await shot(Math.round(48 * f), Math.round(40 * f), false, `${dir}/ic_launcher.png`, '#0d1117');
    await shot(Math.round(48 * f), Math.round(36 * f), true, `${dir}/ic_launcher_round.png`, '#0d1117');
    await shot(Math.round(108 * f), Math.round(64 * f), false, `${dir}/ic_launcher_foreground.png`, 'transparent');
  }
  await b.close();
})();
