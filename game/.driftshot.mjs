import { chromium } from 'playwright';
const CHROME='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT=process.argv[2];
const b=await chromium.launch({executablePath:CHROME,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1']});
const p=await b.newPage({viewport:{width:1280,height:720}});
p.on('pageerror',e=>console.log('[pageerror]',e.message));
await p.goto('http://127.0.0.1:4173/?review=1&audio=0&q=high',{waitUntil:'load',timeout:180000});
await p.waitForFunction(()=>window.__game&&(window.__game.ready||window.__game.error),null,{timeout:600000});
await p.evaluate(()=>window.__game.setView('driftCorner'));
await p.evaluate(()=>window.__game.setScripted({throttle:1,steer:0.72,drift:1}));
const frames=n=>p.evaluate(k=>new Promise(r=>{let i=0;const s=()=>(++i>=k?r():requestAnimationFrame(s));requestAnimationFrame(s);}),n);
for(let i=0;i<8;i++){await frames(18);console.log(i,JSON.stringify(await p.evaluate(()=>{const r=window.__game.systems.vfx.rigs[0];return {t:r.state.tier,c:+r.state.charge.toFixed(2),d:r.state.drifting,g:r.state.grounded,s:r.state.surface};})));}
console.log(JSON.stringify(await p.evaluate(()=>{const V=window.__game.systems.vfx;const r=V.rigs[0];return {st:{...r.state},ev:{...r.events}};})));
await p.screenshot({path:OUT,timeout:180000});
await b.close();
