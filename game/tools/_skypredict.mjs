import { makeGradeLUT } from '../src/render/materials/postShaders.js';
const tex = makeGradeLUT({ saturation: 1.42, contrast: 1.10, shadeTint: 1.15, warmth: 0.97 });
const d = tex.image.data, N = 32;
function lut(rgb){ // trilinear over the 1024x32 strip
  const c = rgb.map(v=>Math.min(Math.max(v,0),1)*(N-1));
  const b0=Math.floor(c[2]), b1=Math.min(b0+1,N-1), bf=c[2]-b0;
  const samp=(bi)=>{
    const x0=Math.floor(c[0]), x1=Math.min(x0+1,N-1), xf=c[0]-x0;
    const y0=Math.floor(c[1]), y1=Math.min(y0+1,N-1), yf=c[1]-y0;
    const px=(xi,yi)=>{const i=((yi*(N*N))+(bi*N+xi))*4;return [d[i],d[i+1],d[i+2]];};
    const a=px(x0,y0),bb=px(x1,y0),cc=px(x0,y1),dd=px(x1,y1);
    return [0,1,2].map(k=>((a[k]*(1-xf)+bb[k]*xf)*(1-yf)+(cc[k]*(1-xf)+dd[k]*xf)*yf));
  };
  const s0=samp(b0), s1=samp(b1);
  return [0,1,2].map(k=>(s0[k]*(1-bf)+s1[k]*bf)/255);
}
export function grade(rgb255){
  let g = lut(rgb255.map(v=>v/255));
  const l = 0.2126*g[0]+0.7152*g[1]+0.0722*g[2];
  const sat = 1.02;                       // composite uSaturation, no punch/speed
  g = g.map(v=>l+(v-l)*sat);
  g = g.map(v=>(v-0.5)*1.0+0.5);          // uContrast 1.0, uLift 0
  return g.map(v=>Math.round(Math.min(Math.max(v,0),1)*255));
}
