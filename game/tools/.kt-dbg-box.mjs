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
await settle(8);
console.log(await page.evaluate(() => {
  const g = window.__game, E = g.engine, S = E.scene, L = E.lighting;
  const THREE = g.THREE || null;
  const sh = L.csm.lights[0].shadow;
  const dt = sh.map.depthTexture;
  const info = { compareFunction: dt.compareFunction, format: dt.format, type: dt.type, mag: dt.magFilter };
  // place a giant box above the player kart
  const v = g.race?.state?.player?.vehicle || g.race?.vehicles?.[0];
  const p = v ? v.position || v.pos : null;
  info.playerPos = p ? [p.x, p.y, p.z] : null;
  // use constructors from an existing mesh's class
  let proto = null; S.traverse(o => { if (!proto && o.isMesh) proto = o; });
  const Mesh = proto.constructor;
  const geoProto = proto.geometry.constructor; // BufferGeometry
  // build a box manually from BufferGeometry via three exposed on the mesh? use scene's own
  info.ok = true;
  window.__DBG = { Mesh, p };
  return JSON.stringify(info);
}));
await browser.close();
