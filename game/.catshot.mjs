import { chromium } from 'playwright';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT = process.env.OUT || '/tmp/claude-0/-home-user-learnit/8f6205af-22db-552b-aca3-2d3962bb4285/scratchpad';
const DISTS = (process.env.DISTS || '2.4').split(',').map(Number);
const IDX = (process.env.IDX || '0').split(',').map(Number);
const YAWS = (process.env.YAWS || '0').split(',').map(Number);   // 0 = behind, PI = in front
const W = 1280, H = 720;
const browser = await chromium.launch({ executablePath: CHROME,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('http://127.0.0.1:4173/?review=1&audio=0&q=high', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 600000 });
const err = await page.evaluate(() => window.__game.error);
if (err) { console.error('game error', err); process.exit(1); }
await page.evaluate(() => window.__game.setView('gridStart'));
await page.evaluate((e) => { window.__CH = e.ch; window.__TH = e.th; window.__FOV = e.fov; window.__game.showHUD(false); }, { ch: process.env.CH ? +process.env.CH : null, th: process.env.TH ? +process.env.TH : null, fov: process.env.FOV ? +process.env.FOV : null });
for (const d of DISTS) for (const yaw of YAWS) for (const i of IDX) {
  await page.evaluate(([d, i, yaw]) => {
    const g = window.__game;
    const v = g.race.vehicles[i];
    const p = v.state.pos, rot = v.state.rot ?? v.state.yaw ?? 0;
    const a = rot + yaw;
    const cx = p.x - Math.sin(a) * d, cz = p.z - Math.cos(a) * d;
    const CH = +(window.__CH ?? (0.72 + d * 0.06)), TH2 = +(window.__TH ?? 0.62);
    g.camera.setFixed([cx, p.y + CH, cz], [p.x, p.y + TH2, p.z], +(window.__FOV ?? 34));
  }, [d, i, yaw]);
  await page.waitForTimeout(250);
  const f = `${OUT}/cat_${String(d).replace('.','_')}m_y${String(yaw).replace('.','_')}_${i}.png`;
  await page.screenshot({ path: f, timeout: 180000 });
  console.log(f);
}
if (errs.length) console.error('ERRORS', errs.slice(0, 5));
await browser.close();
