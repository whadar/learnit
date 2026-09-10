/** Boots the built game headless and checks it races. The one test that matters. */
import { chromium, devices } from 'playwright';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const URL = process.env.URL || 'http://127.0.0.1:4180/';
const b = await chromium.launch({ executablePath: CHROME,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
let fails = 0;
const ok = (n, c, d) => { if (!c) fails++; console.log(`  [${c ? ' ok ' : 'FAIL'}] ${n}${d ? '  — ' + d : ''}`); };

for (const [label, dev] of [['desktop', null], ['phone', devices['Pixel 5']]]) {
  const ctx = await b.newContext(dev ? { ...dev } : { viewport: { width: 1280, height: 720 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(URL + '?audio=0', { waitUntil: 'load', timeout: 240000 });
  await p.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 600000 });
  const r = await p.evaluate(() => ({ ready: !!window.__game.ready, err: window.__game.error }));
  ok(`${label}: boots`, r.ready, r.err || '');
  if (!r.ready) { await ctx.close(); continue; }

  if (dev) {
    const box = await p.evaluate(() => {
      const n = document.querySelector('.dk-touch .dk-stick');
      if (!n) return null;
      const b = n.getBoundingClientRect();
      return { w: Math.round(b.width), inCanvas: !!n.closest('canvas') };
    });
    ok('phone: touch stick is laid out', box && box.w > 8 && !box.inCanvas, JSON.stringify(box));
  }

  await p.evaluate(() => window.__game.startRace(0));
  // hold the grid: nothing may move while the lights are red
  const drift = await p.evaluate(() => {
    const g = window.__game, v = g.race.player.vehicle;
    const s0 = { x: v.state.pos.x, z: v.state.pos.z };
    let worst = 0;
    for (let i = 0; i < 60 * 3; i++) { g.stepFrame(1 / 60);
      worst = Math.max(worst, Math.hypot(v.state.pos.x - s0.x, v.state.pos.z - s0.z)); }
    return { worst, phase: g.race.state.phase };
  });
  ok(`${label}: no creep under the red lights`, drift.worst < 0.3, `moved ${drift.worst.toFixed(3)} m`);

  const race = await p.evaluate(() => {
    const g = window.__game;
    for (let i = 0; i < 60 * 20; i++) g.stepFrame(1 / 60);
    const rs = g.race.racers;
    const opp = rs.filter(r => !r.isPlayer);
    return { phase: g.race.state.phase,
      opp: opp.reduce((a, r) => a + r.vehicle.state.speed, 0) / opp.length,
      player: g.race.player.vehicle.state.speed,
      moving: opp.filter(r => r.vehicle.state.speed > 3).length,
      drifts: rs.filter(r => r.vehicle.state.drift.active).length,
      furthest: Math.max(...rs.map(r => r.prog)) };
  });
  ok(`${label}: opponents race`, race.opp > 5, `mean ${(race.opp * 3.6).toFixed(1)} km/h, ${race.moving}/7 moving`);
  ok(`${label}: field is making progress`, race.furthest > 120, `${race.furthest.toFixed(0)} m`);
  ok(`${label}: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}
await b.close();
console.log('\n' + (fails ? `FAILED ${fails}` : 'it plays'));
process.exit(fails ? 1 : 0);
