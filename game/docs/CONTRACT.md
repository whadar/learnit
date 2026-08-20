# Kat Racing — engineering contract

Every module in this game is built against this contract. Read it fully before editing.
**Do not edit files you do not own.** Your brief names the files you own; touching anything
else causes lost work, because many agents build this game in parallel.

## The game

"Kat Racing" — a cat-driver kart racer aiming squarely at *Mario Kart 8 Deluxe* production
quality, in Three.js/WebGL2. Default course: **Amikam Village Circuit**, built on the real
terrain and real building footprints of Moshav Amikam (32.5636 N, 35.0208 E), Ramot Menashe,
Israel. Everything must read as authentically Israeli: Jerusalem-stone and white-plaster
houses, red clay pantile roofs, solar water heaters (dud shemesh) on every roof, cypress
lines, olive groves, vineyards, pine forest, dry limestone terraces, prickly-pear hedges,
sun-bleached wheat fields.

## Stack and conventions

- Three.js (`import * as THREE from 'three'`), ES modules, Vite. No frameworks, no TypeScript.
- Units are **metres**. **+X east, +Z south, +Y up.** World origin = centre of the moshav.
- Deterministic procedural content only: use `rng(seed)` from `src/core/mathx.js`, never
  `Math.random()`, so screenshots are reproducible between review rounds.
- Colour: renderer is `SRGBColorSpace` + `ACESFilmicToneMapping`. Author colour textures as
  sRGB (`texture.colorSpace = THREE.SRGBColorSpace`); data textures (normal, roughness, AO,
  splat, height) stay linear (`NoColorSpace`). Lights are physical-ish; do not fight the
  tonemapper with clamped-white materials.
- Textures are **generated procedurally in-repo** (canvas/shader/noise) — there is no asset
  budget for downloads and the network is closed. Aim for detail via material work, normal
  maps, triplanar/detail layers and geometry, not flat colours.
- Performance target: 60 fps at 1080p on a mid-range discrete GPU. Keep draw calls low —
  instancing, merged geometry, texture atlases. The review harness renders under SwiftShader
  (software), so also avoid anything that costs more than ~2 s/frame there.
- No global side effects on import. Every module exports a factory or class.

## Module map (ownership)

```
src/core/       engine.js quality.js input.js assets.js mathx.js
src/world/      worldData.js terrain.js buildings.js roads.js vegetation.js props.js sky.js water.js
src/render/     post.js lighting.js materials/*.js particles.js decals.js
src/track/      track.js trackMesh.js furniture.js
src/physics/    vehicle.js collision.js
src/game/       race.js ai.js items.js camera.js
src/characters/ kart.js cat.js
src/ui/         hud.js menu.js minimap.js
src/audio/      audio.js
```

## Shared APIs

`WorldData` (`src/world/worldData.js`) — already built, do not modify:

```js
world.heightAt(x, z)      // metres ASL, bilinear over the real SRTM-derived heightfield
world.normalAt(x, z, out) // surface normal
world.slopeAt(x, z)       // radians
world.inBounds(x, z)
world.buildings           // [{ id, cls, sub, name, h, lv, roof, rmat, rcol, fmat, fcol, rings:[[[x,z],...]] }]
world.roads               // [{ cls, sub, name, surface, width, paths:[[[x,z],...]], poly }]
world.landuse/.landcover/.water   // same shape as roads; `poly` marks closed polygons
world.res/.extent/.step/.minH/.maxH
```

Real data facts: 552 building footprints, 229 road/path segments (117 `track`, 55 `path`,
21 `residential`, 13 `secondary`), 52 land-use polygons (farmland, orchard, farmyard),
136 land-cover polygons (forest, shrub, grass, crop, barren), 65 water features (mostly
seasonal streams). Terrain is 3072 m across at 3 m post spacing, elevation 50–185 m.
Almost no footprint carries a height — infer from `cls`/footprint area (moshav houses are
1–2 storeys; `greenhouse` and farm sheds are low and long).

`Engine` (`src/core/engine.js`) — `engine.scene`, `engine.camera`, `engine.renderer`,
`engine.add(system)` where a system may expose `update(dt, elapsed)` and `resize(w, h)`,
`engine.composer` (set by the post stack; when set, `engine.render()` uses it).

## Automation surface (never break this)

`window.__game` must always expose:

```js
{ engine, world, ready:boolean, error:string|null,
  views: { [name]: { pos:[x,y,z], look:[x,y,z], fov } },
  setView(name), renderOnce() }
```

The visual-review harness (`tools/shoot.mjs`) loads the built game, waits for `ready`, calls
`setView(name)` for each named view, lets frames settle, and screenshots. If `error` is set
or `ready` never turns true, the whole review round fails. Any module that throws during boot
blocks every other agent — guard risky work and degrade gracefully.

## Verify before you finish

```
npx vite build            # must succeed
node tools/shoot.mjs      # must exit 0 with no page errors  (server: npx vite preview --port 4173)
```

Then **look at your screenshots** with the Read tool. Code that builds but renders wrong is
not done. Judge them against a Mario Kart 8 screenshot from memory and keep iterating until
the gap is about craft, not correctness.
