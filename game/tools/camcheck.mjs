/**
 * Does anything sit between the chase camera and the player?
 *
 * popcheck flagged 8 pops in 13 frame pairs of oliveGrove while the telemetry over the same
 * frames was perfectly smooth - yaw -0.10..+0.16 rad/s, speed 60->72 km/h, camera 3.0-3.7 m a
 * frame. Smooth physics with popping pixels is not instability; it is something wrong in front
 * of the lens. Projecting every kart into screen space found it: the player sits rock steady at
 * 8.7-9.6 m and screen (638-654, 383-391), while the second-place rival rides 2.6-3.2 m from the
 * camera and projects to y=681, 817, 864 on a 720 px frame - at or past the bottom edge. The
 * chase camera has no rival avoidance and no near-plane push, so an overtaking kart smears across
 * the lower third of the screen.
 *
 * Still frames could not catch this: the canonical review views never happened to put a rival
 * there. It takes a sequence, or this.
 *
 *   node tools/camcheck.mjs [view]      # default oliveGrove
 *
 * Exits non-zero if a kart is nearer the camera than CAM_MIN_M, or if the player leaves the
 * middle of the frame (that would be camera lag - a different defect, and currently absent).
 */
import { chromium } from 'playwright';
const page = await (await (await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
})).newContext({ viewport: { width: 1280, height: 720 } })).newPage();
await page.goto('http://127.0.0.1:4173/?review=1&audio=0&q=high', { waitUntil: 'load', timeout: 240000 });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 300000 });
const VIEW = process.argv[2] || 'oliveGrove';
const MIN_M = +(process.env.CAM_MIN_M || 5.0);
let fails = 0;
await page.evaluate(v => window.__game.setView(v), VIEW);

for (let step = 0; step < 3; step++) {
  if (step) await page.evaluate(() => window.__game.simulate(0.48));
  await page.evaluate(() => window.__game.renderOnce && window.__game.renderOnce());
  const rows = await page.evaluate(() => {
    const g = window.__game, THREE = g.THREE, cam = g.engine.camera;
    const race = g.systems?.race || g.race;
    return race.racers.map(r => {
      const p = r.vehicle.state.pos;
      const v = new THREE.Vector3(p.x, p.y + 0.5, p.z);
      const dist = v.distanceTo(cam.position);
      v.project(cam);
      return { name: r.name, isPlayer: !!r.isPlayer, place: r.place,
        sx: Math.round((v.x * 0.5 + 0.5) * 1280), sy: Math.round((-v.y * 0.5 + 0.5) * 720),
        dist: +dist.toFixed(2), infront: v.z < 1 };
    }).sort((a, b) => a.dist - b.dist);
  });
  console.log(`\n--- t=${(step * 0.48).toFixed(2)}s  (screen 1280x720; sy>620 = bottom of frame) ---`);
  for (const r of rows.slice(0, 4)) {
    console.log(`  ${(r.isPlayer ? 'PLAYER ' : 'rival  ')}${String(r.name).padEnd(8)} p${r.place}  ${String(r.dist).padStart(7)} m  screen(${String(r.sx).padStart(5)},${String(r.sy).padStart(5)})${r.infront ? '' : '  [BEHIND CAMERA]'}`);
  }
  const player = rows.find(r => r.isPlayer);
  const bad = rows.find(r => !r.isPlayer && r.infront && r.dist < MIN_M);
  if (bad) { fails++; console.log('  [FAIL] ' + bad.name + ' is ' + bad.dist + ' m from the camera (< ' + MIN_M + ' m) at screen y=' + bad.sy); }
  if (player && (player.sx < 380 || player.sx > 900 || player.sy < 200 || player.sy > 560)) {
    fails++; console.log('  [FAIL] the player is not centred: screen(' + player.sx + ',' + player.sy + ') - camera lag');
  }
}
console.log((fails ? '\nFAILED ' + fails + ' - something is between the camera and the player'
                   : '\nnothing between the camera and the player'));
process.exit(fails ? 1 : 0);
