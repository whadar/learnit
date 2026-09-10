import io, os, requests, pyarrow.parquet as pq
BUCKET="https://overturemaps-us-west-2.s3.amazonaws.com"
REL="release/2026-08-19.0"
S=requests.Session(); S.headers["User-Agent"]="amikam-extract"
class S3File(io.RawIOBase):
    def __init__(self,url):
        self.url=url; self.pos=0
        self.size=int(S.head(url,timeout=90).headers["Content-Length"])
    def readable(self): return True
    def seekable(self): return True
    def seek(self,o,w=0):
        self.pos = o if w==0 else (self.pos+o if w==1 else self.size+o); return self.pos
    def tell(self): return self.pos
    def readinto(self,b):
        nb=len(b); end=min(self.pos+nb,self.size)
        if end<=self.pos: return 0
        for attempt in range(5):
            try:
                r=S.get(self.url,headers={"Range":f"bytes={self.pos}-{end-1}"},timeout=180); r.raise_for_status(); d=r.content; break
            except Exception:
                if attempt==4: raise
        b[:len(d)]=d; self.pos+=len(d); return len(d)
def pf(url): return pq.ParquetFile(io.BufferedReader(S3File(url),buffer_size=1<<22))
def list_parts(theme,typ):
    keys=[]; tok=None
    while True:
        u=f"{BUCKET}/?list-type=2&prefix={REL}/theme%3D{theme}/type%3D{typ}/&max-keys=1000"
        if tok: u+="&continuation-token="+requests.utils.quote(tok,safe='')
        x=S.get(u,timeout=90).text
        keys+= [k.split("</Key>")[0] for k in x.split("<Key>")[1:]]
        if "<IsTruncated>true" in x: tok=x.split("<NextContinuationToken>")[1].split("<")[0]
        else: break
    return [f"{BUCKET}/{k}" for k in keys if k.endswith(".parquet")]
def bbox_cols(md):
    idx={}
    for i in range(md.row_group(0).num_columns):
        nm=md.row_group(0).column(i).path_in_schema
        if nm.startswith("bbox."): idx[nm.split(".")[1]]=i
    return idx
