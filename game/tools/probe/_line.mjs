import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport:{width:640,height:360} });
await page.goto('http://127.0.0.1:4173/?review=1&audio=0&q=low', { waitUntil:'load', timeout:180000 });
await page.waitForFunction(() => window.__game?.ready || window.__game?.error, null, { timeout:600000 });
console.log(await page.evaluate(() => {
  const line = window.__game.race.line, trk = window.__game.track;
  const rows = [];
  for (let s = 2830; s <= 2930; s += 5) {
    const sm = trk.sample(s);
    rows.push(`s=${s} curv=${line.curvatureAt(s).toFixed(4)} v=${(line.speedAt(s)*3.6).toFixed(0)}km/h off=${line.offsetAt(s).toFixed(1)} w=${sm.width.toFixed(1)}`);
  }
  return rows.join('\n');
}));
await browser.close();
