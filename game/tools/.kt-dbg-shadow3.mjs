import { chromium } from 'playwright';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const url = (process.env.SHOOT_URL || 'http://127.0.0.1:4173/') + '?review=1&audio=0&q=high';
const OUT='/tmp/claude-0/-home-user-learnit/8f6205af-22db-552b-aca3-2d3962bb4285/scratchpad/';
const browser = await chromium.launch({ executablePath: CHROME,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 600000 });
const settle = n => page.evaluate(k => new Promise(r => { let i=0; const s=()=>(++i>=k?r():requestAnimationFrame(s)); requestAnimationFrame(s); }), n);
await page.evaluate(() => window.__game.setView('gridStart'));
await settle(10);
// A: force autoUpdate
console.log(await page.evaluate(() => {
  const R = window.__game.engine.renderer;
  R.shadowMap.autoUpdate = true; R.shadowMap.needsUpdate = true;
  return JSON.stringify({ mapExists: !!window.__game.engine.lighting.csm.lights[0].shadow.map,
    depthTex: !!window.__game.engine.lighting.csm.lights[0].shadow.map?.depthTexture,
    texType: window.__game.engine.lighting.csm.lights[0].shadow.map?.texture?.type });
}));
await settle(10);
await page.screenshot({ path: OUT+'dbg_auto.png' });
// B: read back shadow map pixels
console.log(await page.evaluate(() => {
  const R = window.__game.engine.renderer, L = window.__game.engine.lighting;
  const rt = L.csm.lights[0].shadow.map;
  try {
    const buf = new Uint8Array(64*64*4);
    R.readRenderTargetPixels(rt, 992, 992, 64, 64, buf);
    let min=255,max=0,sum=0;
    for (let i=0;i<buf.length;i+=4){ const v=buf[i]; min=Math.min(min,v); max=Math.max(max,v); sum+=v; }
    return JSON.stringify({ min, max, mean: sum/(buf.length/4) });
  } catch(e){ return 'readback failed: '+e.message; }
}));
await browser.close();
