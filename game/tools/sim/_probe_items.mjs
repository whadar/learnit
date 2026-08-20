import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 800, height: 500 } });
const logs = [];
p.on('console', m => logs.push('['+m.type()+'] '+m.text()));
p.on('pageerror', e => logs.push('[pageerror] '+e.message+'\n'+(e.stack||'')));
p.on('requestfailed', r => logs.push('[reqfail] '+r.url()+' '+r.failure()?.errorText));
await p.goto(process.argv[2] || 'http://127.0.0.1:5223/preview/items.html', { waitUntil: 'load', timeout: 120000 });
await p.waitForTimeout(+(process.argv[3]||25000));
const st = await p.evaluate(() => ({ has: !!window.__game, ready: window.__game?.ready, err: window.__game?.error, views: Object.keys(window.__game?.views||{}) }));
console.log(JSON.stringify(st, null, 1));
console.log(logs.join('\n').slice(0, 4000));
await b.close();
