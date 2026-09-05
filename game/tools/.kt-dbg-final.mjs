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
  const S = window.__game.engine.scene;
  const racers = []; S.traverse(o => { if (/^racer:/.test(o.name||'')) racers.push(o); });
  const inR = new Set(); for (const r of racers) r.traverse(o => inR.add(o));
  let off=0;
  S.traverse(o => { if (!o.isMesh) return; o.receiveShadow = true;
    if (inR.has(o)) { o.castShadow = true; o.frustumCulled = false; o.receiveShadow = false; }
    else if (o.castShadow) { o.castShadow = false; off++; } });
  // probe
  const glsl = `
  {
    DirectionalLightShadow d0 = directionalLightShadows[0];
    float s0 = getShadow( directionalShadowMap[0], d0.shadowMapSize, d0.shadowIntensity, d0.shadowBias, d0.shadowRadius, vDirectionalShadowCoord[0] );
    gl_FragColor = vec4( s0, receiveShadow ? 1.0 : 0.0, 0.5, 1.0 );
    return;
  }`;
  const seen = new Set(); let n=0;
  S.traverse(o => { if (!o.isMesh || !o.material) return; const ms = Array.isArray(o.material)?o.material:[o.material];
    for (const m of ms) { if (!m || seen.has(m) || !m.isMeshStandardMaterial || !m.defines || !('AERIAL_PERSPECTIVE' in m.defines)) continue; seen.add(m); n++;
      const prev = m.onBeforeCompile;
      m.onBeforeCompile = function (sh, r) { prev?.call(this, sh, r);
        sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', glsl); };
      m.needsUpdate = true; } });
  window.__game.engine.renderer.shadowMap.needsUpdate = true;
  return 'off ' + off + ' patched ' + n;
}));
await settle(16);
await page.screenshot({ path: OUT+'dbg_final.png', timeout: 300000 });
await browser.close();
