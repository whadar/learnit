/**
 * Live pack probe — boots the *built* game exactly as tools/shoot.mjs does, seeds each
 * canonical review scenario, and dumps where the eight karts are and which of them the real
 * chase camera can actually see. No screenshots, so one boot answers a whole tuning round.
 *
 *   npx vite build && npx vite preview --port 4173 &
 *   node tools/probe/pack.mjs [view ...]
 *
 * The number that matters is `inFrame`: a review plate of a kart racer with nothing in it but
 * the player's own bumper is a failed plate however pretty the light is.
 */
import { chromium } from 'playwright';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = process.env.SHOOT_URL || 'http://127.0.0.1:4173/';
const QUERY = process.env.SHOOT_QUERY ?? 'review=1&audio=0&q=high';
const VIEWS = (process.argv.slice(2).length ? process.argv.slice(2)
  : ['gridStart', 'villageStreet', 'oliveGrove', 'driftCorner', 'itemChaos', 'photoFinish', 'hilltopVista']);

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.error('[pageerror]', e.message));
await page.goto(BASE + (BASE.includes('?') ? '&' : '?') + QUERY, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 600000 });
const err = await page.evaluate(() => window.__game?.error || null);
if (err) { console.error('GAME ERROR:', err); await browser.close(); process.exit(2); }

for (const v of VIEWS) {
  const dump = await page.evaluate(name => {
    const g = window.__game, T = g.THREE;
    g.setView(name);
    const race = g.race, trk = g.track, L = trk.length;
    const cam = g.engine.camera;
    cam.updateMatrixWorld(true);
    const fr = new T.Frustum().setFromProjectionMatrix(
      new T.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const p = race.state.player;
    const dS = (a, b) => { let d = a - b; while (d > L / 2) d -= L; while (d < -L / 2) d += L; return d; };
    const eye = cam.position;
    const rows = race.racers.map(r => {
      const s = r.vehicle.state;
      const c = new T.Vector3(s.pos.x, s.pos.y + 0.4, s.pos.z);
      const sph = new T.Sphere(c, 1.1);
      return {
        name: r.name, place: r.place, gap: +dS(r.s, p.s).toFixed(1), lat: +(r.lateral ?? 0).toFixed(1),
        kmh: +(s.speed * 3.6).toFixed(0), onTrack: s.onTrack !== false,
        dist: +c.distanceTo(eye).toFixed(1), seen: fr.intersectsSphere(sph), player: r.isPlayer,
      };
    }).sort((a, b) => b.gap - a.gap);
    const h = race.hud();
    return {
      view: name, t: +race.state.raceTime.toFixed(2), phase: race.state.phase,
      camMode: g.camera.mode, pose: g.camera.pose(),
      hud: { lap: h.lap, laps: h.laps, place: h.place, total: +h.time.toFixed(2), lapT: +h.lapTime.toFixed(2) },
      rows,
    };
  }, v);

  const seen = dump.rows.filter(r => r.seen && !r.player).length;
  const near = dump.rows.filter(r => !r.player && r.dist < 3.2).length;
  console.log(`\n${dump.view}  t=${dump.t}s ${dump.phase} cam=${dump.camMode}  ` +
    `HUD lap ${dump.hud.lap}/${dump.hud.laps} P${dump.hud.place} total ${dump.hud.total} lap ${dump.hud.lapT}  ` +
    `| rivals in frustum: ${seen}${near ? '  NEAR-PLANE: ' + near : ''}`);
  for (const r of dump.rows) {
    console.log(`   ${r.gap >= 0 ? '+' : ''}${String(r.gap).padStart(6)} m  lat ${String(r.lat).padStart(5)}  ` +
      `${String(r.kmh).padStart(3)} km/h  ${r.dist.toFixed(0).padStart(3)} m from lens  P${r.place}  ` +
      `${r.name}${r.player ? ' (player)' : ''}${r.onTrack ? '' : '  OFF'}${r.seen && !r.player ? '   <-- in frame' : ''}`);
  }
}
await browser.close();
