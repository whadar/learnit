import { chromium } from 'playwright';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT = '/tmp/claude-0/-home-user-learnit/8f6205af-22db-552b-aca3-2d3962bb4285/scratchpad';
const browser = await chromium.launch({ executablePath: CHROME,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1'] });
const page = await browser.newPage({ viewport:{width:1280,height:720}, deviceScaleFactor:1 });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:4188/?review=1&audio=0&q=high', { waitUntil:'load', timeout:180000 });
await page.waitForFunction(() => window.__game && (window.__game.ready||window.__game.error), null, {timeout:600000});
const settle = n => page.evaluate(k => new Promise(r=>{let i=0;const s=()=>(++i>=k?r():requestAnimationFrame(s));requestAnimationFrame(s);}), n);
await page.evaluate(() => window.__game.setView('itemChaos'));
await settle(6);
// shadow render stats
const st = await page.evaluate(() => {
  const E = window.__game.engine, S = window.__game.systems;
  const csm = S.lighting.csm;
  const r = {};
  r.before = JSON.parse(JSON.stringify(E.renderer.info.render));
  r.shadowMapEnabled = E.renderer.shadowMap.enabled;
  r.maps = csm.lights.map(l => l.shadow.map ? { w: l.shadow.map.width, h: l.shadow.map.height, depthTex: !!l.shadow.map.depthTexture, tex: !!l.shadow.map.texture } : null);
  r.numShadows = csm.lights.filter(l=>l.castShadow).length;
  r.matrix0 = csm.lights[0].shadow.matrix.elements.map(v=>+v.toFixed(4));
  return r;
});
console.log('stats', JSON.stringify(st));
// turn OFF all csm shadow casting -> do the "tree shadows" survive?
await page.evaluate(() => {
  const S = window.__game.systems, E = window.__game.engine;
  for (const l of S.lighting.csm.lights) l.castShadow = false;
  E.renderer.shadowMap.needsUpdate = true;
});
await settle(6);
await page.screenshot({ path: OUT+'/d_noshadow.png', timeout: 180000 });
await browser.close();
