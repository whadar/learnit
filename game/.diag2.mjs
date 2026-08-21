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
  const rig = S.racers[0].rig;
  const r = { rigType: rig?.constructor?.name, rigKeys: Object.keys(rig||{}) };
  const root = rig.group || rig.root || rig.object3D;
  r.rootName = root?.name;
  const acc=[]; root?.traverse(o=>{ if(o.isMesh) acc.push({n:o.name||'(anon)', cast:o.castShadow, vis:o.visible, mat:o.material?.type, wp:o.getWorldPosition(new (Object.getPrototypeOf(o.position).constructor)()).toArray().map(v=>+v.toFixed(1))}); });
  r.kartMeshes = acc.slice(0,40);
  r.kartMeshCount = acc.length;
  r.castCount = acc.filter(a=>a.cast).length;
  // Are those meshes inside cascade-0 shadow camera?
  const csm = S.lighting.csm;
  r.rootWorld = root.getWorldPosition(new (Object.getPrototypeOf(root.position).constructor)()).toArray().map(v=>+v.toFixed(1));
  // terrain material defines
  let tm=null; E.scene.traverse(o=>{ if(!tm && o.name?.startsWith('terrain-chunk')) tm=o.material; });
  r.terrainMat = tm ? { type: tm.type, defines: tm.defines, lights: tm.lights, hasFogUniform: !!tm.uniforms?.apHorizon } : null;
  return r;
});
console.log(JSON.stringify(out,null,1));
await browser.close();
