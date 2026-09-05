import { chromium } from 'playwright';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const url = (process.env.SHOOT_URL || 'http://127.0.0.1:4173/') + '?review=1&audio=0&q=high';
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
  const g = window.__game, E = g.engine, L = E.lighting, W = g.world;
  const cam = E.camera;
  const V = cam.position.constructor; // Vector3
  const M = L.csm.lights[0].shadow.matrix.constructor; // Matrix4
  const out = { camPos: cam.position.toArray().map(v=>+v.toFixed(1)), camNear: cam.near, camFar: cam.far,
    shadowFarU: Math.min(cam.far, L.csm.maxFar), breaks: L.csm.breaks.slice() };
  const v = g.race?.state?.player?.vehicle || g.race?.vehicles?.[0];
  const p = v.position || v.pos;
  const gy = W.heightAt(p.x, p.z);
  const pts = [
    ['under-player', p.x, gy, p.z],
    ['near-cam', cam.position.x, W.heightAt(cam.position.x, cam.position.z), cam.position.z],
  ];
  out.pts = pts.map(([n,x,y,z]) => {
    const wp = new (cam.position.constructor)(x,y,z);
    const res = {};
    for (let i=0;i<L.csm.lights.length;i++){
      const sc = wp.clone().applyMatrix4(L.csm.lights[i].shadow.matrix);
      // Vector3.applyMatrix4 does perspective divide already
      res['c'+i] = [sc.x,sc.y,sc.z].map(q=>+q.toFixed(4));
    }
    // view depth
    const vp = wp.clone().applyMatrix4(cam.matrixWorldInverse);
    res.viewZ = +(-vp.z).toFixed(2);
    res.linearDepth = +((-vp.z)/(Math.min(cam.far,L.csm.maxFar)-cam.near)).toFixed(4);
    return [n, res];
  });
  return JSON.stringify(out, null, 1);
}));
await browser.close();
