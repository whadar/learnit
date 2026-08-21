import { chromium } from 'playwright';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT = '/tmp/claude-0/-home-user-learnit/8f6205af-22db-552b-aca3-2d3962bb4285/scratchpad';
const browser = await chromium.launch({ executablePath: CHROME,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1'] });
const page = await browser.newPage({ viewport:{width:1280,height:720}, deviceScaleFactor:1 });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:4188/?review=1&audio=0&q=high', { waitUntil:'load', timeout:180000 });
await page.waitForFunction(() => window.__game && (window.__game.ready||window.__game.error), null, {timeout:600000});
const settle = n => page.evaluate(k => new Promise(r=>{let i=0;const s=()=>(++i>=k?r():requestAnimationFrame(s));requestAnimationFrame(s);}), n);
await page.evaluate(() => window.__game.setView('itemChaos'));
await settle(6);
// kill all ambient so only direct sun + shadow remains
await page.evaluate(() => {
  const S = window.__game.systems, E = window.__game.engine;
  S.lighting.hemi.intensity = 0.02;
  if (S.lighting.bounce) S.lighting.bounce.intensity = 0.0;
  E.scene.environmentIntensity = 0.03;
  E.renderer.shadowMap.autoUpdate = true;
});
await settle(6);
await page.screenshot({ path: OUT+'/e_noamb.png', timeout: 180000 });
// low sun
await page.evaluate(() => { window.__game.systems.sky.setTimeOfDay(18.6); window.__game.engine.renderer.shadowMap.needsUpdate = true; });
await settle(8);
await page.screenshot({ path: OUT+'/e_lowsun.png', timeout: 180000 });
await browser.close();
