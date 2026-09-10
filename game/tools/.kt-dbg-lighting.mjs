import { chromium } from 'playwright';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = process.env.SHOOT_URL || 'http://127.0.0.1:4173/';
const url = BASE + '?review=1&audio=0&q=high';
const browser = await chromium.launch({ executablePath: CHROME,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', m => { const t=m.text(); if (/lighting|shadow|csm|warn|error/i.test(t)) console.log('[c]', t); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 600000 });
await page.evaluate(() => window.__game.setView('gridStart'));
await page.evaluate(() => new Promise(r => { let i=0; const s=()=>(++i>=10?r():requestAnimationFrame(s)); requestAnimationFrame(s); }));
const out = await page.evaluate(() => {
  const g = window.__game, L = g.engine.lighting, R = g.engine.renderer, S = g.engine.scene;
  const res = {};
  res.shadowMap = { enabled: R.shadowMap.enabled, type: R.shadowMap.type, autoUpdate: R.shadowMap.autoUpdate, needsUpdate: R.shadowMap.needsUpdate };
  res.hasCSM = !!L?.csm;
  if (L?.csm) {
    const c = L.csm;
    res.csm = { cascades: c.cascades, breaks: c.breaks.slice(), maxFar: c.maxFar, fade: c.fade,
      lightDir: c.lightDirection.toArray(),
      lights: c.lights.map(l => ({ inScene: !!l.parent, cast: l.castShadow, intensity: l.intensity,
        pos: l.position.toArray().map(v=>+v.toFixed(1)), tgt: l.target.position.toArray().map(v=>+v.toFixed(1)),
        tgtParent: !!l.target.parent,
        cam: { l: l.shadow.camera.left, r: l.shadow.camera.right, t: l.shadow.camera.top, b: l.shadow.camera.bottom, n: l.shadow.camera.near, f: l.shadow.camera.far },
        bias: l.shadow.bias, normalBias: l.shadow.normalBias, radius: l.shadow.radius, intensityS: l.shadow.intensity,
        map: l.shadow.map ? [l.shadow.map.width, l.shadow.map.height] : null })) };
  }
  // count dir lights in scene
  let dirLights = 0, meshCast = 0, meshRecv = 0;
  S.traverse(o => { if (o.isDirectionalLight) dirLights++; if (o.isMesh && o.visible) { if (o.castShadow) meshCast++; if (o.receiveShadow) meshRecv++; } });
  res.dirLights = dirLights; res.meshCast = meshCast; res.meshRecv = meshRecv;
  // find the road mesh material defines + program
  const found = [];
  S.traverse(o => {
    if (!o.isMesh || found.length > 6) return;
    if (/road|circuit|terrain|kart/i.test(o.name || '')) {
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      found.push({ name: o.name, recv: o.receiveShadow, cast: o.castShadow, defines: m.defines ? Object.keys(m.defines) : null,
        prog: m.program ? { dirShadows: m.program.getUniforms ? undefined : undefined } : null });
    }
  });
  res.samples = found;
  res.numShadowMaps = R.info?.memory ? R.info.memory.textures : null;
  return res;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
