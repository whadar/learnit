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
const probe = () => page.evaluate(() => {
  const g = window.__game, E = g.engine, L = E.lighting, R = E.renderer;
  const v = g.race.state.player?.vehicle || g.race.vehicles[0];
  const p = v.position || v.pos;
  const V3 = E.camera.position.constructor;
  const sh = L.csm.lights[0].shadow, N = sh.map.width;
  const c = new V3(p.x, p.y, p.z).applyMatrix4(sh.matrix);
  const px = Math.round(c.x*N), py = Math.round(c.y*N);
  const buf = new Uint8Array(6*6*4);
  R.readRenderTargetPixels(sh.map, px-3, py-3, 6, 6, buf);
  const st=[]; for (let i=0;i<36;i++) st.push(+(buf[i*4]/255+buf[i*4+1]/65025).toFixed(4));
  return JSON.stringify({ kartY: +p.y.toFixed(2), z_kartOrigin: +c.z.toFixed(4), stored: st });
});
console.log('BASE', await probe());
await page.evaluate(() => {
  const S = window.__game.engine.scene; const seen = new Set();
  S.traverse(o => { if (!o.isMesh || !o.material) return; const ms = Array.isArray(o.material)?o.material:[o.material];
    for (const m of ms) { if (!m || seen.has(m)) continue; seen.add(m); m.shadowSide = 0; } });
  for (const l of window.__game.engine.lighting.csm.lights) { l.shadow.bias = -0.00002; l.shadow.normalBias = 0.02; }
  window.__game.engine.renderer.shadowMap.autoUpdate = true;
  window.__game.engine.renderer.shadowMap.needsUpdate = true;
});
await settle(10);
console.log('FRONT', await probe());
await page.screenshot({ path: OUT+'dbg_front.png', timeout: 300000 });
await browser.close();
