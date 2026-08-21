import { chromium } from 'playwright';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = process.env.SHOOT_URL || 'http://127.0.0.1:4173/';
const url = BASE + '?review=1&audio=0&q=high';
const browser = await chromium.launch({ executablePath: CHROME,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('console', m => { const t=m.text(); if(t.startsWith('DBG')) console.log(t); });
await page.goto(url, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 600000 });
const out = await page.evaluate(() => {
  const g = window.__game;
  g.setView('photoFinish');
  const cam = g.engine.camera;
  const trk = g.track;
  const s0 = trk.startS;
  const THREE3 = g.THREE || null;
  const proj = (x,y,z) => { const v = new (g.engine.camera.position.constructor)(x,y,z); v.project(cam); return [Math.round((v.x*0.5+0.5)*1280), Math.round((-v.y*0.5+0.5)*720)]; };
  const karts = g.race.racers.map(r => {
    const s = r.vehicle.state;
    const d = Math.hypot(s.pos.x-cam.position.x, s.pos.z-cam.position.z);
    // project
    const v = new (window.THREE ? window.THREE.Vector3 : Object)();
    return { scr: proj(s.pos.x, s.pos.y+0.8, s.pos.z), name: r.name, place: r.place, pos: [s.pos.x.toFixed(1), s.pos.y.toFixed(1), s.pos.z.toFixed(1)], dist: +d.toFixed(1), speed: +s.speed.toFixed(1), isPlayer: !!r.isPlayer };
  });
  const furn = [];
  g.engine.scene.traverse(o => { if (o.isMesh && typeof o.name === 'string' && o.name.startsWith('furniture:')) {
    o.updateWorldMatrix(true,false);
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    const c = { x:(bb.min.x+bb.max.x)/2, y:(bb.min.y+bb.max.y)/2, z:(bb.min.z+bb.max.z)/2 };
    const dd = Math.hypot(c.x-cam.position.x, c.z-cam.position.z);
    if (dd < 40) furn.push({ name:o.name, c:[+c.x.toFixed(1),+c.y.toFixed(1),+c.z.toFixed(1)], size:[+(bb.max.x-bb.min.x).toFixed(1),+(bb.max.y-bb.min.y).toFixed(1),+(bb.max.z-bb.min.z).toFixed(1)], d:+dd.toFixed(1) });
  }});
  furn.sort((a,b)=>a.d-b.d);
  const sm = g.track.sample(g.track.startS);
  const gantry = { line: proj(sm.pos.x, sm.pos.y, sm.pos.z), beam: proj(sm.pos.x, sm.pos.y+7.55, sm.pos.z), banner: proj(sm.pos.x, sm.pos.y+8.95, sm.pos.z), valance: proj(sm.pos.x, sm.pos.y+5.45, sm.pos.z), roadY: +sm.pos.y.toFixed(2), width: +sm.width.toFixed(1) };
  return { gantry, cam: { pos: cam.position.toArray().map(n=>+n.toFixed(2)), fov: cam.fov, aspect: cam.aspect },
    pose: g.camera.pose(), startS: s0, len: trk.length, karts, furn: furn.slice(0,25),
    camTarget: g.camera.target ? 'set' : 'null' };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
