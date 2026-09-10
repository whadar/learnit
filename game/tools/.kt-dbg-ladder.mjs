import { chromium } from 'playwright';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const url = (process.env.SHOOT_URL || 'http://127.0.0.1:4173/') + '?review=1&audio=0&q=high';
const OUT='/tmp/claude-0/-home-user-learnit/8f6205af-22db-552b-aca3-2d3962bb4285/scratchpad/';
const browser = await chromium.launch({ executablePath: CHROME,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(300000);
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 600000 });
const settle = n => page.evaluate(k => new Promise(r => { let i=0; const s=()=>(++i>=k?r():requestAnimationFrame(s)); requestAnimationFrame(s); }), n);
await page.evaluate(() => window.__game.setView('gridStart'));
await settle(10);
await page.evaluate(() => {
  const sh = window.__game.engine.lighting.sun.shadow;
  window.__b = 0; window.__nb = 0;
  Object.defineProperty(sh, 'bias', { get: () => window.__b, set: () => {}, configurable: true });
  Object.defineProperty(sh, 'normalBias', { get: () => window.__nb, set: () => {}, configurable: true });
});
for (const [b, nb, tag] of [[0,0,'b0'], [-0.00002,0.02,'bsmall'], [0.0005,0,'p0005'], [0.002,0,'p002']]) {
  await page.evaluate(([b,nb]) => { window.__b = b; window.__nb = nb; window.__game.engine.renderer.shadowMap.needsUpdate = true; }, [b,nb]);
  await settle(8);
  await page.screenshot({ path: OUT+'lad_'+tag+'.png', timeout: 300000 });
  console.log('shot', tag);
}
await browser.close();
