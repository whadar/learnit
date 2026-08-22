import { chromium } from 'playwright';
const CHROME='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const URL='http://127.0.0.1:4173/?review=1&audio=0&q=high';
const b=await chromium.launch({executablePath:CHROME,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1']});
const p=await b.newPage({viewport:{width:1280,height:720}});
const logs=[]; p.on('console',m=>logs.push(`[${m.type()}] ${m.text()}`)); p.on('pageerror',e=>logs.push(`[pageerror] ${e.message}`));
await p.goto(URL,{waitUntil:'load',timeout:180000});
await p.waitForFunction(()=>window.__game&&(window.__game.ready||window.__game.error),null,{timeout:600000});
await p.evaluate(()=>window.__game.setView('photoFinish'));
await p.evaluate(()=>new Promise(r=>{let i=0;const s=()=>(++i>=10?r():requestAnimationFrame(s));requestAnimationFrame(s);}));
const out = await p.evaluate(()=>{
  const g=window.__game, sc=g.engine.scene, THREE=g.THREE||null;
  let contact=null; const racers=[];
  sc.traverse(o=>{ if(o.name==='lighting:contact') contact=o; if(/^racer:/.test(o.name||'')) racers.push(o); });
  const cp = racers.slice(0,3).map(o=>{const v=new (o.position.constructor)();o.getWorldPosition(v);return {name:o.name,y:+v.y.toFixed(3),x:+v.x.toFixed(2),z:+v.z.toFixed(2),vis:o.visible,gy:+(g.world.heightAt(v.x,v.z)).toFixed(3)};});
  const sky=g.engine.lighting? {}:{};
  const L=g.engine.lighting;
  return {
    contact: contact? {count:contact.count, visible:contact.visible, renderOrder:contact.renderOrder, opacity:contact.material.opacity, blending:contact.material.blending}:null,
    racers: cp, nRacers:racers.length,
    sunDir: L? [ +L.sun.position.x.toFixed(1),+L.sun.position.y.toFixed(1),+L.sun.position.z.toFixed(1)]:null,
    sunIntensity: L?.sun?.intensity, envInt: sc.environmentIntensity,
    hemi: L? {i:L.hemi.intensity, sky:L.hemi.color.getHexString(), ground:L.hemi.groundColor.getHexString()}:null,
    bounce: L? {i:L.bounce.intensity}:null,
    elev: g.S?.sky?.elevation, azim: g.S?.sky?.azimuth,
    exposure: g.engine.renderer.toneMappingExposure,
    shadowType: g.engine.renderer.shadowMap.type,
  };
});
console.log(JSON.stringify(out,null,1));
console.log(logs.slice(0,20).join('\n'));
await b.close();
