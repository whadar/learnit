import { chromium } from 'playwright';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: CHROME,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1'] });
const page = await browser.newPage({ viewport:{width:1280,height:720}, deviceScaleFactor:1 });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:4188/?review=1&audio=0&q=high', { waitUntil:'load', timeout:180000 });
await page.waitForFunction(() => window.__game && (window.__game.ready||window.__game.error), null, {timeout:600000});
await page.evaluate(() => window.__game.setView('itemChaos'));
await page.evaluate(n => new Promise(r=>{let i=0;const s=()=>(++i>=n?r():requestAnimationFrame(s));requestAnimationFrame(s);}), 8);
const out = await page.evaluate(() => {
  const g = window.__game, S = g.systems, E = g.engine;
  const csm = S.lighting?.csm;
  const r = {};
  r.shadowMapEnabled = E.renderer.shadowMap.enabled;
  r.shadowType = E.renderer.shadowMap.type;
  r.autoUpdate = E.renderer.shadowMap.autoUpdate;
  r.toneExposure = E.renderer.toneMappingExposure;
  r.csm = csm ? { cascades: csm.cascades, breaks: csm.breaks, maxFar: csm.maxFar, lights: csm.lights.length,
    l0: { castShadow: csm.lights[0].castShadow, intensity: csm.lights[0].intensity,
      mapSize: [csm.lights[0].shadow.mapSize.x, csm.lights[0].shadow.mapSize.y],
      cam: (c=>({l:c.left,r:c.right,t:c.top,b:c.bottom,n:c.near,f:c.far}))(csm.lights[0].shadow.camera),
      pos: csm.lights[0].position.toArray().map(v=>+v.toFixed(1)),
      tgt: csm.lights[0].target.position.toArray().map(v=>+v.toFixed(1)),
      hasMap: !!csm.lights[0].shadow.map,
      bias: csm.lights[0].shadow.bias, normalBias: csm.lights[0].shadow.normalBias } } : null;
  // walk the player kart
  const rig = S.racers && S.racers[0];
  const walk = (o, d=0, acc=[]) => { acc.push({n:o.name||o.type, mesh:!!o.isMesh, cast:o.castShadow, recv:o.receiveShadow, d, vis:o.visible, layers:o.layers.mask}); if(d<3) o.children.forEach(c=>walk(c,d+1,acc)); return acc; };
  if (rig) {
    const root = rig.group || rig.root || rig.object3D || rig.kart?.root || null;
    r.rigKeys = Object.keys(rig);
    if (root) r.rigTree = walk(root).slice(0, 30);
  }
  // count casters in scene
  let casters=0, receivers=0, meshes=0;
  E.scene.traverse(o=>{ if(o.isMesh||o.isInstancedMesh){meshes++; if(o.castShadow)casters++; if(o.receiveShadow)receivers++;} });
  r.counts = {meshes, casters, receivers};
  // named ground meshes near camera
  const names=[]; E.scene.traverse(o=>{ if((o.isMesh||o.isInstancedMesh) && o.receiveShadow) names.push(o.name); });
  r.receiverNames = [...new Set(names)].slice(0,25);
  const cn=[]; E.scene.traverse(o=>{ if((o.isMesh||o.isInstancedMesh) && o.castShadow) cn.push(o.name); });
  r.casterNames = [...new Set(cn)].slice(0,40);
  r.camPos = E.camera.position.toArray().map(v=>+v.toFixed(1));
  r.camNearFar=[E.camera.near, E.camera.far];
  r.sun = S.sky ? { dir: S.sky.sunDir.toArray().map(v=>+v.toFixed(3)), elev: S.sky.elevation, az: S.sky.azimuth, intensity: S.sky.palette.sunIntensity, color: S.sky.palette.sunColor.toArray().map(v=>+v.toFixed(3)) } : null;
  r.ap = S.lighting?.apUniforms ? { horizon: S.lighting.apUniforms.apHorizon.value.toArray().map(v=>+v.toFixed(3)), zenith: S.lighting.apUniforms.apZenith.value.toArray().map(v=>+v.toFixed(3)), density: S.lighting.apUniforms.apDensity.value, max: S.lighting.apUniforms.apMax.value, sunTint: S.lighting.apUniforms.apSunTint.value.toArray().map(v=>+v.toFixed(3)) } : null;
  return r;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
