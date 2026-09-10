/**
 * Live scenario trace — replays the villageStreet-style seeding step by step in the real
 * built game and prints the whole field every 0.25 s, so it is obvious *when* a kart loses
 * the road rather than only that it did.
 *
 *   node tools/probe/trace.mjs [fractionOfLap] [speed] [spread] [lead] [settle]
 */
import { chromium } from 'playwright';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = process.env.SHOOT_URL || 'http://127.0.0.1:4173/';
const [frac = 0.972, speed = 20.5, spread = 14, lead = 88, settle = 4.6] = process.argv.slice(2).map(Number);

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', e => console.error('[pageerror]', e.message));
await page.goto(BASE + '?review=1&audio=0&q=low', { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 600000 });

const out = await page.evaluate(([frac, speed, spread, lead, settle]) => {
  const g = window.__game, race = g.race, trk = g.track, L = trk.length;
  race.reset(); race.start(true); g.simulate(3.75);
  const s = ((trk.startS + frac * L) % L + L) % L;
  g.packAt(((s - lead) % L + L) % L, speed, { spread });
  const log = [];
  const dS = (a, b) => { let d = a - b; while (d > L / 2) d -= L; while (d < -L / 2) d += L; return d; };
  for (let t = 0; t <= settle + 1e-6; t += 0.25) {
    const p = race.racers[0];
    const pv = p.vehicle.state;
    const nr = trk.nearest(pv.pos);
    const a = p.ai, ai = a ? `tgt=${(a.targetSpeed*3.6).toFixed(0)} thr=${a.input.throttle.toFixed(2)} brk=${a.input.brake.toFixed(2)} str=${a.input.steer.toFixed(2)} cu=${a.catchup.toFixed(3)}` : 'no-ai';
    log.push(t.toFixed(2) + `  [s=${nr.s.toFixed(0)} lat=${nr.lateral.toFixed(1)} v=${(pv.speed*3.6).toFixed(0)} ${ai}] ` + race.racers.map(r => {
      const st = r.vehicle.state;
      return `${r.name.slice(0, 3)} ${dS(r.s, p.s).toFixed(0).padStart(4)}/${(r.lateral ?? 0).toFixed(1).padStart(5)}/${(st.speed * 3.6).toFixed(0).padStart(3)}${st.onTrack ? '' : '!'}`;
    }).join(' '));
    g.simulate(0.25);
  }
  return log;
}, [frac, speed, spread, lead, settle]);
console.log('t     ' + 'name  gap/lat/kmh   (! = off track)');
console.log(out.join('\n'));
await browser.close();
