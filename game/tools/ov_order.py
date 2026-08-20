import sys, concurrent.futures as cf; sys.path.insert(0,'tools')
from ov_common import *
parts=list_parts('buildings','building')
def summ(i):
    md=pf(parts[i]).metadata; bc=bbox_cols(md)
    xs=[];ys=[]
    for g in (0, md.num_row_groups-1):
        rg=md.row_group(g)
        xs+= [rg.column(bc['xmin']).statistics.min, rg.column(bc['xmax']).statistics.max]
        ys+= [rg.column(bc['ymin']).statistics.min, rg.column(bc['ymax']).statistics.max]
    return i, round(min(xs),2), round(max(xs),2), round(min(ys),2), round(max(ys),2), md.num_row_groups
with cf.ThreadPoolExecutor(8) as ex:
    for r in ex.map(summ,[0,64,128,192,256,320,384,448,511]):
        print("file %3d  lon[%8.2f,%8.2f] lat[%7.2f,%7.2f] rg=%d"%r)
