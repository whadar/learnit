/** Headless screenshot harness: boots the built game and captures the named camera views. */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const URL_BASE = process.env.SHOOT_URL || 'http://127.0.0.1:4173/';
const OUT = process.env.SHOOT_OUT || 'shots';
const VIEWS = (process.env.SHOOT_VIEWS || 'overview,village,street,ridge').split(',');
const W = +(process.env.SHOOT_W || 1280), H = +(process.env.SHOOT_H || 720);
const WARM = +(process.env.SHOOT_WARM || 45);

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

await page.goto(URL_BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null,
  { timeout: 180000 }).catch(() => {});
const err = await page.evaluate(() => window.__game?.error || null);
if (err) { console.error('GAME ERROR:', err); console.error(logs.join('\n')); await browser.close(); process.exit(2); }

const results = [];
for (const v of VIEWS) {
  await page.evaluate(n => window.__game.setView(n), v);
  // Let streaming/LOD/temporal effects settle before capturing.
  await page.evaluate(f => new Promise(res => {
    let i = 0; const step = () => (++i >= f ? res() : requestAnimationFrame(step)); requestAnimationFrame(step);
  }), WARM);
  const file = path.join(OUT, `${v}.png`);
  await page.screenshot({ path: file });
  results.push({ view: v, file, bytes: fs.statSync(file).size });
}
console.log(JSON.stringify({ ok: true, results, logs: logs.slice(-25) }, null, 1));
await browser.close();
