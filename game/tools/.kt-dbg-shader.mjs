import { chromium } from 'playwright';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const url = (process.env.SHOOT_URL || 'http://127.0.0.1:4173/') + '?review=1&audio=0&q=high';
const browser = await chromium.launch({ executablePath: CHROME,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 600000 });
const settle = n => page.evaluate(k => new Promise(r => { let i=0; const s=()=>(++i>=k?r():requestAnimationFrame(s)); requestAnimationFrame(s); }), n);
await page.evaluate(() => window.__game.setView('gridStart'));
await settle(10);
const out = await page.evaluate(() => {
  const R = window.__game.engine.renderer, S = window.__game.engine.scene;
  const gl = R.getContext();
  let mat = null, obj=null;
  S.traverse(o => { if (!mat && o.isMesh && /terrain-chunk/.test(o.name||'')) { obj=o; mat = Array.isArray(o.material)?o.material[0]:o.material; } });
  const props = R.properties.get(mat);
  const prog = props.currentProgram;
  const res = { has: !!prog, keys: Object.keys(props) };
  if (prog) {
    const shaders = gl.getAttachedShaders(prog.program);
    for (const sh of shaders) {
      const src = gl.getShaderSource(sh);
      const isFrag = src.includes('gl_FragColor') || src.includes('pc_fragColor') || /out highp vec4/.test(src);
      const head = src.slice(0, 3000);
      if (isFrag) {
        res.fragDefines = head.split('\n').filter(l => l.startsWith('#define')).slice(0,80);
        res.hasCSMBlock = src.includes('CSM_cascades');
        res.hasGetShadowCall = /getShadow\( directionalShadowMap/.test(src);
        const i = src.indexOf('linearDepth');
        res.csmSnippet = i>=0 ? src.slice(i-300, i+2200) : null;
      }
    }
  }
  res.uniformsAvail = null;
  return res;
});
console.log(JSON.stringify(out, null, 1).slice(0, 12000));
await browser.close();
