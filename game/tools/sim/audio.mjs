/**
 * Headless verification for the audio system.
 *
 * Node has no WebAudio, so this boots a Vite dev server plus headless Chromium and renders the
 * real graph through an OfflineAudioContext (no audio device needed), then asserts on RMS,
 * peak, spectral centroid, fundamental, duration, tempo and loop continuity.
 *
 *   node tools/sim/audio.mjs           # full sweep
 *   node tools/sim/audio.mjs --quick   # shorter renders
 *   node tools/sim/audio.mjs --json    # machine-readable
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createAudio } from '../../src/audio/audio.js';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = +(process.env.AUDIO_SIM_PORT || 5199);
const QUICK = process.argv.includes('--quick');
const JSONOUT = process.argv.includes('--json');

const pad = (s, n) => String(s).padEnd(n);
const fmt = v => (typeof v === 'number' ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(4)) : String(v));

let fails = 0;
function check(name, ok, detail) {
  if (!ok) fails++;
  if (!JSONOUT) console.log(`  [${ok ? ' ok ' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

/* ---------------------------------------------- 1. node: the no-audio-device contract --- */
if (!JSONOUT) console.log('\n== blocked-context safety (no WebAudio in node) ==');
{
  const a = createAudio({ character: 'mitzi' });
  let threw = null;
  try {
    a.init({ pos: [0, 0, 0] });
    for (let i = 0; i < 20; i++) a.update(1 / 60, { vehicle: { speed: 20, rpm: 0.8, throttle: 1, surface: 'gravel', drift: { tier: 2 }, boost: { time: 1 } }, race: { phase: 'racing', lap: 3, laps: 3 } });
    a.play('boost'); a.play('finish_fanfare'); a.setMusicIntensity(1); a.setMasterVolume(0.5);
    a.suspend(); a.resume(); a.dispose();
  } catch (e) { threw = e; }
  check('createAudio + init + update + play never throw without a device', !threw, threw ? String(threw.message) : '');
  check('blocked flag is set', a.blocked === true);
  check('play() returns null when blocked', a.play('boost') === null);
  check('exports the documented api', ['init', 'update', 'play', 'setMusicIntensity', 'setMasterVolume', 'suspend', 'resume', 'dispose']
    .every(k => typeof a[k] === 'function'));
}

/* ------------------------------------------------- 2. browser: offline render + measure --- */
const server = await createServer({
  configFile: false, root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: PORT, strictPort: false },   // other agents may hold the port
});
await server.listen();
const base = (server.resolvedUrls?.local?.[0] || `http://127.0.0.1:${PORT}/`).replace(/\/$/, '');

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio'],
});
const page = await browser.newPage();
page.setDefaultTimeout(600000);
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.stack || e.message}`));

let out = null, error = null;
try {
  await page.goto(`${base}/preview/audio.html?mode=api`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__audioTest, null, { timeout: 120000 });
  out = await page.evaluate(q => window.__audioTest.run({ quick: q }), QUICK);
} catch (e) {
  error = e;
}
await browser.close();
await server.close();

if (error) {
  console.error('audio sim failed to run:', error.message);
  console.error(logs.slice(-20).join('\n'));
  process.exit(2);
}

if (JSONOUT) {
  console.log(JSON.stringify(out, null, 1));
  process.exit(out.pass && fails === 0 ? 0 : 1);
}

/* ------------------------------------------------------------------------- report --- */
const D = out.data;
console.log('\n== cues (rendered through the real bus: panner -> reverb -> compressor -> limiter) ==');
console.log('  ' + pad('cue', 18) + pad('peak', 9) + pad('rms', 9) + pad('rmsdB', 8) + pad('dur s', 8) + pad('centroid', 10) + 'f0');
for (const [id, a] of Object.entries(D.cues)) {
  console.log('  ' + pad(id, 18) + pad(fmt(a.peak), 9) + pad(fmt(a.rms), 9) + pad(a.rmsDb, 8) + pad(a.dur, 8) + pad(a.centroid + ' Hz', 10) + (a.f0conf > 0.35 ? a.f0 + ' Hz' : '-'));
}

console.log('\n== engine ==');
console.log('  ' + pad('rpm', 8) + pad('fires @', 10) + pad('measured', 10) + pad('rms', 9) + 'centroid');
for (const e of D.engine) console.log('  ' + pad(e.rpm, 8) + pad(e.expectedHz + ' Hz', 10) + pad(e.firing + ' Hz', 10) + pad(fmt(e.rms), 9) + e.centroid + ' Hz');

console.log('\n== surfaces (20 m/s) ==');
console.log('  ' + pad('surface', 14) + pad('rms', 9) + pad('peak', 9) + 'centroid');
for (const [s, a] of Object.entries(D.surfaces)) console.log('  ' + pad(s, 14) + pad(fmt(a.rms), 9) + pad(fmt(a.peak), 9) + a.centroid + ' Hz');

console.log('\n== music ==');
for (const [k, m] of Object.entries(D.music)) {
  console.log('  ' + pad(k, 6) + `bpm=${m.bpm.toFixed(1)} measured=${m.measuredBpm} onsets=${m.onsets} rms=${fmt(m.rms)} (${m.rmsDb} dB) peak=${fmt(m.peak)} centroid=${m.centroid} Hz`);
}
console.log('\n== mixed race scene ==');
console.log(`  peak=${fmt(D.scene.peak)} rms=${fmt(D.scene.rms)} (${D.scene.rmsDb} dB) centroid=${D.scene.centroid} Hz`);
console.log(`  pile-up peak=${fmt(D.pile.peak)}`);

console.log('\n== assertions ==');
for (const r of out.rows) check(r.name, r.ok, r.detail);

const total = out.rows.length + 4;
console.log(`\n${fails ? 'FAILED' : 'PASSED'}  ${total - fails}/${total} checks`);
if (logs.length && fails) console.log(logs.slice(-10).join('\n'));
process.exit(fails ? 1 : 0);
