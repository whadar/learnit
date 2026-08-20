import sys, json, os, concurrent.futures as cf; sys.path.insert(0,'tools')
from ov_common import *
import shapely.wkb as swkb
from shapely.geometry import box, mapping
LON,LAT=35.0208,32.5636; HL,HA=0.020,0.017
W,E,S_,N=LON-HL,LON+HL,LAT-HA,LAT+HA; BB=box(W,S_,E,N)
theme,typ=sys.argv[1],sys.argv[2]
parts=list_parts(theme,typ)
def summ(i):
    try:
        md=pf(parts[i]).metadata; bc=bbox_cols(md); hits=[]
        for g in range(md.num_row_groups):
            rg=md.row_group(g)
            x0=rg.column(bc['xmin']).statistics.min; x1=rg.column(bc['xmax']).statistics.max
            y0=rg.column(bc['ymin']).statistics.min; y1=rg.column(bc['ymax']).statistics.max
            if x0<=LON<=x1 and y0<=LAT<=y1: hits.append(g)
        return i,hits
    except Exception: return i,[]
found=[]
with cf.ThreadPoolExecutor(16) as ex:
    for i,h in ex.map(summ,range(len(parts))):
        for g in h: found.append((i,g))
print(theme,typ,"row groups:",found)
KEEP=['id','names','subtype','class','subclass','surface','width','road_surface','level','is_intersection','connectors','routes','road_flags','speed_limits','access_restrictions']
out=[]
for i,g in found:
    tbl=pf(parts[i]).read_row_group(g)
    cols=set(tbl.column_names)
    for r in tbl.to_pylist():
        bb=r.get('bbox') or {}
        if bb.get('xmax',-999)<W or bb.get('xmin',999)>E or bb.get('ymax',-999)<S_ or bb.get('ymin',999)>N: continue
        geo=swkb.loads(bytes(r['geometry']))
        try: geo=geo.intersection(BB)
        except Exception: pass
        if geo.is_empty: continue
        rec={k:r[k] for k in KEEP if k in cols and k not in ('connectors','routes')}
        nm=r.get('names'); rec['name']=nm.get('primary') if isinstance(nm,dict) else None
        gj=mapping(geo)
        def rd(o):
            if isinstance(o,(list,tuple)):
                if o and isinstance(o[0],(int,float)): return [round(float(o[0]),7),round(float(o[1]),7)]
                return [rd(v) for v in o]
            return o
        rec['geom']={'type':gj['type'],'coordinates':rd(gj['coordinates'])}
        out.append(rec)
fn=f"data/amikam-{theme}-{typ}.json"
json.dump({'bbox':[W,S_,E,N],'count':len(out),'features':out},open(fn,'w'),default=str)
print("wrote",fn,len(out))
from collections import Counter
print(Counter([r.get('class') or r.get('subtype') for r in out]).most_common(14))
