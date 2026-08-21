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
  const S = window.__game.engine.scene, R = window.__game.engine.renderer, L = window.__game.engine.lighting;
  const seen = new Set(); let n=0;
  const glsl = `
  {
    DirectionalLightShadow d0 = directionalLightShadows[0];
    DirectionalLightShadow d1 = directionalLightShadows[1];
    float s0 = getShadow( directionalShadowMap[0], d0.shadowMapSize, d0.shadowIntensity, d0.shadowBias, d0.shadowRadius, vDirectionalShadowCoord[0] );
    float s1 = getShadow( directionalShadowMap[1], d1.shadowMapSize, d1.shadowIntensity, d1.shadowBias, d1.shadowRadius, vDirectionalShadowCoord[1] );
    gl_FragColor = vec4( s0, s1, receiveShadow ? 1.0 : 0.0, 1.0 );
    return;
  }`;
  S.traverse(o => { if (!o.isMesh || !o.material) return; const ms = Array.isArray(o.material)?o.material:[o.material];
    for (const m of ms) { if (!m || seen.has(m)) continue; seen.add(m); m.shadowSide = 0;
      if (m.defines && ('USE_CSM' in m.defines)) { n++; const prev = m.onBeforeCompile;
        m.onBeforeCompile = function (sh, r) { prev?.call(this, sh, r);
          sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', glsl); }; }
      m.needsUpdate = true; } });
  for (const l of L.csm.lights) { l.shadow.bias = -0.00002; l.shadow.normalBias = 0.02; }
  R.shadowMap.autoUpdate = true; R.shadowMap.needsUpdate = true;
  return 'patched ' + n;
}));
await settle(14);
await page.screenshot({ path: OUT+'dbg_front2.png', timeout: 300000 });
await browser.close();
