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
  const g = window.__game, E = g.engine, L = E.lighting, R = E.renderer, S = E.scene;
  let dir = 0, shadowCasters = 0;
  S.traverse(o => { if (o.isDirectionalLight) { dir++; if (o.castShadow) shadowCasters++; } });
  const c = L.sun.shadow.camera;
  const v = g.race.state.player?.vehicle || g.race.vehicles[0];
  const p = v.position || v.pos;
  const V3 = E.camera.position.constructor;
  const sc = new V3(p.x, p.y, p.z).applyMatrix4(L.sun.shadow.matrix);
  let stored = null;
  const N = L.sun.shadow.map ? L.sun.shadow.map.width : 0;
  if (N) { const px = Math.round(sc.x*N), py = Math.round(sc.y*N);
    if (px>2&&py>2&&px<N-2&&py<N-2) { const b = new Uint8Array(16); R.readRenderTargetPixels(L.sun.shadow.map, px, py, 2, 2, b);
      stored = [0,1,2,3].map(i=>+(b[i*4]/255+b[i*4+1]/65025).toFixed(4)); } }
  // find a terrain material's defines
  let mat=null; S.traverse(o=>{ if(!mat&&o.isMesh&&/terrain-chunk/.test(o.name||'')) mat = Array.isArray(o.material)?o.material[0]:o.material; });
  return JSON.stringify({
    smEnabled: R.shadowMap.enabled, smAuto: R.shadowMap.autoUpdate, smType: R.shadowMap.type,
    dirLights: dir, dirShadowCasters: shadowCasters,
    sunCast: L.sun.castShadow, sunPos: L.sun.position.toArray().map(v=>+v.toFixed(1)),
    tgt: L.sun.target.position.toArray().map(v=>+v.toFixed(1)), tgtParent: !!L.sun.target.parent,
    cam: { l: c.left, r: c.right, n: c.near, f: c.far }, map: N,
    bias: L.sun.shadow.bias, normalBias: L.sun.shadow.normalBias, radius: L.sun.shadow.radius,
    kartShadowCoord: [sc.x,sc.y,sc.z].map(q=>+q.toFixed(4)), stored,
    defines: mat && mat.defines ? Object.keys(mat.defines) : null,
    matShadowSide: mat ? mat.shadowSide : null,
  });
}));
await browser.close();
