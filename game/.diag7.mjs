import { chromium } from 'playwright';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT = '/tmp/claude-0/-home-user-learnit/8f6205af-22db-552b-aca3-2d3962bb4285/scratchpad';
const browser = await chromium.launch({ executablePath: CHROME,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1'] });
const page = await browser.newPage({ viewport:{width:1280,height:720}, deviceScaleFactor:1 });
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('console', m => console.log('['+m.type()+']', m.text().slice(0,300)));
await page.goto('http://127.0.0.1:4188/?review=1&audio=0&q=high', { waitUntil:'load', timeout:180000 });
await page.waitForFunction(() => window.__game && (window.__game.ready||window.__game.error), null, {timeout:600000});
const settle = n => page.evaluate(k => new Promise(r=>{let i=0;const s=()=>(++i>=k?r():requestAnimationFrame(s));requestAnimationFrame(s);}), n);
await page.evaluate(() => window.__game.setView('itemChaos'));
await settle(6);
const res = await page.evaluate(async () => {
  const E = window.__game.engine, S = window.__game.systems;
  const sm = E.renderer.shadowMap;
  const orig = sm.render.bind(sm);
  const log = [];
  sm.render = function (lights, scene, camera) {
    const c0 = E.renderer.info.render.calls, t0 = E.renderer.info.render.triangles;
    const before = { enabled: sm.enabled, autoUpdate: sm.autoUpdate, needsUpdate: sm.needsUpdate, lights: lights.length };
    orig(lights, scene, camera);
    log.push({ ...before, calls: E.renderer.info.render.calls - c0, tris: E.renderer.info.render.triangles - t0 });
  };
  E.renderer.shadowMap.autoUpdate = true;
  await new Promise(r => { let i = 0; const s = () => (++i >= 4 ? r() : requestAnimationFrame(s)); requestAnimationFrame(s); });
  sm.render = orig;
  // also dump the compiled fragment shader of a road/track material for CSM markers
  let road = null;
  E.scene.traverse(o => { if (!road && o.isMesh && /road|track|tarmac|surface|kerb/i.test(o.name||'')) road = o; });
  const names = []; E.scene.traverse(o => { if (o.isMesh && o.receiveShadow) names.push(o.name || '(anon)'); });
  return { log, roadName: road?.name, roadDefines: road?.material?.defines, roadRecv: road?.receiveShadow,
    receiverSample: [...new Set(names)].filter(n => !n.startsWith('terrain-chunk')).slice(0, 20) };
});
console.log(JSON.stringify(res, null, 1));
await browser.close();
