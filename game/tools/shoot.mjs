/**
 * Kat Racing — headless review harness.
 *
 * Boots the *real* game (src/main.js) in headless Chromium under SwiftShader, drives it into a
 * genuine race state for each named view, lets the frame settle and screenshots it. Every
 * canonical view is real gameplay: real physics, real AI, real items, the real chase camera and
 * the real HUD — not a debug plate.
 *
 *   npx vite preview --port 4173 --strictPort --host 127.0.0.1 &
 *   node tools/shoot.mjs                                    # the canonical review set
 *   SHOOT_OUT=shots/review SHOOT_VIEWS=driftCorner node tools/shoot.mjs
 *
 * Environment
 *   SHOOT_URL      base URL                       (http://127.0.0.1:4173/)
 *   SHOOT_QUERY    query string appended          (review=1&audio=0&q=high)
 *   SHOOT_OUT      output directory               (shots)
 *   SHOOT_VIEWS    comma-separated view names     (the canonical set)
 *   SHOOT_W/H      viewport                       (1280x720)
 *   SHOOT_WARM     frames to settle per view      (8)
 *   SHOOT_SNAP     also write <out>/views.json with a state dump per view (1)
 *
 * Views
 *   gridStart      the eight-kart grid a beat before the lights go out
 *   villageStreet  chase camera through the houses on Rehov Rakefet
 *   oliveGrove     chase along Ridge Road between the olive groves
 *   hilltopVista   wide plate from the summit looking down the Menashe climb
 *   driftCorner    the player mid-drift through the wadi hairpin
 *   itemChaos      mid-pack item scrap with projectiles in the air
 *   photoFinish    last lap, two karts nose to nose at the line
 *   introFlythrough  a frame from the pre-race cinematic
 *   overview / village / street / ridge   static landscape plates (legacy)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = process.env.SHOOT_URL || 'http://127.0.0.1:4173/';
const QUERY = process.env.SHOOT_QUERY ?? 'review=1&audio=0&q=high';
const OUT = process.env.SHOOT_OUT || 'shots';
const DEFAULT_VIEWS = 'gridStart,villageStreet,oliveGrove,hilltopVista,driftCorner,itemChaos,photoFinish';
const VIEWS = (process.env.SHOOT_VIEWS || DEFAULT_VIEWS).split(',').map(s => s.trim()).filter(Boolean);
const W = +(process.env.SHOOT_W || 1280), H = +(process.env.SHOOT_H || 720);
const WARM = +(process.env.SHOOT_WARM || 8);
const SNAP = process.env.SHOOT_SNAP !== '0';

const url = BASE + (QUERY ? (BASE.includes('?') ? '&' : '?') + QUERY : '');

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

const settle = f => page.evaluate(n => new Promise(res => {
  let i = 0;
  const step = () => (++i >= n ? res() : requestAnimationFrame(step));
  requestAnimationFrame(step);
}), f);

const t0 = Date.now();
await page.goto(url, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null,
  { timeout: 600000 }).catch(() => {});

const err = await page.evaluate(() => window.__game?.error || null);
if (err) {
  console.error('GAME ERROR:', err);
  console.error(logs.join('\n'));
  await browser.close();
  process.exit(2);
}
const bootMs = Date.now() - t0;
const warnings = await page.evaluate(() => window.__game?.warnings || []);

const results = [];
const snaps = {};
for (const v of VIEWS) {
  const t = Date.now();
  const ok = await page.evaluate(n => {
    try { window.__game.setView(n); return true; } catch (e) { console.error('setView ' + n + ': ' + e.message); return false; }
  }, v);
  if (!ok) { results.push({ view: v, error: 'setView failed' }); continue; }
  await settle(WARM);
  const file = path.join(OUT, `${v}.png`);
  await page.screenshot({ path: file, timeout: 180000 });
  if (SNAP) snaps[v] = await page.evaluate(() => window.__game.snapshot());
  results.push({ view: v, file, bytes: fs.statSync(file).size, ms: Date.now() - t });
}
if (SNAP) fs.writeFileSync(path.join(OUT, 'views.json'), JSON.stringify({ url, bootMs, warnings, snaps }, null, 1));

console.log(JSON.stringify({ ok: true, url, bootMs, warnings, results, logs: logs.slice(-25) }, null, 1));
await browser.close();
