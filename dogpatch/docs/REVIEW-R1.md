# Review round 1 — three independent critics

Six gameplay frames (`grid, launch, street, corner, pack, waterfront`, captured by
`tools/shoot.mjs`) scored blind against Mario Kart 8 Deluxe on the same 0-95 rubric the previous
build used, where 88+ means genuinely shipped-AAA.

**Scores: 41, 36, 36 — binding (minimum) 36.**

For comparison, the previous build ran eight rounds of this loop: `47 → 54 → 56 → 63 → 61 → 60 →
57 → 58`. This rebuild starts below that first round, which is the expected trade: it is 2,310
lines against 34,952, and essentially all of the difference was art depth — textures, VFX,
post-processing, character models.

Two critics placed it in the 20-40 band ("prototype; reads as untextured programmer art"), one at
the bottom of 40-60 ("a competent hobby project"). All three said the same thing about why: there
is no material layer at all.

## Unanimous across all three critics

- **The sponsor hoardings render mirrored.** Called critical by every critic, and the only finding
  any of them described as outright broken rather than merely absent. Fixed the same day: the
  plane's front face looked down the road instead of at oncoming traffic, so with `DoubleSide` on
  you read the back of the board. (This is the same family of bug as the strip winding that made
  the entire circuit invisible — a face pointing the wrong way.)
- **No textures anywhere.** Every surface is flat vertex or material colour: no albedo, roughness
  or normal maps on asphalt, concrete, façades, terrain or karts.
- **No VFX.** No tyre smoke, drift sparks, exhaust, boost trail or speed cue, in frames reading
  93 and 95 km/h.
- **Shadow sides crush to black.** One directional light, no ambient or IBL fill, so building
  masses read as flat black wedges — and one such mass occupies up to 40% of the frame.
- **Flat gradient sky.** No cloud deck, no sun disc, no horizon haze, no aerial perspective, and
  the terrain terminates against it on a hard line.
- **Buildings are undecorated extruded boxes** — no windows, doors, roll-up doors or roof clutter,
  which is exactly what a Dogpatch warehouse is made of.
- **Drivers are featureless primitives** and the HUD has no minimap, item slot or position plate.

## The three changes all three critics ranked highest, in the same order

1. A real material and texture pass — the single largest gain available, and it covers the
   greatest surface area of every frame.
2. Lighting, sky and post as one pass: ambient/IBL fill, cloud deck and sun, distance fog,
   contact-hardened shadows, filmic tonemap and grade.
3. Environment density plus VFX, characters and a designed HUD.

## What this round is and is not

It is a consistent yardstick for how the frames read, applied by critics run inside this project —
not an objective grade. It is also blind to motion, control feel, audio and item balance, which is
how the previous build shipped inverted steering and a reversing grid through eight straight
rounds of it. `tools/play.mjs` covers that half; this covers the other.

One thing worth noting about this round specifically: the defect that mattered most in this build —
the entire circuit rendering invisible because every strip triangle faced downward — was found by
opening a PNG, not by a critic. The critics scored the frames *after* that fix. A round of critics
on the broken frames would have produced a long list of art findings about a game that had no road.
