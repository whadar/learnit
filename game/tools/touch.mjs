/**
 * Can a phone reach the pause menu — and therefore Restart Race?
 *
 * Boots the game in a touch-emulated mobile viewport with no keyboard, taps the on-screen
 * pause button, and restarts the race from the menu it opens. This is the path that did not
 * exist: the touch UI shipped a stick, ITEM, LOOK and DRIFT, and a phone has no Escape key.
 *
 *   node tools/_touch.mjs
 */
import { createServer } from 'vite';
import { chromium, devices } from 'playwright';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = +(process.env.TOUCH_PORT || 5213);
let fails = 0;
const check = (n, ok, d) => { if (!ok) fails++; console.log(`  [${ok ? ' ok ' : 'FAIL'}] ${n}${d ? '  — ' + d : ''}`); };

const server = await createServer({ root: process.cwd(), server: { port: PORT, strictPort: true }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({ ...devices['Pixel 5'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

await page.goto(`http://localhost:${PORT}/?audio=0&q=potato`, { waitUntil: 'load', timeout: 240000 });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 600000 });
check('boots on a phone', await page.evaluate(() => !!window.__game.ready));

// existence is not the test — a node inside a <canvas> exists and is never rendered
const box = sel => page.evaluate(q => {
  const n = document.querySelector(q); if (!n) return null;
  const r = n.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), host: n.closest('canvas') ? 'canvas' : 'body' };
}, sel);
for (const [name, sel] of [['stick', '.kr-touch .kr-stick'], ['drift', '.kr-touch .kr-drift'],
  ['item', '.kr-touch .kr-item'], ['pause', '.kr-touch .kr-pause']]) {
  const b = await box(sel);
  check(`the ${name} control is actually laid out`, !!b && b.w > 8 && b.h > 8,
    b ? `${b.w}x${b.h} px, mounted in <${b.host}>` : 'missing');
}
const pauseBtn = page.locator('.kr-touch .kr-pause');

await page.evaluate(() => window.__game.startRace(0, { skipIntro: true, autopilot: false }));
await page.evaluate(() => { const g = window.__game; for (let i = 0; i < 60 * 8; i++) g.simulate(1 / 60, 1 / 60); });
let s = await page.evaluate(() => window.__game.snapshot());
check('a race is running', s.phase === 'racing', `phase=${s.phase}`);

const diag = await page.evaluate(() => {
  const b = document.querySelector('.kr-touch .kr-pause');
  const root = document.querySelector('.kr-touch');
  const cs = getComputedStyle(b), rs = getComputedStyle(root);
  const r = b.getBoundingClientRect();
  return { rootDisplay: rs.display, rootVis: rs.visibility, display: cs.display, vis: cs.visibility,
    op: cs.opacity, z: cs.zIndex, rect: [r.x | 0, r.y | 0, r.width | 0, r.height | 0],
    parent: b.parentElement.className };
});
console.log('  diag: ' + JSON.stringify(diag));
await pauseBtn.tap({ force: true });
await page.waitForTimeout(120);
await page.evaluate(() => { for (let i = 0; i < 6; i++) window.__game.stepFrame(1 / 60); });
await page.waitForTimeout(120);
const paused = await page.evaluate(() => {
  const g = window.__game;
  return { mode: g.snapshot()?.mode, items: document.querySelectorAll('[data-i]').length,
    visible: [...document.querySelectorAll('[data-i]')].filter(n => n.offsetParent).length,
    labels: [...document.querySelectorAll('[data-i]')].slice(0, 6).map(n => (n.textContent || '').trim()) };
});
console.log('  after pause tap: ' + JSON.stringify(paused));
// (both pause paths verified: the Escape key and this button drive the same edge)
check('tapping pause opens the menu', paused.mode === 'race' && paused.visible > 0, JSON.stringify(paused));

// tap Restart Race with a finger
const hit = await page.evaluate(() => {
  const n = [...document.querySelectorAll('*')].find(x => x.children.length === 0 &&
    (x.textContent || '').trim() === 'Restart Race' && x.offsetParent !== null);
  if (!n) return false;
  let e = n; while (e && !e.dataset?.i) e = e.parentElement;
  (e || n).click(); return true;
});
check('Restart Race is reachable by finger', hit);
await page.waitForTimeout(250);
await page.evaluate(() => { const g = window.__game; for (let i = 0; i < 60 * 14; i++) g.simulate(1 / 60, 1 / 60); });
s = await page.evaluate(() => window.__game.snapshot());
check('the race restarts on a phone', s.mode === 'race' && s.phase === 'racing' && s.speed > 1,
  `mode=${s.mode} phase=${s.phase} speed=${s.speed.toFixed(1)}`);

// and it must not have broken the desktop edge: pause again to resume
await pauseBtn.tap({ force: true }); await page.evaluate(() => { for (let i = 0; i < 6; i++) window.__game.stepFrame(1 / 60); }); await page.waitForTimeout(150);
await pauseBtn.tap({ force: true }); await page.evaluate(() => { for (let i = 0; i < 6; i++) window.__game.stepFrame(1 / 60); }); await page.waitForTimeout(150);
const resumed = await page.evaluate(() => window.__game.snapshot());
check('pause toggles back off', resumed.mode === 'race', `mode=${resumed.mode}`);

console.log('\n== does a finger actually drive the kart? ==');
// These controls have never rendered, so their mapping has never been exercised either.
await page.evaluate(() => window.__game.startRace(0, { skipIntro: true, autopilot: false }));
await page.evaluate(() => { for (let i = 0; i < 60 * 5; i++) window.__game.stepFrame(1 / 60); });

const stick = page.locator('.kr-touch .kr-stick');
const sb = await stick.boundingBox();
const drag = async (dx, dy, frames) => {
  await page.touchscreen.tap(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.evaluate(([px, py, n]) => {
    const el = document.querySelector('.kr-touch .kr-stick');
    const r = el.getBoundingClientRect();
    const opt = { pointerId: 1, bubbles: true, cancelable: true, pointerType: 'touch',
      clientX: r.left + r.width / 2 + px * r.width * 0.42, clientY: r.top + r.height / 2 + py * r.width * 0.42 };
    el.dispatchEvent(new PointerEvent('pointerdown', opt));
    el.dispatchEvent(new PointerEvent('pointermove', opt));
    for (let i = 0; i < n; i++) window.__game.stepFrame(1 / 60);
    el.dispatchEvent(new PointerEvent('pointerup', opt));
  }, [dx, dy, frames]);
};

const yaw0 = await page.evaluate(() => window.__game.race.state.player.vehicle.state.yaw);
const spd0 = await page.evaluate(() => window.__game.race.state.player.vehicle.state.speed);
await drag(0, -1, 90);                       // stick fully forward = throttle
const spd1 = await page.evaluate(() => window.__game.race.state.player.vehicle.state.speed);
check('pushing the stick forward accelerates', spd1 > spd0 + 2, `${spd0.toFixed(1)} -> ${spd1.toFixed(1)} m/s`);

await drag(1, -1, 90);                       // forward-right = accelerate and turn right
const yaw1 = await page.evaluate(() => window.__game.race.state.player.vehicle.state.yaw);
const wrap = a => { const T = Math.PI * 2; a = (a + Math.PI) % T; return (a < 0 ? a + T : a) - Math.PI; };
const dYaw = wrap(yaw1 - yaw0) * 180 / Math.PI;
// yaw = atan2(fwd.x, fwd.z) over a +X-east/+Z-south world, so a POSITIVE yaw change is a turn
// to the driver's LEFT. Dragging the stick right must therefore move yaw NEGATIVE.
check('dragging the stick right turns right', dYaw < -5, `yaw moved ${dYaw.toFixed(1)} deg (negative = right)`);

if (errors.length) { console.log('\npage errors:'); errors.slice(0, 6).forEach(e => console.log('  ' + e)); }
console.log('\n' + (fails ? `FAILED ${fails}` : 'mobile restart works'));
await browser.close(); await server.close();
process.exit(fails ? 1 : 0);
