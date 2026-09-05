import { chromium } from 'playwright';
import fs from 'node:fs';
import { PNG } from 'pngjs';
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
const data = await page.evaluate(() => {
  const R = window.__game.engine.renderer, L = window.__game.engine.lighting;
  const rt = L.csm.lights[0].shadow.map;
  const N = rt.width;
  const buf = new Uint8Array(N*N*4);
  R.readRenderTargetPixels(rt, 0, 0, N, N, buf);
  const S = 512, step = N/S;
  const out = new Array(S*S);
  for (let y=0;y<S;y++) for (let x=0;x<S;x++){
    const sx=Math.floor(x*step), sy=Math.floor(y*step);
    const i=((N-1-sy)*N+sx)*4;
    // unpack RGBA depth (approx)
    const d = buf[i]/255 + buf[i+1]/65025;
    out[y*S+x] = Math.round(Math.min(1,Math.max(0,(d-0.0)))*255);
  }
  return out;
});
const S=512; const png = new PNG({width:S,height:S});
for (let i=0;i<S*S;i++){ const v=data[i]; png.data[i*4]=v;png.data[i*4+1]=v;png.data[i*4+2]=v;png.data[i*4+3]=255; }
fs.writeFileSync(OUT+'smap0.png', PNG.sync.write(png));
console.log('ok');
await browser.close();
