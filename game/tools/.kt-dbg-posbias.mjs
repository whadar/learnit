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
console.log(await page.evaluate(() => {
  const L = window.__game.engine.lighting;
  L.sun.shadow.bias = 0.05;      // absurd positive bias -> everything should go into shadow
  L.sun.shadow.normalBias = 0;
  window.__game.engine.renderer.shadowMap.needsUpdate = true;
  // stop lighting.update from re-fitting/overwriting bias
  L.update = () => {};
  return 'bias=' + L.sun.shadow.bias;
}));
await settle(6);
await page.evaluate(() => { const L = window.__game.engine.lighting; L.sun.shadow.bias = 0.05; L.sun.shadow.normalBias = 0; });
await settle(4);
await page.screenshot({ path: OUT+'dbg_posbias.png', timeout: 300000 });
await browser.close();
