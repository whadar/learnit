import { chromium } from 'playwright';
const CHROME='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const URL='http://127.0.0.1:4173/?review=1&audio=0&q=high';
const b=await chromium.launch({executablePath:CHROME,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1']});
const p=await b.newPage({viewport:{width:1280,height:720}});
await p.goto(URL,{waitUntil:'load',timeout:180000});
await p.waitForFunction(()=>window.__game&&(window.__game.ready||window.__game.error),null,{timeout:600000});
await p.evaluate(()=>window.__game.setView('photoFinish'));
await p.evaluate(()=>new Promise(r=>{let i=0;const s=()=>(++i>=8?r():requestAnimationFrame(s));requestAnimationFrame(s);}));
const grab = async (on)=> p.evaluate(async (on)=>{
  const g=window.__game, sc=g.engine.scene;
  let contact=null; sc.traverse(o=>{ if(o.name==='lighting:contact') contact=o; });
  contact.visible=on;
  g.renderOnce(); g.renderOnce();
  const cv=g.engine.renderer.domElement;
  return cv.toDataURL('image/png');
}, on);
const a=await grab(true), c=await grab(false);
import('node:fs').then(fs=>{
  fs.writeFileSync('/home/user/learnit/game/shots/_c_on.png', Buffer.from(a.split(',')[1],'base64'));
  fs.writeFileSync('/home/user/learnit/game/shots/_c_off.png', Buffer.from(c.split(',')[1],'base64'));
});
await new Promise(r=>setTimeout(r,500));
await b.close();
