/** Screenshots of real gameplay, so there is something to look at. */
import fs from 'node:fs';
import { chromium } from 'playwright';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT = process.env.OUT || 'shots';
const URL = process.env.URL || 'http://127.0.0.1:4180/';
const VIEWS = (process.env.VIEWS || 'grid,launch,street,corner,pack,waterfront').split(',');
// The review set. Named moments rather than arbitrary times, so two runs are comparable and a
// critic sees the same six situations every round.
const AT = { grid: 0.2, launch: 4.2, street: 9, corner: 17, pack: 25, waterfront: 34, wide: 25 };

fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ executablePath: CHROME,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
p.on('pageerror', e => console.log('  page error: ' + e.message));
await p.goto(URL + '?audio=0', { waitUntil: 'load', timeout: 240000 });
await p.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 600000 });
await p.evaluate(() => {
  window.__game.startRace(0);
  // Nobody is at the keyboard in a screenshot, so hand the player's kart to the AI. Otherwise
  // every shot is a parked kart, which is what the first run produced.
  window.__game.race.setInput(null);
});

let t = 0;
for (const v of VIEWS) {
  const want = AT[v] ?? 6;
  await p.evaluate(s => { const g = window.__game; for (let i = 0; i < Math.round(s * 60); i++) g.stepFrame(1 / 60); }, Math.max(0, want - t));
  t = Math.max(t, want);
  await p.evaluate(() => window.__game.render());
  await p.screenshot({ path: `${OUT}/${v}.png`, timeout: 240000 });
  const s = await p.evaluate(() => window.__game.snapshot());
  console.log(`${v.padEnd(8)} t=${want.toFixed(1)}s  ${s.phase.padEnd(9)} place ${s.place}  ${(s.speed * 3.6).toFixed(0)} km/h`);
}
await b.close();
