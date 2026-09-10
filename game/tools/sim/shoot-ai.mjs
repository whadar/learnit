/**
 * Screenshot harness for preview/ai.html. Same job as tools/shoot.mjs, but survives a dozen
 * agents editing the repo at once: when a teammate's save triggers a Vite full reload mid-capture
 * it waits for the page to come back and retries the view instead of dying.
 *
 *   SHOOT_URL=... SHOOT_OUT=shots/ai SHOOT_VIEWS=circuit,apex node tools/sim/shoot-ai.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const URL_BASE = process.env.SHOOT_URL || 'http://127.0.0.1:5224/preview/ai.html';
const OUT = process.env.SHOOT_OUT || 'shots/ai';
const VIEWS = (process.env.SHOOT_VIEWS || 'circuit,apex,pack,trackside,chase').split(',');
const W = +(process.env.SHOOT_W || 1280), H = +(process.env.SHOOT_H || 720);
const WARM = +(process.env.SHOOT_WARM || 40);

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

await page.goto(URL_BASE, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null,
  { timeout: 300000 }).catch(() => {});
const err = await page.evaluate(() => window.__game?.error || null);
if (err) { console.error('GAME ERROR:', err); console.error(logs.join('\n')); await browser.close(); process.exit(2); }

async function waitReady() {
  await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null,
    { timeout: 300000 });
  const e = await page.evaluate(() => window.__game?.error || null);
  if (e) throw new Error('game error: ' + e);
}

const results = [];
for (const v of VIEWS) {
  let done = false;
  for (let attempt = 0; attempt < 4 && !done; attempt++) {
    try {
      await waitReady();
      await page.evaluate(n => window.__game.setView(n), v);
      await page.evaluate(f => new Promise(res => {
        let i = 0; const step = () => (++i >= f ? res() : requestAnimationFrame(step)); requestAnimationFrame(step);
      }), WARM);
      const file = path.join(OUT, `${v}.png`);
      await page.screenshot({ path: file });
      results.push({ view: v, file, bytes: fs.statSync(file).size });
      done = true;
    } catch (err) {
      logs.push(`[retry ${v} #${attempt}] ${err.message.split('\n')[0]}`);
      await page.waitForTimeout(2000);
    }
  }
  if (!done) logs.push(`[failed] ${v}`);
}
console.log(JSON.stringify({ ok: true, results, logs: logs.slice(-12) }, null, 1));
await browser.close();
