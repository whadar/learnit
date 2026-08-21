import { chromium } from 'playwright';
import fs from 'node:fs';
import { PNG } from 'pngjs';
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
const r = await page.evaluate(() => {
  const R = window.__game.engine.renderer, S = window.__game.engine.scene, L = window.__game.engine.lighting;
  // inventory of kart-ish meshes
  const inv = [];
  S.traverse(o => {
    if (o.isMesh && o.visible && /kart|wheel|cat|body|chassis/i.test(o.name||'')) {
      if (inv.length < 40) inv.push({ n:o.name, cast:o.castShadow, fc:o.frustumCulled, vis:o.visible,
        wp: o.getWorldPosition(new o.position.constructor()).toArray().map(v=>+v.toFixed(1)),
        matSide: (Array.isArray(o.material)?o.material[0]:o.material).side,
        shadowSide: (Array.isArray(o.material)?o.material[0]:o.material).shadowSide,
        transparent: (Array.isArray(o.material)?o.material[0]:o.material).transparent });
    }
  });
  // parents of the player kart
  let names = [];
  S.traverse(o => { if (names.length<60 && /kart/i.test(o.name||'')) names.push((o.isMesh?'M ':'G ')+o.name+' cast='+o.castShadow+' vis='+o.visible); });
  const rt = L.csm.lights[0].shadow.map, N = rt.width;
  const buf = new Uint8Array(512*512*4);
  R.readRenderTargetPixels(rt, (N-512)/2, (N-512)/2, 512, 512, buf);
  return { inv, names, buf: Array.from(buf.filter((_,i)=>i%4===0)) };
});
console.log(JSON.stringify(r.inv, null, 0).slice(0,4000));
console.log(r.names.join('\n'));
const S=512; const png = new PNG({width:S,height:S});
for (let y=0;y<S;y++) for (let x=0;x<S;x++){ const v=r.buf[(S-1-y)*S+x]; const i=(y*S+x)*4; png.data[i]=v;png.data[i+1]=v;png.data[i+2]=v;png.data[i+3]=255; }
fs.writeFileSync(OUT+'smap0c.png', PNG.sync.write(png));
await browser.close();
