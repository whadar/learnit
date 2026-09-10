# Dogpatch Kart

A kart racer on one course: the Dogpatch Waterfront circuit, laid over the real terrain and real
building footprints of Dogpatch, San Francisco. English throughout. One place, one lap, no themes.

```
npm install
npm run build && npm run preview     # http://127.0.0.1:4180/
npm run smoke                        # every module imports; world and track build
npm run race                         # headless race bench
node tools/play.mjs                  # boots the built game and checks it races
npm run shoot                        # screenshots of real gameplay
```

Arrow keys or WASD to steer, Space to drift (hold it through a corner to charge a mini-turbo),
Ctrl or Shift to fire an item, Esc to pause, R to respawn. On a phone: stick bottom-left, DRIFT
and ITEM bottom-right, pause top-right.

## Where the world comes from

`tools/place.mjs` names one place. Elevation is AWS Terrain Tiles (terrarium encoding,
`h = R*256 + G + B/256 - 32768`); buildings and roads are Overture Maps, read by pulling only the
GeoParquet row groups whose bbox *intersects* the 3 km box — a point-containment test finds one
row group where this needs four, and silently loses the rest.

`build-world.mjs` refuses to write if the decoded elevation range does not look like the place. A
wrong tile centre still produces a perfectly plausible heightfield; that is how a previous build
shipped a village a kilometre from where it thought it was.

## Things that are the way they are on purpose

- **The grid is pinned, not braked.** A brake held at a standstill is how you ask the vehicle to
  reverse, so a `brake: 1` hold puts the whole field under rearward drive while the lights are red.
- **`autopilot` drives the player's kart only.** Gating the whole field on it freezes every rival
  the moment a human takes the wheel, and every headless bench misses it because they all run
  autopilot on. `tools/play.mjs` checks 7 of 7 opponents are moving.
- **Steering is flipped in `input.js` and nowhere else.** The vehicle and the AI share a convention
  where positive steer is a left turn; flipping the physics instead inverts the AI.
- **Touch controls mount on the body.** Children of a `<canvas>` are fallback content: they parse,
  `querySelector` finds them, and they are never laid out. `play.mjs` asserts a bounding box.
- **Building heights come from the data.** 5,329 of 5,527 have a real height, and 23% are taller
  than 9 m. Clamping them flattens a quarter of the neighbourhood.
- **The shoulder is concrete.** It is the circuit's own mesh, not the terrain — tinting the terrain
  to fix a sandy verge does nothing, which costs a day to work out if you assume instead of
  raycasting the pixel.
- **Engine formants are fixed filters.** Bake a resonance into a buffer and play it back faster and
  the resonance rides the pitch, which is how an engine becomes a mosquito.
- **The master audio bus starts near silence** and ramps when the context is really running.
