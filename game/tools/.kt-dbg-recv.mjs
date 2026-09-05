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
await settle(8);
console.log(await page.evaluate(() => {
  const S = window.__game.engine.scene;
  const off = [];
  S.traverse(o => { if (o.isMesh && o.visible && !o.receiveShadow) { if (off.length<50) off.push(o.name||'(unnamed)'); o.receiveShadow = true; } });
  // also make single-sided materials render front faces into the shadow map
  const seen = new Set();
  S.traverse(o => { if (!o.isMesh || !o.material) return; const ms = Array.isArray(o.material)?o.material:[o.material];
    for (const m of ms) { if (!m || seen.has(m)) continue; seen.add(m); m.shadowSide = 2; m.needsUpdate = true; } });
  window.__game.engine.renderer.shadowMap.needsUpdate = true;
  return JSON.stringify(off);
}));
await settle(12);
await page.screenshot({ path: OUT+'dbg_recv.png', timeout: 300000 });
await browser.close();
