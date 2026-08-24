/**
 * Motion capture for review — the half of the game still frames cannot show.
 *
 * Eight rounds of critics scored single screenshots, so nothing that only exists over time was
 * ever reviewed: camera lag, LOD popping, how a drift reads as it develops, whether the sense
 * of speed lands. A human playing the build for one minute found two defects (inverted
 * steering, an audio burst) that every one of those rounds had missed, because both live in
 * time rather than in a frame.
 *
 * This drives the real game deterministically and captures a SEQUENCE per scenario, so a critic
 * can look at motion instead of a pose. Frames are stepped on the fixed timestep the review
 * harness already uses, so two runs of the same scenario produce the same strip.
 *
 *   node tools/shoot-seq.mjs
 *
 *   SEQ_URL     base URL                        (http://127.0.0.1:4173/)
 *   SEQ_OUT     output directory                (shots/seq)
 *   SEQ_SCENES  comma-separated scenario names  (driftCorner,villageStreet,oliveGrove,itemChaos)
 *   SEQ_FRAMES  frames per scenario             (10)
 *   SEQ_STEP    seconds of game time per frame  (0.1)
 *   SEQ_W/H     viewport                        (1280x720)
 *   SEQ_VIDEO   1 = also record a webm per scenario (0)
 *   SEQ_SHOT_TIMEOUT  ms allowed per screenshot     (240000 — SwiftShader is slow)
 *
 * Writes <out>/<scene>/f00.png … and <out>/<scene>/telemetry.json (speed, yaw rate, drift
 * angle and camera position per frame), so a reviewer can correlate what it sees with what the
 * physics was doing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.SEQ_URL || 'http://127.0.0.1:4173/';
const OUT = process.env.SEQ_OUT || 'shots/seq';
const SCENES = (process.env.SEQ_SCENES || 'driftCorner,villageStreet,oliveGrove,itemChaos')
  .split(',').map(s => s.trim()).filter(Boolean);
const FRAMES = +(process.env.SEQ_FRAMES || 10);
const STEP = +(process.env.SEQ_STEP || 0.1);
const W = +(process.env.SEQ_W || 1280), H = +(process.env.SEQ_H || 720);
const VIDEO = process.env.SEQ_VIDEO === '1';
const SHOT_TIMEOUT = +(process.env.SEQ_SHOT_TIMEOUT || 240000);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  ...(VIDEO ? { recordVideo: { dir: path.join(OUT, '_video'), size: { width: W, height: H } } } : {}),
});
const page = await ctx.newPage();
// SwiftShader draws a 1280x720 frame of this scene in well over Playwright's default 30 s
// screenshot timeout, so every capture died on frame 0 with a TimeoutError and the tool wrote
// nothing at all. Software rasterisation is the whole point of this harness — give it room.
page.setDefaultTimeout(SHOT_TIMEOUT);
const errors = [];
page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));

await page.goto(`${BASE}?review=1&audio=0&q=high`, { waitUntil: 'load', timeout: 240000 });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error),
  null, { timeout: 300000 });
const bootErr = await page.evaluate(() => window.__game?.error || null);
if (bootErr) { console.error('boot failed:', bootErr); await browser.close(); process.exit(1); }

/** Everything the physics knows at this instant, so motion can be read against numbers. */
const SAMPLE = `(() => {
  const g = window.__game, s = g.systems || {};
  const v = s.race && s.race.state && s.race.state.player && s.race.state.player.vehicle;
  const st = v && v.state;
  const cam = g.engine && g.engine.camera;
  return {
    speedKmh: v ? +(v.speed * 3.6).toFixed(1) : null,
    yawRate: st ? +(st.angVel ? st.angVel.y : 0).toFixed(3) : null,
    driftDeg: st ? +(st.driftSlipDeg || 0).toFixed(1) : null,
    driftTier: st && st.drift ? st.drift.tier : null,
    boost: st && st.boost ? +(st.boost.time || 0).toFixed(2) : null,
    surface: st ? (st.surface || null) : null,
    cam: cam ? [ +cam.position.x.toFixed(2), +cam.position.y.toFixed(2), +cam.position.z.toFixed(2) ] : null,
    fov: cam ? +cam.fov.toFixed(2) : null,
  };
})()`;

let shot = 0;
for (const scene of SCENES) {
  const dir = path.join(OUT, scene);
  fs.mkdirSync(dir, { recursive: true });

  // Scenarios are reached through setView(); each named view carries its own scenario setup.
  const ok = await page.evaluate(async name => {
    const g = window.__game;
    if (!g.setView) return 'no .setView() hook';
    if (!g.views || !g.views[name]) return `unknown view "${name}" (have: ${Object.keys(g.views || {}).join(', ')})`;
    try { await g.setView(name); } catch (e) { return String(e && e.message || e); }
    return null;
  }, scene);
  if (ok) { console.log(`${scene.padEnd(16)} SKIP — ${ok}`); continue; }

  const telemetry = [];
  for (let i = 0; i < FRAMES; i++) {
    // Advance game time by a fixed step, then render — deterministic and independent of how
    // slowly the software rasteriser actually draws.
    if (i > 0) {
      await page.evaluate(dt => window.__game.simulate ? window.__game.simulate(dt) : null, STEP);
    }
    await page.evaluate(() => window.__game.renderOnce && window.__game.renderOnce());
    telemetry.push({ frame: i, t: +(i * STEP).toFixed(3), ...(await page.evaluate(SAMPLE)) });
    await page.screenshot({ path: path.join(dir, `f${String(i).padStart(2, '0')}.png`), timeout: SHOT_TIMEOUT });
    shot++;
  }
  fs.writeFileSync(path.join(dir, 'telemetry.json'), JSON.stringify(telemetry, null, 1));

  const spd = telemetry.map(t => t.speedKmh).filter(v => v != null);
  const yaw = telemetry.map(t => t.yawRate).filter(v => v != null);
  console.log(`${scene.padEnd(16)} ${FRAMES} frames @ ${STEP}s`
    + (spd.length ? `  speed ${Math.min(...spd)}-${Math.max(...spd)} km/h` : '')
    + (yaw.length ? `  yawRate ${Math.min(...yaw).toFixed(2)}..${Math.max(...yaw).toFixed(2)} rad/s` : ''));
}

console.log(`\n${shot} frames into ${OUT}/`);
if (errors.length) console.log('page errors:', [...new Set(errors)].slice(0, 4));
await ctx.close();
await browser.close();
