const D2R=Math.PI/180,R2D=180/Math.PI;
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const lerp=(a,b,t)=>a+(b-a)*t;
const smoothstep=(e0,e1,x)=>{const t=clamp((x-e0)/(e1-e0),0,1);return t*t*(3-2*t);};
function solarPosition(lat,lon,dayOfYear,localHour,tzOffset){
  const g=(2*Math.PI/365)*(dayOfYear-1+(localHour-12)/24);
  const eqTime=229.18*(0.000075+0.001868*Math.cos(g)-0.032077*Math.sin(g)-0.014615*Math.cos(2*g)-0.040849*Math.sin(2*g));
  const decl=0.006918-0.399912*Math.cos(g)+0.070257*Math.sin(g)-0.006758*Math.cos(2*g)+0.000907*Math.sin(2*g)-0.002697*Math.cos(3*g)+0.00148*Math.sin(3*g);
  const timeOffset=eqTime+4*lon-60*tzOffset;
  const tst=localHour*60+timeOffset;
  const ha=(tst/4-180)*D2R;const la=lat*D2R;
  const cosZ=Math.sin(la)*Math.sin(decl)+Math.cos(la)*Math.cos(decl)*Math.cos(ha);
  const zenith=Math.acos(clamp(cosZ,-1,1));
  let az=Math.acos(clamp((Math.sin(la)*Math.cos(zenith)-Math.sin(decl))/(Math.cos(la)*Math.sin(zenith)||1e-6),-1,1));
  az=ha>0?(Math.PI+az):(Math.PI-az);
  return {elevation:90-zenith*R2D,azimuth:(az*R2D+360)%360};
}
const sunDirection=(el,az)=>{el*=D2R;az*=D2R;const c=Math.cos(el);return [c*Math.sin(az),Math.sin(el),-c*Math.cos(az)];};
const BETA_R0=[5.804542996261093e-6,1.3562911419845635e-5,3.0265902468824876e-5];
const MIE_K=[1.8399918514433978e14,2.7798023919660528e14,4.0790479543861094e14];
const RAY_Z=8.4e3,MIE_Z=1.25e3,CUTOFF=1.6110731556870734,STEEP=1.5,EE=1000;
const dot3=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const _IN=[[0.59719,0.35458,0.04823],[0.07600,0.90834,0.01566],[0.02840,0.13383,0.83777]];
const _OUT=[[1.60475,-0.53108,-0.07367],[-0.10208,1.10813,-0.00605],[-0.00327,-0.07276,1.07602]];
const mul3=(m,v)=>m.map(r=>r[0]*v[0]+r[1]*v[1]+r[2]*v[2]);
function aces(rgb,ex=1){let v=mul3(_IN,rgb.map(x=>Math.max(x,0)*ex/0.6));
 v=v.map(x=>(x*(x+0.0245786)-0.000090537)/(x*(0.983729*x+0.4329510)+0.238081));
 return mul3(_OUT,v).map(x=>clamp(x,0,1));}
const s2=v=>(v<=0.0031308?v*12.92:1.055*Math.pow(Math.max(v,0),1/2.4)-0.055);

const P={turbidity:2.05,rayleigh:3.5,mie:0.0019,mieG:0.72,exposure:0.215,skySat:1.36,tone:0.73};
const sp=solarPosition(32.5636,35.0208,196,15.4,3);
const sd=sunDirection(sp.elevation,sp.azimuth);
const sunfade=1-clamp(1-Math.exp(sd[1]*1000/450),0,1);
const rc=P.rayleigh-(1-sunfade);
const betaR=BETA_R0.map(v=>v*rc);
const c=0.2*P.turbidity*1e-17;
const betaM=MIE_K.map(v=>0.434*c*v*P.mie);
const zc=clamp(sd[1],-1,1);
const sunE=EE*Math.max(0,1-Math.exp(-((CUTOFF-Math.acos(zc))/STEEP)));

function rad(dir,opt={}){
  const y=Math.max(0,dir[1]);
  const za=Math.acos(y);
  let inv=1/(Math.cos(za)+0.15*Math.pow(93.885-za*R2D,-1.253));
  let invE=inv;
  if(opt.K){const e=Math.max(inv-1,0);invE=1+e*opt.K/(e+opt.K);}
  const sR=RAY_Z*invE,sM=MIE_Z*invE;
  const Fex=[0,1,2].map(i=>Math.exp(-(betaR[i]*sR+betaM[i]*sM)));
  const cosT=dot3(dir,sd);
  const rP=0.05968310365946075*(1+Math.pow(cosT*0.5+0.5,2));
  const g=P.mieG,g2=g*g;
  const mP=0.07957747154594767*((1-g2)/Math.pow(1-2*g*cosT+g2,1.5));
  const out=[0,0,0];
  const up=clamp(Math.pow(1-sd[1],5),0,1);
  for(let i=0;i<3;i++){
    const bR=betaR[i]*rP,bM=betaM[i]*mP;
    const ratio=(bR+bM)/(betaR[i]+betaM[i]);
    let Lin=Math.pow(sunE*ratio*(1-Fex[i]),1.5);
    Lin*=lerp(1,Math.pow(Math.max(sunE*ratio*Fex[i],0),0.5),up);
    out[i]=Lin*0.04;
  }
  out[1]+=0.0006;out[2]+=0.0016;
  return {sky:out,cosT,inv};
}
function shade(elev,azOff,opt={}){
  const dir=sunDirection(elev,(sp.azimuth+azOff+360)%360);
  let {sky,cosT}=rad(dir,opt);
  // haze
  const hz=1-smoothstep(opt.hz0??-0.015,opt.hz1??0.115,dir[1]);
  const hh=opt.horizonHaze??(0.13+0.20*smoothstep(22,2,sp.elevation));
  const skyL=Math.max(0.2126*sky[0]+0.7152*sky[1]+0.0722*sky[2],0);
  const tint=opt.tint??[1.03,1.0,0.95];
  let haze=tint.map(x=>x*skyL*1.0);
  const m=lerp(1,1.10,Math.pow(Math.max(cosT,0),6));
  haze=haze.map(x=>x*m);
  sky=sky.map((v,i)=>lerp(v,haze[i],hz*hh));
  // aureole
  const aur=Math.pow(Math.max(cosT,0),7);
  const au=[1.14,0.98,0.78];
  sky=sky.map((v,i)=>v*lerp(1,au[i],aur*0.55));
  // sun glow (skip disc)
  sky=sky.map(v=>v*P.exposure);
  const sl=0.2126*sky[0]+0.7152*sky[1]+0.0722*sky[2];
  const sat=opt.sat??P.skySat;
  sky=sky.map(v=>Math.max(lerp(sl,v,sat),0));
  const disp=aces(sky,P.tone).map(s2);
  return disp.map(v=>Math.round(v*255));
}
import { grade } from './_skypredict.mjs';
function hsvSat(c){const mx=Math.max(...c),mn=Math.min(...c);return mx?(mx-mn)/mx:0;}
function hue(c){const mx=Math.max(...c),mn=Math.min(...c),d=mx-mn;if(d<1e-6)return 0;
 let h;if(mx===c[0])h=60*((((c[1]-c[2])/d)%6)+6)%360;else if(mx===c[1])h=60*(((c[2]-c[0])/d)+2);else h=60*(((c[0]-c[1])/d)+4);return ((h%360)+360)%360;}
console.log('sun elev',sp.elevation.toFixed(1),'az',sp.azimuth.toFixed(1));
console.log('MK8 target 60,140,230 -> s0.739 h212');
const base={hz0:-0.020,hz1:0.048,horizonHaze:0.10};
for(const opt of [{name:'K1.6 s1.36',K:1.6,...base},{name:'K1.25 s1.45',K:1.25,sat:1.45,...base},{name:'K1.0 s1.5',K:1.0,sat:1.50,...base},{name:'K0.85 s1.55',K:0.85,sat:1.55,...base},{name:'K1.0 s1.36',K:1.0,...base}]){
  console.log('--',opt.name);
  for(const el of [2,6,12,20,40]){
    let line='';
    for(const az of [30,90,155]){
      const c=grade(shade(el,az,opt));
      line+=`el${el} az${az} (${c.join(',')}) s${hsvSat(c).toFixed(2)} h${hue(c).toFixed(0)}   `;
    }
    console.log(line);
  }
}
