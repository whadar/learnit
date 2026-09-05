import { chromium } from 'playwright';
import fs from 'node:fs';
const CHROME='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const URL='http://127.0.0.1:4173/?review=1&audio=0&q=high';
const view=process.argv[2]||'oliveGrove';
const b=await chromium.launch({executablePath:CHROME,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1']});
const p=await b.newPage({viewport:{width:1280,height:720}});
await p.goto(URL,{waitUntil:'load',timeout:180000});
await p.waitForFunction(()=>window.__game&&(window.__game.ready||window.__game.error),null,{timeout:600000});
await p.evaluate(v=>window.__game.setView(v),view);
await p.evaluate(()=>new Promise(r=>{let i=0;const s=()=>(++i>=10?r():requestAnimationFrame(s));requestAnimationFrame(s);}));
const imgs = await p.evaluate(()=>{
  const g=window.__game, sc=g.engine.scene, L=g.engine.lighting, cv=g.engine.renderer.domElement, out=[];
  const set=(h,bo,e)=>{L.hemi.intensity=h;L.bounce.intensity=bo;sc.environmentIntensity=e;g.renderOnce();out.push(cv.toDataURL('image/png'));};
  set(0.425,0.384,0.78);   // 0 current
  set(0.125,0.160,0.35);   // 1 pre-change
  set(0.300,0.280,0.58);   // 2 middle
  set(0.360,0.320,0.66);   // 3 upper-middle
  return out;
});
imgs.forEach((d,k)=>fs.writeFileSync(`/home/user/learnit/game/shots/_amb${k}.png`, Buffer.from(d.split(',')[1],'base64')));
await b.close();
