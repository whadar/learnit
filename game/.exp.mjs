// .exp.mjs <view> <outprefix> <js1> [js2 ...]
// Replays the canonical view order so the sim state matches shots/review, then renders the
// target view once per mutation inside ONE evaluate (sim frozen between renders).
import { chromium } from 'playwright';
import fs from 'node:fs';
const CHROME='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const URL='http://127.0.0.1:4173/?review=1&audio=0&q=high';
const ORDER=['gridStart','villageStreet','oliveGrove','hilltopVista','driftCorner','itemChaos','photoFinish','introFlythrough'];
const view=process.argv[2], out=process.argv[3];
const muts=process.argv.slice(4);
const b=await chromium.launch({executablePath:CHROME,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1']});
const p=await b.newPage({viewport:{width:1280,height:720}});
const logs=[]; p.on('pageerror',e=>logs.push('[err] '+e.message)); p.on('console',m=>{if(m.type()==='error')logs.push('[c] '+m.text());});
await p.goto(URL,{waitUntil:'load',timeout:180000});
await p.waitForFunction(()=>window.__game&&(window.__game.ready||window.__game.error),null,{timeout:600000});
const settle=n=>p.evaluate(k=>new Promise(r=>{let i=0;const s=()=>(++i>=k?r():requestAnimationFrame(s));requestAnimationFrame(s);}),n);
for(const v of ORDER){ await p.evaluate(x=>window.__game.setView(x), v); await settle(8); if(v===view) break; }
const imgs = await p.evaluate((ms)=>{
  const g=window.__game; const cv=g.engine.renderer.domElement; const res=[];
  for(const m of ms){ try{ (0,eval)(m); }catch(e){ console.error('mut fail '+e.message); } g.renderOnce(); res.push(cv.toDataURL('image/png')); }
  return res;
}, muts);
imgs.forEach((d,k)=>fs.writeFileSync(`/home/user/learnit/game/shots/${out}${k}.png`, Buffer.from(d.split(',')[1],'base64')));
console.log(logs.join('\n')||'ok');
await b.close();
