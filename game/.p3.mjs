import { chromium } from 'playwright';
const CHROME='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const b=await chromium.launch({executablePath:CHROME,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1']});
const p=await b.newPage({viewport:{width:1280,height:720}});
p.on('pageerror',e=>console.log('[pageerror]',e.message));
await p.goto('http://127.0.0.1:4173/?review=1&audio=0&q=high',{waitUntil:'load',timeout:180000});
await p.waitForFunction(()=>window.__game&&(window.__game.ready||window.__game.error),null,{timeout:600000});
const frames = n=>p.evaluate(k=>new Promise(r=>{let i=0;const s=()=>(++i>=k?r():requestAnimationFrame(s));requestAnimationFrame(s);}),n);
for (const v of ['gridStart','villageStreet','oliveGrove','itemChaos','photoFinish','driftCorner']){
  await p.evaluate(n=>window.__game.setView(n),v);
  await frames(8);
  const o = await p.evaluate(()=>{const g=window.__game;const V=g.systems.vfx;const r=V.rigs[0];
    return {st:{...r.state}, ev:{...r.events}, add:V.batches.add.alive(V.time), alpha:V.batches.alpha.alive(V.time)};});
  console.log(v, JSON.stringify(o));
}
await b.close();
