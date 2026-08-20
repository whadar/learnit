import sys, json; sys.path.insert(0,'tools')
from ov_common import *
import shapely.wkb as swkb
LON,LAT=35.0208,32.5636
HALF_LON,HALF_LAT=0.020,0.017   # ~1.9km x 1.9km half-extents
W,E,Sq,N=LON-HALF_LON,LON+HALF_LON,LAT-HALF_LAT,LAT+HALF_LAT
parts=list_parts('buildings','building')
f=pf(parts[218]); md=f.metadata; bc=bbox_cols(md)
names=[md.schema.column(i).name for i in range(len(md.schema.names))]
tbl=f.read_row_group(86)
print("cols:", tbl.column_names)
import pyarrow.compute as pc
d=tbl.to_pylist()
out=[]
for r in d:
    bb=r.get('bbox') or {}
    if bb.get('xmax',-999)<W or bb.get('xmin',999)>E or bb.get('ymax',-999)<Sq or bb.get('ymin',999)>N: continue
    g=swkb.loads(bytes(r['geometry']))
    out.append({'id':r.get('id'),'class':r.get('class'),'subtype':r.get('subtype'),
        'height':r.get('height'),'levels':r.get('num_floors'),'roof_shape':r.get('roof_shape'),
        'roof_material':r.get('roof_material'),'roof_color':r.get('roof_color'),
        'facade_material':r.get('facade_material'),'facade_color':r.get('facade_color'),
        'names': (r.get('names') or {}).get('primary') if isinstance(r.get('names'),dict) else None,
        'geom': [list(map(lambda c:[round(c[0],7),round(c[1],7)], g.exterior.coords))] +
                [list(map(lambda c:[round(c[0],7),round(c[1],7)], i.coords)) for i in g.interiors]
                if g.geom_type=='Polygon' else
                [list(map(lambda c:[round(c[0],7),round(c[1],7)], p.exterior.coords)) for p in g.geoms]})
json.dump({'center':[LAT,LON],'bbox':[W,Sq,E,N],'count':len(out),'buildings':out},open('data/amikam-buildings.json','w'))
print("buildings in bbox:",len(out))
hs=[b['height'] for b in out if b['height']]
print("with height:",len(hs), "median", sorted(hs)[len(hs)//2] if hs else None)
print("classes:", {c:sum(1 for b in out if b['class']==c) for c in set(b['class'] for b in out)})
print("named:", [b['names'] for b in out if b['names']][:10])
