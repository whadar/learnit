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
await settle(10);
console.log(await page.evaluate(() => {
  const g = window.__game, E = g.engine, L = E.lighting, R = E.renderer, W = g.world;
  const v = g.race.state.player?.vehicle || g.race.vehicles[0];
  const p = v.position || v.pos;
  const V3 = E.camera.position.constructor;
  const out = [];
  for (let ci = 0; ci < 2; ci++) {
    const sh = L.csm.lights[ci].shadow, N = sh.map.width;
    const probe = (label, wx, wy, wz) => {
      const c = new V3(wx, wy, wz).applyMatrix4(sh.matrix);
      const px = Math.round(c.x * N), py = Math.round(c.y * N);
      let stored = null;
      if (px >= 1 && py >= 1 && px < N-1 && py < N-1) {
        const buf = new Uint8Array(4*4*4);
        R.readRenderTargetPixels(sh.map, px-2, py-2, 4, 4, buf);
        stored = [];
        for (let i=0;i<16;i++) stored.push(+(buf[i*4]/255 + buf[i*4+1]/65025).toFixed(4));
      }
      out.push({ ci, label, uv: [+c.x.toFixed(4), +c.y.toFixed(4)], z: +c.z.toFixed(4), px, py, stored });
    };
    const gy = W.heightAt(p.x, p.z);
    probe('kart-body', p.x, gy + 0.45, p.z);
    probe('ground-under-kart', p.x, gy, p.z);
  }
  return JSON.stringify(out, null, 1);
}));
await browser.close();
