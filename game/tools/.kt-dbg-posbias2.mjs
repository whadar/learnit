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
  const L = window.__game.engine.lighting, sh = L.sun.shadow;
  let b = 0.05, nb = 0;
  Object.defineProperty(sh, 'bias', { get: () => b, set: () => {}, configurable: true });
  Object.defineProperty(sh, 'normalBias', { get: () => nb, set: () => {}, configurable: true });
  return 'locked bias ' + sh.bias;
}));
await settle(10);
await page.screenshot({ path: OUT+'dbg_posbias2.png', timeout: 300000 });
console.log(await page.evaluate(() => {
  const R = window.__game.engine.renderer, S = window.__game.engine.scene, L = window.__game.engine.lighting;
  const gl = R.getContext();
  let mat=null; S.traverse(o=>{ if(!mat&&o.isMesh&&/terrain-chunk/.test(o.name||'')) mat = Array.isArray(o.material)?o.material[0]:o.material; });
  const prog = R.properties.get(mat).currentProgram.program;
  const g = n => { const l = gl.getUniformLocation(prog, n); return l ? gl.getUniform(prog, l) : 'NO_LOC'; };
  const arr = v => (v && v.length !== undefined) ? Array.from(v).map(x=>+(+x).toFixed(6)) : v;
  return JSON.stringify({
    glBias: g('directionalLightShadows[0].shadowBias'),
    glNormalBias: g('directionalLightShadows[0].shadowNormalBias'),
    glIntensity: g('directionalLightShadows[0].shadowIntensity'),
    glMapSize: arr(g('directionalLightShadows[0].shadowMapSize')),
    glMatrix: arr(g('directionalShadowMatrix[0]')),
    jsMatrix: arr(L.sun.shadow.matrix.elements),
    glDir: arr(g('directionalLights[0].direction')),
  });
}));
await browser.close();
