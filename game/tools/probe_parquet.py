import io, os, requests, pyarrow.parquet as pq
URL="https://overturemaps-us-west-2.s3.amazonaws.com/release/2026-08-19.0/theme=buildings/type=building/part-00000-66390f89-3dae-58d7-a8f9-dd8538b7141a-c000.zstd.parquet"
s=requests.Session()
def rng(a,b):
    r=s.get(URL,headers={"Range":f"bytes={a}-{b}"},timeout=90); r.raise_for_status(); return r.content
head=s.head(URL,timeout=60); size=int(head.headers["Content-Length"]); print("size",size,"accept-ranges",head.headers.get("Accept-Ranges"))
tail=rng(size-8,size-1); print("magic",tail[4:])
flen=int.from_bytes(tail[0:4],"little"); print("footer len",flen)
foot=rng(size-8-flen,size-1)
class F(io.RawIOBase):
    def __init__(s_): s_.pos=0
    def readable(s_): return True
    def seekable(s_): return True
    def seek(s_,o,w=0):
        s_.pos = o if w==0 else (s_.pos+o if w==1 else size+o); return s_.pos
    def tell(s_): return s_.pos
    def readinto(s_,b):
        nb=len(b); d=rng(s_.pos,min(s_.pos+nb,size)-1); b[:len(d)]=d; s_.pos+=len(d); return len(d)
f=pq.ParquetFile(io.BufferedReader(F(),buffer_size=1<<20))
m=f.metadata
print("rows",m.num_rows,"rowgroups",m.num_row_groups)
print("schema fields:", [m.schema.column(i).name for i in range(min(12,m.schema.num_columns))])
rg=m.row_group(0)
for i in range(m.schema.num_columns):
    nm=m.schema.column(i).name
    if "bbox" in nm:
        st=rg.column(i).statistics
        print(nm, st.min, st.max)
