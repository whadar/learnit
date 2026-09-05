import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await (await b.newContext()).newPage();
await p.goto('http://127.0.0.1:4180/?audio=0', { waitUntil: 'load', timeout: 240000 });
await p.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 600000 });
console.log('buildings cleared from the roadway:', await p.evaluate(() => window.__game.error || 'ok'));
await b.close();
