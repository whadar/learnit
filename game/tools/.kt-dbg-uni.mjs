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
  const R = window.__game.engine.renderer, S = window.__game.engine.scene, L = window.__game.engine.lighting;
  const gl = R.getContext();
  let mat=null, obj=null;
  S.traverse(o => { if (!mat && o.isMesh && /terrain-chunk/.test(o.name||'')) { obj=o; mat = Array.isArray(o.material)?o.material[0]:o.material; } });
  const prog = R.properties.get(mat).currentProgram.program;
  const g = n => { const l = gl.getUniformLocation(prog, n); return l ? gl.getUniform(prog, l) : 'NO_LOC'; };
  const arr = v => (v && v.length !== undefined) ? Array.from(v) : v;
  return JSON.stringify({
    csm0: arr(g('CSM_cascades[0]')), csm1: arr(g('CSM_cascades[1]')), csm2: arr(g('CSM_cascades[2]')),
    cameraNear: g('cameraNear'), shadowFar: g('shadowFar'),
    receiveShadow: g('receiveShadow'),
    dls0_intensity: g('directionalLightShadows[0].shadowIntensity'),
    dls0_bias: g('directionalLightShadows[0].shadowBias'),
    dls0_normalBias: g('directionalLightShadows[0].shadowNormalBias'),
    dls0_radius: g('directionalLightShadows[0].shadowRadius'),
    dls0_size: arr(g('directionalLightShadows[0].shadowMapSize')),
    dl0_color: arr(g('directionalLights[0].color')),
    dl0_dir: arr(g('directionalLights[0].direction')),
    dl3_color: arr(g('directionalLights[3].color')),
    shadowMat0: arr(g('directionalShadowMatrix[0]')),
    lightingCsmMat0: L.csm.lights[0].shadow.matrix.elements.slice(),
    jsUniform: L.csm ? null : null,
    lightingUniformsCSM: (window.__game.engine.lighting.apUniforms ? 'ap ok' : 'no ap'),
  });
}));
await browser.close();
