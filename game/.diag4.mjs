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
const info = await page.evaluate(() => {
  const g = window.__game, S = g.systems, E = g.engine;
  const THREE = E.THREE || null;
  const rig = S.racers[0].rig, root = rig.object3D;
  const out = { layers: [], bs: [], parents: [] };
  let n = 0;
  root.traverse(o => { if (o.isMesh && o.castShadow && n < 5) { n++;
    o.geometry.computeBoundingSphere();
    out.layers.push(o.layers.mask);
    out.bs.push({ c: o.geometry.boundingSphere.center.toArray().map(v=>+v.toFixed(2)), r: +o.geometry.boundingSphere.radius.toFixed(2), fc: o.frustumCulled, vis:o.visible, matVis: o.material.visible, side: o.material.side, dw: o.material.depthWrite, transparent: o.material.transparent });
  }});
  // ancestors visible?
  let p = root; const chain = [];
  while (p) { chain.push({ n: p.name || p.type, vis: p.visible, layers: p.layers.mask, scale: p.scale.toArray().map(v=>+v.toFixed(2)) }); p = p.parent; }
  out.chain = chain;
  // shadow camera layers
  out.shadowCamLayers = S.lighting.csm.lights.map(l => ({ light: l.layers.mask, cam: l.shadow.camera.layers.mask }));
  // drop a big test box just above the kart
  const T = root.constructor; // Object3D ctor - can't build geometry from this
  return out;
});
console.log(JSON.stringify(info, null, 1));
// add a test box using the three instance exposed through an existing mesh's constructor chain
await page.evaluate(() => {
  const g = window.__game, S = g.systems, E = g.engine;
  const rig = S.racers[0].rig, root = rig.object3D;
  let proto = null; root.traverse(o => { if (!proto && o.isMesh) proto = o; });
  const Mesh = proto.constructor;
  const Geo = proto.geometry.constructor.prototype.constructor; // BufferGeometry-ish
  // build a simple box geometry by hand
  const BufferGeometry = Object.getPrototypeOf(proto.geometry).constructor;
  const pos = proto.geometry.getAttribute('position').constructor;
  const s = 0.6, v = [];
  const quad = (a,b,c,d) => { v.push(...a,...b,...c, ...a,...c,...d); };
  const P=[[-s,-s,-s],[s,-s,-s],[s,s,-s],[-s,s,-s],[-s,-s,s],[s,-s,s],[s,s,s],[-s,s,s]];
  quad(P[0],P[1],P[2],P[3]); quad(P[5],P[4],P[7],P[6]); quad(P[4],P[0],P[3],P[7]);
  quad(P[1],P[5],P[6],P[2]); quad(P[3],P[2],P[6],P[7]); quad(P[4],P[5],P[1],P[0]);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new pos(new Float32Array(v), 3));
  geo.computeVertexNormals();
  const mat = new proto.material.constructor({ color: 0xff00ff });
  const box = new Mesh(geo, mat);
  box.castShadow = true; box.receiveShadow = false;
  box.position.copy(root.position); box.position.y += 2.0;
  box.name = 'DEBUG_BOX';
  E.scene.add(box);
  E.renderer.shadowMap.needsUpdate = true;
  window.__dbgbox = box;
});
await settle(6);
await page.screenshot({ path: OUT+'/d_box.png', timeout: 180000 });
await browser.close();
