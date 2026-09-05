import sys, json, time, os, concurrent.futures as cf; sys.path.insert(0,'tools')
from ov_common import *
LON,LAT=35.0208,32.5636
parts=list_parts('buildings','building')
CACHE='data/ov_building_index.json'
idx=json.load(open(CACHE)) if os.path.exists(CACHE) else {}
todo=[i for i in range(len(parts)) if str(i) not in idx]
sel=[i for i in todo if i%int(sys.argv[1] if len(sys.argv)>1 else 4)==0][:int(sys.argv[2] if len(sys.argv)>2 else 128)]
def summ(i):
    try:
        md=pf(parts[i]).metadata; bc=bbox_cols(md)
        rgs=[]
        for g in range(md.num_row_groups):
            rg=md.row_group(g)
            rgs.append([rg.column(bc['xmin']).statistics.min, rg.column(bc['xmax']).statistics.max,
                        rg.column(bc['ymin']).statistics.min, rg.column(bc['ymax']).statistics.max])
        return i,rgs
    except Exception as e: return i,None
t0=time.time()
with cf.ThreadPoolExecutor(16) as ex:
    for i,rgs in ex.map(summ,sel):
        if rgs: idx[str(i)]=rgs
json.dump(idx,open(CACHE,'w'))
hits=[]
for k,rgs in idx.items():
    for g,(x0,x1,y0,y1) in enumerate(rgs):
        if x0<=LON<=x1 and y0<=LAT<=y1: hits.append((int(k),g))
print("scanned",len(idx),"files in",round(time.time()-t0,1),"s; hits:",hits[:20])
