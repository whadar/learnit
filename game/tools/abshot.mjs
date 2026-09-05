/**
 * A/B diagnostic harness (scratch). Boots the game once, then shoots the same view several
 * times with one piece of the image stack switched off, so an artefact can be attributed to
 * the pass that actually emits it instead of guessed at.
 *
 *   ABSHOT_VIEW=photoFinish node tools/abshot.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = process.env.SHOOT_URL || 'http://127.0.0.1:4173/';
const QUERY = process.env.SHOOT_QUERY ?? 'review=1&audio=0&q=high';
const OUT = process.env.SHOOT_OUT || 'shots/ab';
const VIEW = process.env.ABSHOT_VIEW || 'photoFinish';
const W = +(process.env.SHOOT_W || 1280), H = +(process.env.SHOOT_H || 720);
const WARM = +(process.env.SHOOT_WARM || 8);

const url = BASE + (QUERY ? (BASE.includes('?') ? '&' : '?') + QUERY : '');
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('[pageerror]', e.message));
const settle = f => page.evaluate(n => new Promise(res => {
  let i = 0; const step = () => (++i >= n ? res() : requestAnimationFrame(step)); requestAnimationFrame(step);
}), f);

await page.goto(url, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 600000 });

// name -> body of a function run in the page before the shot
const VARIANTS = JSON.parse(process.env.ABSHOT_VARIANTS || 'null') || {
  base: '',
  nobloom: 'g.systems.post.params.bloomStrength = 0;',
  noclouds: 'g.systems.sky.uniforms.uCloudOpacity.value = 0;',
  nodof: 'g.systems.post.params.dofMax = 0;',
  nograde: 'g.systems.post.setGradeEnabled(false);',
};

for (const [name, body] of Object.entries(VARIANTS)) {
  await page.evaluate(src => {
    const g = window.__game;
    // eslint-disable-next-line no-new-func
    new Function('g', src)(g);
  }, body);
  await page.evaluate(n => window.__game.setView(n), VIEW);
  await settle(WARM);
  const f = path.join(OUT, `${VIEW}-${name}.png`);
  await page.screenshot({ path: f, timeout: 180000 });
  console.log('wrote', f);
}
await browser.close();
