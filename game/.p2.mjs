import { chromium } from 'playwright';
const CHROME='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const VIEW = process.argv[2] || 'driftCorner';
const b=await chromium.launch({executablePath:CHROME,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1']});
const p=await b.newPage({viewport:{width:1280,height:720}});
p.on('pageerror',e=>console.log('[pageerror]',e.message));
await p.goto('http://127.0.0.1:4173/?review=1&audio=0&q=high',{waitUntil:'load',timeout:180000});
await p.waitForFunction(()=>window.__game&&(window.__game.ready||window.__game.error),null,{timeout:600000});
await p.evaluate(n=>window.__game.setView(n),VIEW);
const frames = n=>p.evaluate(k=>new Promise(r=>{let i=0;const s=()=>(++i>=k?r():requestAnimationFrame(s));requestAnimationFrame(s);}),n);
const snap = ()=>p.evaluate(()=>{
  const g=window.__game;
  const v=g.systems.vfx;
  const r=v?.rigs?.[0];
  const cam=g.engine.camera; const cp=new g.THREE.Vector3(); cam.getWorldPosition(cp);
  return { t:v?.time, st:r?{...r.state}:null, ev:r?{...r.events}:null,
    add:v?.batches.add.alive(v.time), alpha:v?.batches.alpha.alive(v.time),
    cam:[+cp.x.toFixed(1),+cp.y.toFixed(1),+cp.z.toFixed(1)] };
});
for (let i=0;i<10;i++){ await frames(1); console.log(JSON.stringify(await snap())); }
await b.close();
