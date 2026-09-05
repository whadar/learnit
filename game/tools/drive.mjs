/**
 * Kat Racing — scripted drive test.
 *
 * Boots the real built game headless and drives the *player's* kart through a full three-lap
 * race with scripted input (not the AI: a small pursuit controller injected from here, going
 * through exactly the same `race.setInput()` path a human keyboard does), then asserts that
 * the race actually finished with sane lap times and a sane finishing order.
 *
 *   npx vite preview --port 4173 --strictPort --host 127.0.0.1 &
 *   node tools/drive.mjs
 *   DRIVE_MAX=900 DRIVE_Q=potato node tools/drive.mjs
 *
 * Exits non-zero if the race does not complete, if anyone DNFs, if lap times are implausible
 * or if the page threw.
 */
import { chromium } from 'playwright';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = process.env.DRIVE_URL || 'http://127.0.0.1:4173/';
const QTIER = process.env.DRIVE_Q || 'potato';        // the drive test is about logic, not pixels
const MAX = +(process.env.DRIVE_MAX || 900);          // simulated seconds before we give up
const url = `${BASE}?review=1&audio=0&q=${QTIER}`;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 600000 });
const boot = await page.evaluate(() => ({ ready: window.__game.ready, error: window.__game.error, warnings: window.__game.warnings || [] }));
if (!boot.ready) { console.error('boot failed:', boot.error); await browser.close(); process.exit(2); }
if (boot.warnings.length) console.log('warnings:', boot.warnings);

/* -------------------------------------------------- install the pilot ---- */
await page.evaluate(() => {
  const g = window.__game;
  const trk = g.track;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const wrap = a => { const T = Math.PI * 2; a = (a + Math.PI) % T; return (a < 0 ? a + T : a) - Math.PI; };

  /**
   * A pure pursuit controller: find where we are on the circuit, aim at a point down the
   * road, steer at it, lift for tight corners, hop into a drift when the corner is long
   * enough to charge a mini-turbo, and fire an item whenever one turns up.
   */
  const inp = { throttle: 0, brake: 0, steer: 0, drift: 0, item: 0, look: 0 };
  let driftT = 0, itemT = 0;
  g.__pilot = (dt) => {
    const r = g.race.state.player;
    if (!r) return inp;
    const st = r.vehicle.state;
    let n; try { n = trk.nearest(st.pos); } catch (e) { return inp; }
    const speed = st.speed;
    const ahead = 8 + speed * 0.62;
    const a = trk.sample(n.s + ahead);
    // steer at the aim point, pulled back toward the centreline so we do not wander wide
    const tx = a.pos.x - a.normal.x * clamp(n.lateral * 0.55, -3.5, 3.5) - st.pos.x;
    const tz = a.pos.z - a.normal.z * clamp(n.lateral * 0.55, -3.5, 3.5) - st.pos.z;
    const err = wrap(Math.atan2(tx, tz) - st.yaw);
    inp.steer = clamp(err * 2.1, -1, 1);

    // corner severity from the curvature a little further on
    const b = trk.sample(n.s + ahead + 26);
    const turn = Math.abs(wrap(Math.atan2(b.tangent.x, b.tangent.z) - Math.atan2(a.tangent.x, a.tangent.z)));
    const vmax = 9 + 46 * Math.exp(-turn * 3.4);
    inp.throttle = speed < vmax ? 1 : 0.25;
    inp.brake = speed > vmax * 1.22 ? 1 : 0;

    // drift through anything sustained
    const want = turn > 0.30 && speed > 11 && Math.abs(inp.steer) > 0.3;
    driftT = want ? driftT + dt : 0;
    inp.drift = driftT > 0.10 && st.onTrack !== false ? 1 : 0;
    if (inp.drift && st.drift.active) inp.steer = clamp(inp.steer * 1.15, -1, 1);

    itemT += dt;
    inp.item = itemT > 2.2 ? 1 : 0;
    if (itemT > 2.4) itemT = 0;
    return inp;
  };
  g.setScripted(g.__pilot(1 / 60));
});

/* ------------------------------------------------------------- the race -- */
await page.evaluate(() => {
  const g = window.__game;
  g.startRace(0, { skipIntro: true, autopilot: false });
  g.setScripted(g.__pilot(1 / 60));
});

const t0 = Date.now();
let simT = 0, laps = [];
while (simT < MAX) {
  const r = await page.evaluate(() => {
    const g = window.__game, dt = 1 / 60;
    // 10 simulated seconds per round trip, re-reading the pilot every physics frame
    for (let i = 0; i < 600; i++) {
      g.setScripted(g.__pilot(dt));
      g.simulate(dt, dt);
      if (g.race.state.over) break;
    }
    return g.snapshot();
  });
  simT = r.raceTime;
  const p = r.standings.find(x => x.name === r.standings[0].name);
  void p;
  if (laps.length !== (r.lap || 0)) { laps = new Array(r.lap || 0).fill(0); }
  process.stdout.write(`\r  t=${simT.toFixed(0)}s  phase=${r.phase}  player lap ${r.lap} place ${r.place}  ${(r.speed * 3.6).toFixed(0)} km/h   `);
  if (r.over || r.phase === 'results') break;
}
process.stdout.write('\n');

const snap = await page.evaluate(() => window.__game.snapshot());
const wall = ((Date.now() - t0) / 1000).toFixed(1);
await browser.close();

/* -------------------------------------------------------------- verdict -- */
const res = snap.results || [];
console.log(`\nsimulated ${snap.raceTime.toFixed(1)} s of racing in ${wall} s wall clock  (phase ${snap.phase})\n`);
console.log('  ' + 'P'.padEnd(3) + 'racer'.padEnd(10) + 'total'.padStart(10) + 'best lap'.padStart(11) + '  laps');
for (const r of res) {
  const t = v => (Number.isFinite(v) ? `${Math.floor(v / 60)}:${(v % 60).toFixed(2).padStart(5, '0')}` : '   —  ');
  console.log('  ' + String(r.place).padEnd(3) + String(r.name).padEnd(10) + t(r.time).padStart(10) + t(r.best).padStart(11)
    + '  ' + r.laps + (r.dnf ? '  DNF' : ''));
}

let fail = 0;
const check = (name, ok, detail = '') => { if (!ok) fail++; console.log(`  [${ok ? ' ok ' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`); };
console.log('');
check('race reached results', snap.phase === 'results' || snap.over === true, 'phase ' + snap.phase);
check('every kart finished', res.length > 0 && res.every(r => !r.dnf && r.laps >= 3), res.filter(r => r.dnf).map(r => r.name).join(',') || '');
check('eight karts classified', res.length === 8, String(res.length));
check('places are 1..n with no gaps', res.every((r, i) => r.place === i + 1));
check('lap times are plausible', res.every(r => r.best > 45 && r.best < 400), res.map(r => (r.best || 0).toFixed(0)).join(','));
check('winner is not last on the road', res[0] && res[0].time <= res[res.length - 1].time);
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
process.exit(fail ? 1 : 0);
