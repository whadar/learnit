import { chromium } from 'playwright';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const url = (process.env.SHOOT_URL || 'http://127.0.0.1:4173/') + '?review=1&audio=0&q=high';
const browser = await chromium.launch({ executablePath: CHROME,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(300000);
page.on('console', m => { const t=m.text(); if (/lighting|contact/i.test(t)) console.log('[c]', t.slice(0,300)); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 600000 });
const settle = n => page.evaluate(k => new Promise(r => { let i=0; const s=()=>(++i>=k?r():requestAnimationFrame(s)); requestAnimationFrame(s); }), n);
await page.evaluate(() => window.__game.setView('gridStart'));
await settle(40);
console.log(await page.evaluate(() => {
  const S = window.__game.engine.scene;
  let inst=null, racers=0;
  S.traverse(o => { if (o.name === 'lighting:contact') inst = o; if (/^racer:/.test(o.name||'')) racers++; });
  const m = inst && new (window.__game.engine.camera.matrixWorld.constructor)();
  let first = null;
  if (inst && inst.count > 0) { inst.getMatrixAt(0, m); first = Array.from(m.elements).map(v=>+v.toFixed(2)); }
  return JSON.stringify({ found: !!inst, count: inst && inst.count, racers, visible: inst && inst.visible,
    blending: inst && inst.material.blending, transparent: inst && inst.material.transparent,
    hasMap: !!(inst && inst.material.map), first });
}));
await browser.close();
