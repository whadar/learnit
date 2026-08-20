import { makeGradeLUT } from '../../src/render/materials/postShaders.js';
const IN=[[0.59719,0.35458,0.04823],[0.07600,0.90834,0.01566],[0.02840,0.13383,0.83777]];
const OUT=[[1.60475,-0.53108,-0.07367],[-0.10208,1.10813,-0.00605],[-0.00327,-0.07276,1.07602]];
const mul=(m,v)=>m.map(r=>r[0]*v[0]+r[1]*v[1]+r[2]*v[2]);
const fit=v=>v.map(x=>((x*(x+0.0245786)-0.000090537)/(x*(0.983729*x+0.432951)+0.238081)));
const aces=c=>{let d=mul(IN,c.map(x=>x/0.6));d=fit(d);d=mul(OUT,d);return d.map(x=>Math.min(1,Math.max(0,x)));};
const enc=x=>x<=0.0031308?x*12.92:1.055*Math.pow(x,1/2.4)-0.055;
const lut=makeGradeLUT(); const D=lut.image.data, N=32, W=N*N;
function lookup(c){
  const f=c.map(v=>Math.min(1,Math.max(0,v))*(N-1));
  const z0=Math.floor(f[2]), z1=Math.min(z0+1,N-1), t=f[2]-z0;
  const g=Math.round(f[1]);
  const sample=(z)=>{const x0=Math.floor(f[0]),x1=Math.min(x0+1,N-1),tx=f[0]-x0;
    const p=(xi)=>{const i=((g*W)+(z*N+xi))*4;return [D[i]/255,D[i+1]/255,D[i+2]/255];};
    const a=p(x0),b=p(x1);return a.map((v,k)=>v+(b[k]-v)*tx);};
  const a=sample(z0),b=sample(z1);return a.map((v,k)=>v+(b[k]-v)*t);
}
const cases={'plaster sunlit':[1.35,1.30,1.20],'plaster shade':[0.30,0.32,0.38],'terracotta':[0.62,0.20,0.11],'olive foliage':[0.10,0.16,0.06],'dry soil':[0.42,0.29,0.17],'sky zenith':[0.30,0.45,0.85],'cloud':[1.9,1.9,1.95],'mid grey':[0.18,0.18,0.18],'asphalt':[0.05,0.05,0.055]};
const sat=(c,s)=>{const l=0.2126*c[0]+0.7152*c[1]+0.0722*c[2];return c.map(v=>l+(v-l)*s);};
for(const k in cases){
  const raw=aces(cases[k]).map(enc);
  const gr=lookup(raw);
  const dl=(a)=>Math.sqrt(a.reduce((s,v,i)=>s+(v-((0.2126*a[0]+0.7152*a[1]+0.0722*a[2])))**2,0));
  console.log(k.padEnd(15),'raw',raw.map(x=>x.toFixed(3)).join(' '),' -> grade',gr.map(x=>x.toFixed(3)).join(' '),
    ' chroma', dl(raw).toFixed(3),'->',dl(gr).toFixed(3));
}
