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

---

# Rounds 2 and 3

Same six frames, same rubric, three fresh critics each round. Binding is the minimum.

```
round 1   41  36  36     binding 36      mean 37.7
round 2   34  34  37     binding 34      mean 35.0
round 3   46  36  47     binding 36      mean 43.0     target 88
```

And the mechanical measure over the same frames (`tools/frame-stats.mjs`):

```
          lum    dark   detail
round 1   0.296   9.0%  0.0061
round 2   0.363   5.0%  0.0105
round 3   0.357   6.9%  0.0101      clipping 0.0% throughout
```

## What each round did

**Round 2 — materials and light.** Procedural canvas textures for asphalt, concrete, building
facades and ground; hemisphere fill raised from 1.05 to 1.9; an fbm cloud deck and a sun disc.
Detail rose 72%, near-black fell from 9.0% to 5.0%. **The score fell from 36 to 34.**

**Round 3 — undoing half of round 2.** All three critics said the same new thing: no shadows
anywhere, lighting reads as flat ambient. The shadow map had been on the whole time — 189
casters, 1956 receivers, measured — but fill at 1.9 against a 2.5 sun is a 1.3:1 key ratio, which
washes shadows out until they are invisible. Fill back to 1.15, sun to 3.2. Plus drawn contact
shadows under every kart, VFX that fire during ordinary racing rather than only while drifting,
and a camera clamped to the street canyon.

## What the arc says

The binding score is where it started. Round 2 was a real regression caused by fixing round 1's
complaint too hard — the same effect failing in opposite directions across two rounds, which is
failure mode two in CONTRACT.md and which this project has now committed three times.

The mean moved 37.7 -> 43.0, and the two critics who moved most went 41 -> 46 and 36 -> 47. The
binding score did not move because one critic held at 36 both times. That is the honest reading:
the work was real, and the metric the project uses cannot see it.

Every round has also produced findings that are simply true and unaddressed — no character
models, no tonemap grade, no set-dressing density, no water at the waterfront. Those are large
pieces of work, not tuning, and no further round of critics is needed to know they are missing.

## Not fixed, and worth naming

- Buildings have no collision. A kart can drive inside one; the camera clamp treats the symptom.
  Buildings standing in the roadway are now cleared at build time, which removes the worst of it.
- A tall building at the kerb still fills a third of the frame at grazing angles, where the facade
  texture compresses to nothing. Two rounds called this the most damaging artifact in the set.
- The frame-stats `dark` measure cannot tell a crushed black from a real shadow. Round 2 scored
  best on it precisely because it had washed the shadows out.
