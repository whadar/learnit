import { chromium } from 'playwright';
import fs from 'node:fs';
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
const out = await page.evaluate(() => {
  const R = window.__game.engine.renderer, S = window.__game.engine.scene;
  const gl = R.getContext();
  const res = {};
  const grab = (re, key) => {
    let mesh=null; S.traverse(o=>{ if(!mesh&&o.isMesh&&re.test(o.name||'')) mesh=o; });
    if (!mesh) { res[key] = 'no mesh'; return; }
    const mat = Array.isArray(mesh.material)?mesh.material[0]:mesh.material;
    const cp = R.properties.get(mat).currentProgram;
    if (!cp) { res[key] = 'no program for ' + mesh.name; return; }
    for (const sh of gl.getAttachedShaders(cp.program)) {
      const src = gl.getShaderSource(sh);
      if (src.includes('pc_fragColor') || src.includes('gl_FragColor')) {
        const i = src.indexOf('void main()');
        res[key] = { mesh: mesh.name, recv: mesh.receiveShadow, main: src.slice(i, i + 6000) };
      }
    }
  };
  grab(/terrain-chunk/, 'terrain');
  grab(/^circuit:(road|surface|track)/i, 'road');
  return res;
});
fs.writeFileSync('/tmp/claude-0/-home-user-learnit/8f6205af-22db-552b-aca3-2d3962bb4285/scratchpad/frag.json', JSON.stringify(out, null, 1));
console.log(Object.keys(out), out.terrain && out.terrain.mesh, out.terrain && out.terrain.recv);
await browser.close();
