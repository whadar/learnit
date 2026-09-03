"""
Pull one Overture theme for one place, straight off S3.

    python3 tools/ov_place.py dogpatch buildings building
    python3 tools/ov_place.py dogpatch transportation segment
    python3 tools/ov_place.py dogpatch base water

Overture ships as ~500 GeoParquet files per theme, far too much to download. Each file's footer
carries per-row-group statistics including a bbox, so reading only the footers (a few hundred KB
of HTTP range requests) is enough to find the handful of row groups covering a 3 km box, and only
those get read in full. The whole extract takes well under a minute.

This replaces ov_extract.py / ov_theme.py, which hard-coded Amikam's centre and — more
importantly — selected row groups by asking whether the group's bbox *contained the centre point*.
That works only by luck: a row group covering the northern half of the box and nothing else would
be skipped, silently losing every feature in it. Here the test is a real bbox intersection.
"""
import sys, json, os, concurrent.futures as cf
sys.path.insert(0, 'tools')
from ov_common import *
import shapely.wkb as swkb

slug, theme, typ = sys.argv[1], sys.argv[2], sys.argv[3]
P = json.load(open('tools/places.json'))[slug]
W, E = P['lon'] - P['halfLon'], P['lon'] + P['halfLon']
S_, N = P['lat'] - P['halfLat'], P['lat'] + P['halfLat']

parts = list_parts(theme, typ)


def hits(i):
    """Row groups in file `i` whose bbox intersects the query box."""
    try:
        md = pf(parts[i]).metadata
        bc = bbox_cols(md)
        out = []
        for g in range(md.num_row_groups):
            rg = md.row_group(g)
            x0 = rg.column(bc['xmin']).statistics.min
            x1 = rg.column(bc['xmax']).statistics.max
            y0 = rg.column(bc['ymin']).statistics.min
            y1 = rg.column(bc['ymax']).statistics.max
            if not (x1 < W or x0 > E or y1 < S_ or y0 > N):
                out.append(g)
        return i, out
    except Exception:
        return i, []


found = []
with cf.ThreadPoolExecutor(16) as ex:
    for i, gs in ex.map(hits, range(len(parts))):
        for g in gs:
            found.append((i, g))
print(f"{theme}/{typ}: {len(parts)} files -> {len(found)} row group(s) {found[:8]}", flush=True)


def rings(g):
    """Buildings: a flat list of rings, which is what build-world's `b.geom.map(ring)` wants."""
    r = lambda cs: [[round(c[0], 7), round(c[1], 7)] for c in cs]
    if g.geom_type == 'Polygon':
        return [r(g.exterior.coords)] + [r(i.coords) for i in g.interiors]
    if g.geom_type == 'MultiPolygon':
        return [r(p.exterior.coords) for p in g.geoms]
    return []


def geojson(g):
    """Everything else: real GeoJSON `coordinates`, because build-world's `lines()` switches on
    geom.type and indexes geom.coordinates by GeoJSON's nesting exactly. Returning a flat ring
    list here instead would nest a LineString one level too deep and quietly yield no road at
    all — the sort of thing that shows up as an empty circuit three steps later."""
    r = lambda cs: [[round(c[0], 7), round(c[1], 7)] for c in cs]
    t = g.geom_type
    if t == 'Point':            return [round(g.x, 7), round(g.y, 7)]
    if t == 'LineString':       return r(g.coords)
    if t == 'MultiLineString':  return [r(l.coords) for l in g.geoms]
    if t == 'Polygon':          return [r(g.exterior.coords)] + [r(i.coords) for i in g.interiors]
    if t == 'MultiPolygon':     return [[r(p.exterior.coords)] + [r(i.coords) for i in p.interiors]
                                        for p in g.geoms]
    return []


def inbox(bb):
    return not (bb.get('xmax', -999) < W or bb.get('xmin', 999) > E
                or bb.get('ymax', -999) < S_ or bb.get('ymin', 999) > N)


def name_of(r):
    n = r.get('names')
    return n.get('primary') if isinstance(n, dict) else None


out = []
for i, g in found:
    for r in pf(parts[i]).read_row_group(g).to_pylist():
        if not inbox(r.get('bbox') or {}):
            continue
        geom = swkb.loads(bytes(r['geometry']))
        if theme == 'buildings':
            out.append({
                'id': r.get('id'), 'class': r.get('class'), 'subtype': r.get('subtype'),
                'height': r.get('height'), 'levels': r.get('num_floors'),
                'roof_shape': r.get('roof_shape'), 'roof_material': r.get('roof_material'),
                'roof_color': r.get('roof_color'), 'facade_material': r.get('facade_material'),
                'facade_color': r.get('facade_color'), 'names': name_of(r),
                'geom': rings(geom),
            })
        else:
            out.append({
                'class': r.get('class'), 'subtype': r.get('subtype'), 'name': name_of(r),
                'surface': r.get('surface'), 'road_surface': r.get('road_surface'),
                'width': r.get('width'), 'subclass': r.get('subclass'),
                'geom': {'type': geom.geom_type, 'coordinates': geojson(geom)},
            })

os.makedirs('data', exist_ok=True)
if theme == 'buildings':
    path = f'data/{slug}-buildings.json'
    json.dump({'center': [P['lat'], P['lon']], 'bbox': [W, S_, E, N],
               'count': len(out), 'buildings': out}, open(path, 'w'))
else:
    path = f'data/{slug}-{theme}-{typ}.json'
    json.dump({'center': [P['lat'], P['lon']], 'bbox': [W, S_, E, N],
               'count': len(out), 'features': out}, open(path, 'w'))

print(f"  -> {path}  {len(out)} features  {os.path.getsize(path)/1e6:.2f} MB")
