# Reuse or Rebuild

What survives from this project for the next game built the same way, and what cost
4.59 billion tokens to learn and should not be paid for twice.

A designed version of this document lives at
https://claude.ai/code/artifact/f266b0d7-854c-4aa5-b9fe-8c5d598e5096

## The verdict

Keep the geodata pipeline, the measurement harnesses and `docs/CONTRACT.md`. Rebuild the game.
Cap the critic loop at three rounds.

## What's in the box

| Asset | Where | Lines | Why it transfers |
|---|---|---:|---|
| Geodata pipeline | `tools/places.mjs`, `fetch-dem.mjs`, `ov_place.py`, `build-world.mjs` | ~450 | Any real place becomes terrain, roads and buildings. Nothing in it is about karts. |
| Frame regression guard | `tools/guard.mjs` | ~200 | Turns "that looks wrong" into a number that exits non-zero. |
| Motion harness | `tools/shoot-seq.mjs`, `popcheck.mjs`, `camcheck.mjs` | ~400 | Sees what a still frame cannot: popping, camera intrusion, development over time. |
| Headless benches | `tools/sim/*.mjs` | ~2k | Physics, AI, audio and start-line behaviour without a renderer. |
| Failure-mode contract | `docs/CONTRACT.md` | 154 | Every agent reads it first. Stops the same mistake being made a fourth time. |
| Place/theme abstraction | `src/world/themes.js` | 164 | A world names its own theme; renderers ask the world what it's made of. |

## The pipeline is the crown jewel

Its value is not the code — it is four non-obvious things that each cost a day to find.

- **Overpass and OpenTopoData were blocked; AWS Open Data was not.** Terrarium tiles from
  `elevation-tiles-prod` are free, global, and decode with `h = R*256 + G + B/256 - 32768`.
- **You can read 500 GeoParquet files without downloading them.** Each file's footer carries
  per-row-group bbox statistics, so a few hundred KB of HTTP range requests finds the handful of
  row groups covering a 3 km box. The whole extract runs in under a minute.
- **Intersect the bbox, never test a point.** The original extractor asked whether a row group's
  bbox *contained the centre point*. Dogpatch needs four row groups for buildings and four for
  roads; a point test finds at most one and the rest vanish with no error.
- **Verify the elevations before writing anything.** A wrong tile centre still decodes to a
  perfectly plausible heightfield. Amikam shipped a kilometre off until decoded heights were
  checked against known ones; `build-world.mjs` now refuses to write if the range is wrong.

## Six ways a green suite lied

The full text is in `docs/CONTRACT.md`. In short: misattribution (a recurring defect is usually
blamed on the wrong file); oscillation (effects swing between opposite failures); harness defaults
(every bench ran `autopilot: true`, a real race runs false); existence is not layout (a node inside
a `<canvas>` never lays out); per-voice audio checks (228/228 green while the engine was a
mosquito); untestable paths (nothing reached through the frame loop had coverage).

## Why not to run the loop again

Binding score by round, three critics scoring frames blind against Mario Kart 8 Deluxe, 0-95 where
88+ means shipped-AAA:

```
47 -> 54 -> 56 -> 63 -> 61 -> 60 -> 57 -> 58     target 88
                  ^ peak (round 4)
```

It bought 47 -> 63 and then stopped paying, while consuming 88% of 4.59B tokens. Every defect that
actually mattered came from a human playing the build or from mechanical measurement. None came
from a critic round.

## Day one of the next build

In this order, because the ordering is the lesson — the playable build existed on day eight, and
every serious defect arrived after it.

1. Port `places.mjs` and the extractor. Verify elevations against something you can look up.
2. A smoke test that every module imports cleanly.
3. **A playable link.** Not a screenshot harness — something a person can open and drive.
4. A regression guard with two or three objective checks on rendered frames.
5. Seed `CONTRACT.md` with the six patterns, and make every agent read it first.
6. Only now, critics — and stop at three rounds.

## Reuse or rebuild?

Reuse the pipeline, harnesses and contract: place-agnostic, genre-agnostic, and the part that took
discovery rather than typing. Rebuild the game — the vehicle physics, racing-line AI, track spline
and item systems are good, but worth carrying only if the next game also drives.

One caveat on every number here: the scores are one rubric applied by critics run inside this
project. Treat them as a consistent yardstick, not an objective grade.
