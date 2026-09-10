/**
 * Does the game actually restart?
 *
 * Drives the real menu with real clicks — title -> character -> course -> race, then Restart
 * Race from the pause menu and Race Again from the results — and checks that each restart
 * produces a race that runs. `startRace()` returning without throwing is not the same thing.
 *
 *   node tools/_restart.mjs
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = +(process.env.RESTART_PORT || 5211);

let fails = 0;
const check = (name, ok, detail) => { if (!ok) fails++; console.log(`  [${ok ? ' ok ' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`); };

const server = await createServer({ root: process.cwd(), server: { port: PORT, strictPort: true }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://localhost:${PORT}/?audio=0&q=potato`, { waitUntil: 'load', timeout: 240000 });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 600000 });
const boot = await page.evaluate(() => ({ ready: window.__game.ready, error: window.__game.error }));
check('boots', !!boot.ready, boot.error || '');
if (!boot.ready) { await browser.close(); await server.close(); process.exit(2); }

/** Run N simulated seconds through the real frame loop. */
const sim = (sec) => page.evaluate(s => {
  const g = window.__game, dt = 1 / 60;
  for (let i = 0; i < Math.round(s * 60); i++) g.simulate(dt, dt);
  return g.snapshot();
}, sec);

/** Click a menu item by its visible label. */
async function clickLabel(text) {
  const hit = await page.evaluate(t => {
    const all = [...document.querySelectorAll('*')].filter(n => n.children.length === 0 &&
      (n.textContent || '').trim().toLowerCase() === t.toLowerCase());
    const n = all.find(x => x.offsetParent !== null) || all[0];
    if (!n) return null;
    let e = n; while (e && !e.dataset?.i) e = e.parentElement;
    (e || n).click();
    return (e || n).className || 'clicked';
  }, text);
  await page.waitForTimeout(120);
  return hit;
}

console.log('\n== a player starts a race ==');
await clickLabel('Start');   await page.waitForTimeout(200);
await clickLabel('Mitzi');   await page.waitForTimeout(200);
let s = await page.evaluate(() => window.__game.snapshot());
console.log('  after menu: mode=' + s?.mode + ' phase=' + s?.phase);
// whatever screen we landed on, take the first course
const screen = await page.evaluate(() => window.__game.__menuScreen || null);
void screen;
await page.evaluate(() => {
  // activate the focused item until we are actually racing (title -> characters -> courses)
  const g = window.__game;
  for (let i = 0; i < 4 && g.snapshot()?.mode !== 'race'; i++) {
    const n = document.querySelector('[data-i]:not([hidden])');
    if (n) n.click();
  }
});
await page.waitForTimeout(300);
s = await sim(14);   // the intro flyover is 7 s and the countdown 3.6 s — clear both
check('a race is running', s.mode === 'race' && s.phase === 'racing', `mode=${s.mode} phase=${s.phase}`);
const movedFirst = s.speed;
check('the player is moving', movedFirst > 1, `speed=${movedFirst.toFixed(1)} m/s`);
const oppLaps1 = await page.evaluate(() => window.__game.race.racers.filter(r => !r.isPlayer)
  .reduce((a, r) => a + r.vehicle.state.speed, 0) / 7);
check('the opponents are moving', oppLaps1 > 1, `mean opponent speed=${oppLaps1.toFixed(1)} m/s`);

console.log('\n== Restart Race, from the pause menu ==');
await page.evaluate(() => window.__game.pauseRace());
await page.waitForTimeout(150);
await clickLabel('Restart Race');
await page.waitForTimeout(300);
s = await page.evaluate(() => window.__game.snapshot());
check('restart leaves the pause menu', s.mode === 'race', `mode=${s.mode}`);
check('restart puts the race back on the grid', s.raceTime < 1.0, `raceTime=${s.raceTime.toFixed(2)}s phase=${s.phase}`);
s = await sim(10);
check('the restarted race actually runs', s.phase === 'racing' && s.speed > 1, `phase=${s.phase} speed=${s.speed.toFixed(1)}`);
const opp2 = await page.evaluate(() => window.__game.race.racers.filter(r => !r.isPlayer)
  .reduce((a, r) => a + r.vehicle.state.speed, 0) / 7);
check('the opponents move after a restart', opp2 > 1, `mean opponent speed=${opp2.toFixed(1)} m/s`);

console.log('\n== Race Again, from the results screen ==');
// Reach the results screen the way the game does: park the race in 'finished' past its
// timeout and let update() promote it, so setPhase fires and showResults() actually runs.
// Poking state.phase directly skips the event and proves nothing.
await page.evaluate(() => {
  const g = window.__game;
  g.race.state.phase = 'finished'; g.race.state.phaseTime = 999;
  for (let i = 0; i < 8; i++) g.simulate(1 / 60, 1 / 60);
});
await page.waitForTimeout(400);
const modeAtResults = await page.evaluate(() => window.__game.snapshot()?.mode);
console.log('  mode at results: ' + modeAtResults);
await clickLabel('Race Again');
await page.waitForTimeout(300);
s = await sim(10);
check('Race Again starts a fresh race', s.mode === 'race' && s.phase === 'racing' && s.speed > 1,
  `mode=${s.mode} phase=${s.phase} speed=${s.speed.toFixed(1)}`);

console.log('\n== restart from awkward states ==');
// during the intro flyover
await page.evaluate(() => window.__game.startRace(0, { skipIntro: false, autopilot: false }));
await sim(2);
await page.evaluate(() => window.__game.pauseRace());
await page.waitForTimeout(150);
await clickLabel('Restart Race');
await page.waitForTimeout(250);
s = await sim(14);
check('restart during the intro', s.mode === 'race' && s.phase === 'racing' && s.speed > 1, `phase=${s.phase} speed=${s.speed.toFixed(1)}`);

// twice in a row, with no racing in between
await page.evaluate(() => window.__game.pauseRace());
await page.waitForTimeout(150); await clickLabel('Restart Race'); await page.waitForTimeout(250);
await page.evaluate(() => window.__game.pauseRace());
await page.waitForTimeout(150); await clickLabel('Restart Race'); await page.waitForTimeout(250);
s = await sim(14);
check('restart twice in a row', s.mode === 'race' && s.phase === 'racing' && s.speed > 1, `phase=${s.phase} speed=${s.speed.toFixed(1)}`);

console.log('\n== the R key ==');
const before = await page.evaluate(() => window.__game.race.state.player.vehicle.state.respawns);
await page.evaluate(() => window.__game.race.state.player.vehicle.respawn());
const after = await page.evaluate(() => window.__game.race.state.player.vehicle.respawns ?? window.__game.race.state.player.vehicle.state.respawns);
check('respawn works', after > before, `${before} -> ${after}`);

if (errors.length) { console.log('\npage errors:'); for (const e of errors.slice(0, 8)) console.log('  ' + e); }
console.log('\n' + (fails ? `FAILED ${fails}` : 'all restart checks passed'));
await browser.close(); await server.close();
process.exit(fails ? 1 : 0);
