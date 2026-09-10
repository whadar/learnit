# Kat Racing — handover

A Three.js kart racer whose default course is the real Moshav Amikam (32.5636 N, 35.0208 E),
Ramot Menashe. Real SRTM terrain, 552 real building footprints, real road network.

This document is what someone picking the project up needs and cannot re-derive cheaply. It is
written for a reader who has not seen the build: what it is, how to run it, where the data comes
from, what the tooling measures, what is broken, and — most usefully — the two failure patterns
that cost this project most of its review effort.

---

## Running it

```bash
cd game
npm install
npm run dev                       # dev server
npm run build && npm run preview  # production build on :4173
```

**Standalone single file** — no server, no network, opens by double-click:

```bash
npx vite build --config vite.config.single.js
node tools/pack-single.mjs        # writes game/kat-racing.html (~4.5 MB)
```

`tools/pack-single.mjs` inlines the bundle and both data files. The 1025² Float32 heightfield is
requantised to uint16 over its own min/max (0.002 m precision on a 50–185 m range, half the
bytes) and expanded back before the game sees it; a `fetch` shim serves both from memory.

Controls: arrows/WASD, Space to hop and hold to drift, Ctrl for items, Esc to pause. On a coarse
pointer the touch UI builds itself and the menu hints switch to tap wording.

---

## Where the map comes from

Overpass and OpenTopoData are both blocked by the build environment's egress policy. The data
comes from AWS Open Data on S3 instead, which is reachable:

| Layer | Source |
|---|---|
| Elevation | AWS Terrain Tiles (`elevation-tiles-prod`), SRTM 1-arcsec derived, z15 terrarium |
| Buildings, roads, land use, land cover, water | Overture Maps Foundation `2026-08-19.0` |

Regenerate everything from source:

```bash
python3 tools/ov_common.py        # shared: S3 range-reader over Overture GeoParquet
python3 tools/ov_extract.py       # buildings for the Amikam bbox
python3 tools/ov_theme.py transportation segment   # and base/land_use, base/water, base/land_cover
node tools/fetch-dem.mjs          # terrarium tiles
node tools/build-world.mjs        # -> public/data/amikam.json + amikam-height.bin
```

The Overture reader is the non-obvious part. The buildings theme is 512 parquet files of ~500 MB
each; `ov_common.py` reads only the footers over HTTP range requests, uses per-row-group `bbox`
statistics to find the one row group covering Amikam (file 218, row group 86), and pulls just
that. The whole extraction runs in under a minute.

**Verify the DEM decoder before trusting it.** `tools/dem-check.mjs` samples points of known
elevation: Jerusalem 741 m (published ~760), Dead Sea −412 (~−420), Tel Aviv 1 (~5), Mount
Carmel 512 (546), Amikam 83 (75–85). Differences are SRTM's 30 m posts. This check caught a
wrong starting coordinate early — the published Amikam location is 32.5636 N, 35.0208 E, not
the 32.5581/35.0106 first used.

---

## Layout

```
src/core/         engine, quality tiers, input (keyboard/gamepad/touch), math
src/world/        worldData (height/normal/slope sampling), terrain, buildings,
                  roads, vegetation, sky
src/render/       lighting (sun, CSM, IBL, aerial perspective), post, particles,
                  decals, vfxLibrary, materials/*
src/track/        track (spline, checkpoints, grid), trackMesh (racing surface,
                  kerbs), furniture (trackside dressing)
src/physics/      vehicle (raycast suspension, slip-curve tyres, servoed drift),
                  collision
src/game/         race state machine, ai, items, itemMeshes, camera
src/characters/   cat (procedural drivers), kart (four chassis), roster
src/ui/           hud, menu, minimap
src/audio/        audio, engineSynth, sfx, surface, ambience, music, dsp, testkit
```

`docs/CONTRACT.md` is the engineering contract every module was built against — coordinates
(+X east, +Z south, +Y up, metres), colour management, determinism (`rng(seed)`, never
`Math.random()`), performance limits, module ownership. Read it before editing.

`window.__game` exposes `.systems .race .camera .views .setView(name) .drive(inputs, seconds)
.simulate(seconds) .setFixedStep(dt) .snapshot()` for harnesses.

---

## The tooling, and what each thing actually measures

| Tool | Measures | Blind to |
|---|---|---|
| `tools/shoot.mjs` | eight canonical still views | anything temporal |
| `tools/shoot-seq.mjs` | frame **sequences** + per-frame telemetry | — |
| `tools/popcheck.mjs` | temporal discontinuities (LOD pops) | *why* a discontinuity happened |
| `tools/guard.mjs` | road neutrality, drift-VFX presence, exposure clipping | shadows, road *texture* |
| `tools/sim/feel.mjs` | handling as numbers (9 benches) | how it feels to a human |
| `tools/sim/audio.mjs` | 228 cue checks via OfflineAudioContext | anything on the live resume path |
| `tools/smoke.mjs` | all 45 modules import cleanly | whether they work together |

**Read the "blind to" column.** Every false-confidence failure in this project came from
treating a green result as broader than it was. `sim/audio.mjs` passed 228 checks while shipping
an audible burst, because the burst was a transient at AudioContext *resume* and the offline
path keeps the master bus at full gain — the test structurally could not see the defect it
should have caught.

Three instruments had to be corrected before they could be trusted:

- A contact-shadow check reported a confident PASS while measuring the kart's own dark bodywork.
  **Deleted.**
- A drift-blowout check tripped three different ways on white liveries, kerb stripes and the
  kart's own white panels. **Deleted**, with a note that doing it properly needs the effect
  isolated (shoot twice, once with VFX off, and diff) rather than inferred.
- `sim/feel.mjs` first reported four failures that were all one harness bug — the kart spawned
  30 m off the ribbon and was auto-respawned mid-measurement. Fixing that introduced the
  opposite contamination (a tight-loop track meant the kart was permanently cornering and "top
  speed" read 39.8 km/h). Only on a neutral straight, with a wide apron the drift cannot exit,
  do the numbers mean anything.

**Validate any new check against a known-bad case.** `tools/guard.mjs` passes on the current
frames *and* still fails on the preserved `shots/review-r5` set. A check that has never failed
has not been tested.

---

## Two failure patterns that cost most of the review effort

### Misattribution

A defect is seen correctly and diagnosed wrongly, then survives every round because the fix goes
to the wrong file. Confirmed five times:

| Symptom | Blamed | Actually |
|---|---|---|
| Untextured cypress "cones" (3 rounds) | `world/vegetation.js` | `ConeGeometry` in `track/furniture.js` |
| Missing kart shadows (6 rounds) | shadow map | caster registration + AO pool buried under the road crown |
| Black crushing on thin geometry | `vegetation.js` | half-res GTAO with depth-reconstructed normals |
| Diagonal streak veil (3 rounds) | `sky.js`, `post.js` | `createSpeedFX` in `particles.js` |
| Residual streaks after that fix | `particles.js` (my fix) | the composite motion-blur tap loop |

The tell is a defect that recurs after being "fixed". Before naming a file, reason about which
system actually emits those pixels — and prove it. The cypress case was settled by hiding one
mesh and watching every cone vanish; the shadow case by rendering the same frame with
`depthTest = false`.

### Oscillation

Files that compose into the same pixel, edited by parallel agents on separate briefs, undo each
other. The drift VFX swung between a blown white blob and nothing at all four times. The asphalt
went blue "choppy water" → "grey camouflage fabric" → "curdled noise". Contact shadows were
verified fixed and regressed four times.

Mitigation: `tools/guard.mjs` fails on regression, and `docs/CONTRACT.md` carries both patterns
so any agent reads them first. The deeper fix is not to parallelise across files that share an
output.

---

## Quality: where it got to and why it stopped

Frames were scored against Mario Kart 8 Deluxe by three independent critics per round on a 0–95
rubric where 88+ means genuinely shipped-AAA. **Binding (minimum) score by round:**

```
47 → 54 → 56 → 63 → 61 → 60 → 57 → 58
                ^ peak (round 4)
```

The target was 88. It was not reached. The loop was stopped deliberately after round 8, because
three rounds of substantial work had produced no gain and two had gone backwards.

What went backwards and why is worth knowing: the round-4 fix phase was killed by a container
restart at 6 of 9 agents, and the partial state it left regressed the build — that alone
accounts for the 63 → 61 drop. A final attempt to fix the structural problem — one agent owning
the whole image (lighting, sky, post, postShaders, terrainMaterial, trackMesh) with a written
art direction — produced what the critics called *"a coherent palette, not a coherent lit
world"*, or *"one art direction applied to several different afternoons"*. It scored 58.

**Frame-scoring is blind to half the game.** A human playing the build for one minute found
inverted steering and an audio burst. Neither is visible in a still frame; both had survived
every round. The motion harness exists because of that, and found a latched drift readout on its
first run. Motion, control feel, sound quality, item balance and AI difficulty remain the least
reviewed parts of the game.

---

## Known defects

**Fixed in the round of 23 Aug** (all five were reported from actual play, not by any bench here;
each now has a permanent bench so it cannot come back silently)
- The whole field crept BACKWARDS off the grid for the ten seconds the lights were red: the hold
  was `brake: 1`, and a brake held at a standstill is how you ask `vehicle.js` to reverse.
- No opponent moved once a human took the wheel: `autopilot` gated `ai.control` for the entire
  field instead of for the player's kart alone. Every bench here runs `autopilot: true`.
- The touch controls mounted inside the renderer's `<canvas>`, where children are fallback
  content that never lays out — every on-screen control was 0x0 px, so the game had no working
  touch input at all, and with no Escape key a phone could not reach the pause menu or Restart.
- The title and character screens played the attract race's engine and tyres at full tilt.
- The engine's body resonances were baked into a grain played back at up to 3.9x, so they rode
  the pitch and it climbed into a mosquito. Peak band at full revs is now the fundamental;
  centroid 3384 -> 1804 Hz.

Covered by `tools/sim/grid.mjs`, `tools/restart.mjs`, `tools/touch.mjs`.

**Shadows** (most-cited, now correctly localised — see next section)
- Karts have no ground shadow in roughly half the chase views; where the AO fallback fires it is
  at the visibility floor.
- Nothing man-made casts: kerbs, marker posts, guardrails, hay bales, the start gantry,
  spectators, olive trunks.
- `src/world/buildings.js:859` emits the far building LOD with `shadow=false` at a 430 m shell
  distance, so the whole village in the hero vista is a non-occluder.
- One view over-paints instead: an opaque hard-edged black slab across ~13% of the lower frame.

**Colour and light**
- The last grade overshot downward — frame chroma 0.155–0.232 against its own 0.30–0.44 target,
  giving a milky, low-contrast image.
- Mid- and far-distance vegetation reads teal-emerald rather than olive/silver/khaki; only near
  foliage is correct. Ground still orange rather than ochre.
- Sky chroma varies 4.5× between views.
- A residual diagonal streak veil at speed, attributed to the motion-blur tap loop.

**Course design**
- Reads as a public road, not a circuit: a dashed white centreline runs down the racing surface,
  width varies with the source OSM geometry, corners are inherited road wiggle.
- Buildings are flat boxes with decal windows; a visible LOD seam in the hero vista.

**Motion** (first real run of the motion harness, 24 Aug — `shoot-seq` + `popcheck` + `camcheck`)
- A rival kart rides between the chase camera and the player and smears across the bottom of the
  frame. Measured on oliveGrove: the player is rock steady at 8.7-9.6 m from the camera and
  screen (638-654, 383-391), while P2 rides 2.6-3.2 m out — a third of the player's distance —
  projecting to y=681, 817 and 864 on a 720 px frame. The camera has no rival avoidance and no
  near-plane push. `popcheck` sees it as 8 pops in 13 frame pairs while the telemetry over the
  same frames is perfectly smooth; `tools/camcheck.mjs` fails on it directly. Not camera lag —
  the camera tracks the player almost perfectly.
- driftCorner carries an impact signature at frame 3->4: yaw rate flips +0.345 -> -2.736 rad/s
  in one 0.12 s step while speed drops 70 -> 45 km/h (about 5.9 g) and driftSlipDeg snaps from
  -25.8 to 0 and never returns. **Cause unresolved** — the scenario is scripted and may simply be
  driving into the scenery. Separating scripting from instability still needs a constant-input
  capture; this run does not settle it.
- villageStreet is clean: 13 pairs, no pops, smooth telemetry throughout.
- itemChaos has never been captured to completion — 8 of 14 frames before the run hit its time
  limit. Under SwiftShader a 1280x720 q=high frame costs roughly 15-20 s.

**Feel** (from `tools/sim/feel.mjs`, 8/9 benches in target)
- 0–50 km/h takes 5.15 s against a 0.8–3.5 s target — sluggish for a kart racer.
- Yaw rate is jumpy in captured scenes (−0.50 to −2.14 rad/s while accelerating fairly
  straight). **Unconfirmed** — may be scripted scenario input rather than instability; needs a
  constant-input capture to separate the two.

**UI**
- There is no controls screen anywhere in the game — nothing tells a player what any key does.
  `R` is bound under the name `reset` but performs a respawn, not a race restart, which is very
  likely what "the game won't restart on reset" meant before the mobile cause was found.
- Faint ghost text behind the title-screen hint.
- Portrait on mobile crops badly; landscape is the intended orientation.
- Renders at full device pixel ratio, which is heavy on a 3× phone screen.

---

## If you pick this up

The highest-value next step is shadows — not because it is the biggest list item but because
grounding objects is most of the difference between "a 3D scene" and "a place", and it is the
one defect now diagnosed precisely enough to fix rather than tune. Three distinct causes, listed
above; `buildings.js:859` is nearly a one-liner.

After that, in rough order of value per hour: the milky grade (a measured overshoot, so it has a
number to aim at), then vegetation hue at distance, then the centreline and road-width work that
would make the course read as designed rather than inherited.

Do not start another parallel per-file review round. It has been tried eight times and the score
went down.
