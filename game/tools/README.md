# Real-world data pipeline (Moshav Amikam)

The Amikam Village Circuit is built on genuine geographic data, not invented terrain.
Everything under `data/` and `public/data/` is reproducible from these scripts.

| Layer | Source | Script |
|---|---|---|
| Elevation | AWS Terrain Tiles (`elevation-tiles-prod`), terrarium-encoded PNG, z15, SRTM 1-arcsec derived | `fetch-dem.mjs` |
| Buildings, roads, land use, land cover, water | Overture Maps Foundation release `2026-08-19.0` (OSM-derived), GeoParquet on S3 | `ov_extract.py`, `ov_theme.py` |
| Game world asset | conversion to a metric ENU grid | `build-world.mjs` |

## Regenerating

```bash
node tools/fetch-dem.mjs                    # 25 terrarium tiles around 32.5636 N, 35.0208 E
python3 tools/ov_scan.py 1 512              # locate the parquet row group holding Amikam
python3 tools/ov_extract.py                 # 552 building footprints
python3 tools/ov_theme.py transportation segment
python3 tools/ov_theme.py base land_use
python3 tools/ov_theme.py base water
python3 tools/ov_theme.py base land_cover
node tools/build-world.mjs                  # -> public/data/amikam.json + amikam-height.bin
```

`ov_common.py` reads the Overture parquet files by HTTP range request and uses the per-row-group
`bbox` statistics to pull only the few megabytes covering Amikam out of a 512-file, ~270 GB
dataset — the whole extraction runs in well under a minute.

## Verification

`dem-check.mjs` samples the terrarium decode at points of known elevation and is the check that
the heightfield is real rather than plausible-looking noise:

| Point | Decoded | Published |
|---|---|---|
| Jerusalem, Old City | 741 m | ~760 m |
| Dead Sea shore | −412 m | ~−420 m |
| Tel Aviv beach | 1 m | ~5 m |
| Mount Carmel high ground | 512 m | 546 m |
| **Moshav Amikam** | **83 m** | **75–85 m** |

Differences are the expected effect of SRTM's 30 m posts and of "published" elevations being
single named points rather than grid samples.

## Screenshot harness

`shoot.mjs` drives the built game in headless Chromium (SwiftShader — no GPU needed), waits for
`window.__game.ready`, calls `setView()` for each named camera and captures PNGs. It is what the
visual-review agents look at.

```bash
npx vite preview --port 4173 --strictPort --host 127.0.0.1 &
SHOOT_OUT=shots/review SHOOT_VIEWS=gridStart,villageRun,hairpin node tools/shoot.mjs
```

Environment: `SHOOT_URL`, `SHOOT_OUT`, `SHOOT_VIEWS`, `SHOOT_W`, `SHOOT_H`, `SHOOT_WARM`.
