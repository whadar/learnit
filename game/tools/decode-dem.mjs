import fs from 'node:fs'; import { PNG } from 'pngjs';
const Z=15, n=2**Z, R=2, cx=19570, cy=13246, T=256;
const W=(2*R+1)*T, H=W; const h=new Float32Array(W*H); let mn=1e9,mx=-1e9;
for(let ty=cy-R;ty<=cy+R;ty++)for(let tx=cx-R;tx<=cx+R;tx++){
  const p=PNG.sync.read(fs.readFileSync(`data/dem/${Z}_${tx}_${ty}.png`));
  const ox=(tx-(cx-R))*T, oy=(ty-(cy-R))*T;
  for(let y=0;y<T;y++)for(let x=0;x<T;x++){
    const i=(y*T+x)*4, e=p.data[i]*256+p.data[i+1]+p.data[i+2]/256-32768;
    h[(oy+y)*W+(ox+x)]=e; if(e<mn)mn=e; if(e>mx)mx=e;
  }
}
const lon2x=l=>(l+180)/360*n, lat2y=l=>{const r=l*Math.PI/180;return (1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*n;};
const px=(lon2x(35.0106)-(cx-R))*T, py=(lat2y(32.5586)-(cy-R))*T;
console.log(JSON.stringify({grid:[W,H],min:+mn.toFixed(1),max:+mx.toFixed(1),
  amikam_center_elev:+h[Math.round(py)*W+Math.round(px)].toFixed(1),
  west:(cx-R)/n*360-180, east:(cx+R+1)/n*360-180,
  metersPerPixel:+(156543.03392*Math.cos(32.5586*Math.PI/180)/n).toFixed(2)}));
fs.writeFileSync('data/amikam-dem.f32', Buffer.from(h.buffer));
