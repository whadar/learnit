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
await settle(12);
const r = await page.evaluate(() => {
  const g = window.__game, E = g.engine, L = E.lighting, R = E.renderer, W = g.world;
  const v = g.race.state.player?.vehicle || g.race.vehicles[0]; const p = v.position||v.pos;
  const V3 = E.camera.position.constructor;
  const sh = L.sun.shadow, N = sh.map.width;
  const sc = new V3(p.x, p.y, p.z).applyMatrix4(sh.matrix);
  const cx = Math.round(sc.x*N), cy = Math.round(sc.y*N);
  const W2 = 256;
  const buf = new Uint8Array(W2*W2*4);
  R.readRenderTargetPixels(sh.map, cx-W2/2, cy-W2/2, W2, W2, buf);
  const out=[]; let mn=2, mx=-1;
  for (let y=0;y<W2;y++) for (let x=0;x<W2;x++){ const i=((W2-1-y)*W2+x)*4; const d=buf[i]/255+buf[i+1]/65025; out.push(d); if(d<mn)mn=d; if(d<1&&d>mx)mx=d; }
  return { out, mn:+mn.toFixed(4), mx:+mx.toFixed(4), z:+sc.z.toFixed(4), texel: (sh.camera.right-sh.camera.left)/N,
    far: sh.camera.far, near: sh.camera.near };
});
console.log('receiver z', r.z, 'map min', r.mn, 'max<1', r.mx, 'texel(m)', r.texel.toFixed(3), 'span', (r.far-r.near).toFixed(0));
const W2=256, png=new PNG({width:W2,height:W2});
// stretch contrast around the receiver z
const lo=r.z-0.004, hi=r.z+0.002;
for (let i=0;i<W2*W2;i++){ const d=r.out[i]; const v=Math.round(Math.min(1,Math.max(0,(d-lo)/(hi-lo)))*255);
  png.data[i*4]=v;png.data[i*4+1]=v;png.data[i*4+2]=v;png.data[i*4+3]=255; }
for (let d=-10;d<=10;d++){ for (const [x,y] of [[128+d,128],[128,128+d]]) { const i=(y*W2+x)*4; png.data[i]=255;png.data[i+1]=0;png.data[i+2]=0; } }
fs.writeFileSync(OUT+'zoommap.png', PNG.sync.write(png));
await browser.close();
