import { chromium } from 'playwright';
import fs from 'node:fs';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT = process.env.OUT || '/tmp/veg-diag';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:4173/?review=1&audio=0&q=high', { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 600000 });
const settle = f => page.evaluate(n => new Promise(res => { let i=0; const s=()=>(++i>=n?res():requestAnimationFrame(s)); requestAnimationFrame(s); }), f);
for (const v of (process.env.VIEWS||'villageStreet').split(',')) {
  await page.evaluate(n => window.__game.setView(n), v);
  await settle(8);
  await page.screenshot({ path: `${OUT}/${v}-on.png` });
  await page.evaluate(() => { window.__game.engine.scene.traverse(o => { if (o.name === 'vegetation') o.visible = false; }); });
  await settle(4);
  await page.screenshot({ path: `${OUT}/${v}-noveg.png` });
  await page.evaluate(() => { window.__game.engine.scene.traverse(o => { if (o.name === 'vegetation') o.visible = true; }); });
  await settle(2);
}
console.log(await page.evaluate(() => {
  const names = [];
  window.__game.engine.scene.traverse(o => { if (o.isMesh || o.isInstancedMesh) names.push(o.name + (o.isInstancedMesh?`[${o.count}]`:'')); });
  return names.slice(0, 400).join('\n');
}));
await browser.close();
