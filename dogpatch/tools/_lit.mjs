import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
await p.goto('http://127.0.0.1:4180/?audio=0', { waitUntil: 'load', timeout: 240000 });
await p.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 600000 });
console.log(JSON.stringify(await p.evaluate(() => {
  const g = window.__game;
  let casters = 0, receivers = 0, lights = [];
  g.scene.traverse(o => {
    if (o.isMesh || o.isInstancedMesh) { if (o.castShadow) casters++; if (o.receiveShadow) receivers++; }
    if (o.isLight) lights.push({ type: o.type, intensity: o.intensity, castShadow: !!o.castShadow });
  });
  return { shadowMapEnabled: g.renderer.shadowMap.enabled, casters, receivers, lights,
           toneMapping: g.renderer.toneMapping, exposure: g.renderer.toneMappingExposure };
}), null, 1));
await b.close();
