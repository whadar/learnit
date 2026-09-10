# Review round 1 — independent critic findings

Three independent critics scored the integrated build against Mario Kart 8 Deluxe on the
0-95 AAA rubric. **Scores: 52, 52, 47** (min 47) — the 40-60 band,
"a competent hobby project; obviously not commercial".

17 critical, 26 major, 15 minor findings across 22 files.

Findings agreed by multiple critics are the highest-confidence ones: the blown-out drift/boost
flame, the bleached sky, the milky desaturated grade, untextured cypress cones and floating
foliage cards, the opaque HUD position badge, and the missing contact shadows under karts.

---

## `src/ui/hud.js`

- **[critical] HUD position badge paints an opaque silver rectangle for every position except 1st**
  Confirmed both in-frame (gridStart, introFlythrough show '2nd' as outlined glyphs on a hard-edged white/grey box) and in source. The base rule `.kr-hud .kr-pos .num` sets the gold gradient plus `-webkit-background-clip:text;background-clip:text;color:transparent`. The overrides at `.kr-pos[data-p="2"] .num`, `[data-p="3"] .num` and `[data-p="0"] .num` use the `background:` SHORTHAND, which resets `background-clip` back to `border-box`. The gradient therefore fills the element box opaquely and `color:transparent` leaves only the text stroke. Fix: use `background-image:` in those four override rules, or re-declare background-clip.
- **[critical] HUD position widget renders opaque white plates instead of gradient text**
  The `background:` shorthand in the `[data-p="2"]`, `[data-p="3"]` and `[data-p="0"]` rules (hud.js lines 212-217) resets `background-clip` to its initial `border-box`, and those rules never re-declare `-webkit-background-clip:text; background-clip:text`. Whenever the player is not 1st, the numeral and suffix paint as solid white/silver rectangles with a black outline instead of clipped gradient glyphs — verified at 3x in gridStart and introFlythrough, where '2nd' is literally two white boxes. Only 1st place (the base rule) renders correctly. Fix: append the clip properties to each `[data-p]` override, or use `background-image:` so the shorthand does not reset the clip.
- **[major] Speedometer draws a duplicated ghost of its own dial and ticks, and the needle crosses the digits**
  4x crop of oliveGrove at (1060,560): a second faint copy of the arc, rim and tick marks sits offset ~10 px down-right of the real dial, with the ghost ticks appearing BELOW the semicircle baseline where no ticks should exist — a drop-shadow implemented as a full duplicate of the widget rather than a shadow of its alpha. The orange needle passes straight through the '71' numerals with no layering separation, the 'km/h' label collides with the dial's bottom edge, and the whole widget is clipped by the screen edge in all seven frames. The 1 px grey ticks alias badly.
- **[major] HUD place-badge silver gradient renders as opaque rectangles behind the glyphs**
  Crop gridStart.png at x0 y540 w260 h180 and zoom 4x: the '2nd' badge has two hard white/silver rectangles painted behind it — one behind the '2', one behind the 'nd' — with the gradient bleeding well outside the letterforms and clipping the glyph descenders. It reads as a broken transparency or a canvas fillRect that should have been a gradient-filled fillText (or a missing globalCompositeOperation:'source-in' mask). The gold '1st' in the other frames is clean, so only the non-first-place fill is broken. This is the most obviously unfinished pixel in the whole build and it sits in the corner of every frame the player is not winning.
- **[minor] Position list is a plain debug panel; HUD uses three unrelated visual languages**
  photoFinish shows the eight-name standings as an unstyled dark rectangle with a plain left-aligned text list, no portraits, no character colours, no highlight on the player. Elsewhere the HUD mixes a cream/gold rounded-plate family (LAP, minimap, coins), a flat cyan 'HELD' pill and a flat red count badge in itemChaos, and the chrome-outline position badge — three palettes stacked in one corner. The coin readout also renders '00' rather than '0'.
- **[minor] HUD widgets clip the frame edge and the speedometer needle overlaps its digits**
  The position widget is cut off by the bottom-left edge in villageStreet, oliveGrove, hilltopVista and photoFinish; the speedometer is cut off bottom-right in gridStart. The needle sits directly on top of the value in oliveGrove ('71'), itemChaos ('79') and photoFinish ('77'), making the speed unreadable. The empty item slot renders as a large cream plate with a ghosted fruit outline in seven of eight frames, reading as an unfinished placeholder rather than an intentional empty state.
- **[minor] Race position list is unstyled debug UI**
  The standings panel in photoFinish is a plain dark rounded rectangle with a system sans-serif list of eight names — no character portraits (menu.js already builds procedural cat portraits), no kart livery colour chips, no player-row highlight, no position-change animation. Every other HUD element in that frame has bespoke MK8-style chrome, so the mismatch is glaring.
- **[minor] 'HOLD ACCELERATE' prompt and full HUD persist into the cinematic flythrough**
  The introFlythrough frame — meant to be a pre-race cinematic plate — still shows the gameplay input prompt centred in frame plus the entire race HUD. Cinematic phases should suppress the prompt and ideally most of the HUD.

## `src/world/vegetation.js`

- **[critical] Cypress trees are untextured low-poly cones — the worst asset in the game**
  4x crop of photoFinish at (340,160) shows the cypresses as ~8-facet cones with a hard triangular silhouette, flat two-tone green (lit face / shade face), no trunk, no foliage texture, no alpha detail, no silhouette break-up, no variation between instances. They read as untextured placeholder primitives and appear prominently in villageStreet, photoFinish and introFlythrough. High-contrast cyan/magenta CA fringing along their edges makes them worse.
- **[critical] Pine forest reads as an extruded green slab with a straight vertical cliff face and flat top**
  2x crop of hilltopVista at (300,60) shows the landcover forest terminating in a perfectly straight vertical wall of canopy with a flat horizontal top plane, like a hedge cut by a boolean. No edge feathering, no height falloff at the polygon boundary, no scattered outlier trees, no understory. It instantly announces 'polygon extrusion' and destroys the vista shot.
- **[critical] Cypress trees are literal untextured green cones**
  villageStreet.png shows four cypresses as perfect solid-green ConeGeometry primitives with a hard silhouette, flat shading and no foliage texture whatsoever; photoFinish shows a whole row of them behind the bunting. buildCypress at vegetation.js:223 is producing an unbroken cone at this LOD. Nothing else in the frame set says 'prototype' as loudly. They need a broken, tufted silhouette, a two-tone dark/olive gradient, alpha-cut edge noise and per-instance lean.
- **[major] Foliage billboards float untethered in empty sky**
  3x crop of villageStreet at (300,130) shows a pale-green lozenge suspended in clear sky with no tree beneath it. The same failure appears at the top of oliveGrove (multiple detached leaf clusters at y=20-80) and itemChaos. Foliage card clusters are also visibly detached from their trunks — the trunks are bare poles and the canopy hovers above with a gap, with hard alpha-test edges and no translucency or subsurface.
- **[major] 'oliveGrove' view contains no olive trees, and the forest is one cloned pine**
  The named olive-grove view shows tall dark-green pines and oaks. Olive trees are the signature Ramot Menashe plant: low, wide, gnarled multi-stem trunks with silver-grey bicoloured foliage in regular grid rows. hilltopVista shows a solid mass of one identical silhouette rotated at the same scale — no species, height or hue variety, no planting pattern. Add a real olive species and at least three more silhouettes with per-instance scale and hue jitter.

## `src/render/particles.js`

- **[critical] Drift-boost flame is a fully blown white blob that obliterates the player kart**
  In shots/review-r1/driftCorner.png the boost/exhaust effect is a shapeless cream-white mass roughly 380x260 px covering ~25% of the lower frame; it swallows the kart body, both rear wheels and the road under it. 5.6% of the frame is at luma>0.96. There is no flame shape, no colour ramp, no core/falloff, and no alpha profile — it reads as a saturated additive quad stack with no clamp. Separately there are no drift-charge sparks at all (MK8 steps blue -> orange -> purple) and no dirt/dust plume off the rear wheels even though the surface is unpaved. This is the single worst artefact in the set.
- **[critical] Boost/drift flame is an unshaped white blowout that erases the hero kart**
  In shots/review-r1/driftCorner.png the drift/boost effect is a ~400x220 px pure-white lobe centred on the kart. The chassis, wheels and livery are completely gone; only the cat's helmet survives above it. This is the same failure the post.js header comment claims was fixed by dropping bloomStrength to 0.18 — the source emitter itself is over-bright, so the blowout happens before bloom. It also has no shape language: no coloured drift-charge tiers (MK8's blue->orange->purple), no smoke column, no sparks, no tyre marks on the ground. The single most expensive moment in a kart racer currently reads as a lens smudge.
- **[critical] Drift spark VFX is a blown-out white blob that erases the hero kart**
  In driftCorner the drift emitter produces one large additive white bloom centred on the kart. A per-cell luminance heatmap shows 89% clipped pixels in the cell containing the kart and 24-52% in the four neighbours; the whole frame measures mean lum 178 / saturation 0.275 / 10.4% clipped. MK8 drift sparks are discrete, colour-staged particles that silhouette against the kart rather than swallowing it. Reduce emissive intensity, cap the bloom contribution from this emitter, give sparks readable individual shapes.
- **[minor] No dust, spray or tyre plume behind a kart doing 79 km/h on loose sand**
  itemChaos and oliveGrove show the kart at 71-79 km/h on a sand surface with completely clean air behind it and no wheel ruts in the surface it just crossed. A dust plume is both the cheapest speed cue available and the thing that would give these washed-out frames a value contrast. Surface-driven emitters should be firing continuously here.

## `src/render/post.js`

- **[critical] Motion blur smears the near track surface into mush in every gameplay frame**
  post.js sets motionNear 2.5, motionFull 14, motionShutter 0.72, motionMax 0.013 — full-strength blur across exactly the band of road the chase camera looks at. Result: in villageStreet, driftCorner, photoFinish and oliveGrove the asphalt/gravel in the bottom third of frame is a directional smear with no aggregate, no seams, no polished racing line and no legible decals. The photoFinish checker is smeared to soft grey. MK8 keeps the track surface razor-sharp at 200cc because readability at speed is the whole point; this actively removes texture detail the material team already authored.
- **[major] Whole image is desaturated well below the Mario Kart target**
  Masked-HUD mean chroma across the set: 0.145 / 0.153 / 0.180 / 0.185 / 0.187 / 0.236 / 0.246, mean 0.19. MK8 frames sit ~0.33-0.42. post.js runs saturation at 1.05 on top of a claimed 1.28 LUT push and it still lands pastel, because aerial perspective and the horizon haze are washing chroma out of the scene before the grade sees it. hilltopVista in particular renders greens as grey-green and the red pantiles as dusty salmon. The vignette at 0.28 further crushes corner mid-tones.
- **[major] Global grade is milky and near-monochrome — no MK8 punch**
  Across all seven frames the histogram sits in a narrow mid band: blacks lifted to roughly RGB 60, whites clipped, and a single tan/olive hue with no complementary accent anywhere. hilltopVista is the extreme case (green + tan and nothing else). saturation 1.05 on top of the LUT's 1.28 is not enough given the source material is a beige village; contrast 1.0 leaves no bite. MK8's readability comes from high local contrast and a deliberate secondary palette. Push contrast and shadow density, add a cool tint to shadows so the warm sun reads as warm, and stop the aerial-perspective term from washing everything past 200 m to a single value.
- **[major] Global exposure is about a stop too hot and is desaturating the image**
  Measured across the eight frames: driftCorner lum 178 / sat 0.275 / 10.4% clipped, villageStreet lum 156 / sat 0.275 / 7.4% clipped, gridStart 11.4% clipped. Only hilltopVista (lum 112) and introFlythrough (sat 0.488) sit in a healthy range. There is also a faint diagonal streak/veil laid over the whole image — clearly visible over the gantry slab in photoFinish — that adds haze. Pull exposure down, tighten the tonemap shoulder, cut the streak pass opacity so the saturated palette can come through.

## `src/game/camera.js`

- **[critical] The cat driver is invisible in every gameplay frame**
  This is a cat racer in which no cat is visible. In villageStreet, oliveGrove, itemChaos and driftCorner all you see of the driver is a red helmet band and two ear tips clearing the seat back; there is no face, no expression, no shoulders, no hands on the wheel, no lean into the corner. The chase camera sits roughly at bumper height and very close, so the seat back occludes the entire character. MK8 places the camera high enough that the driver's head, arms and reaction are always legible — that readability is most of the game's appeal, and it is missing. Raise the chase eye height and pitch down, and shorten or lower the seat back.
- **[critical] photoFinish camera is inside the start gantry; banner renders mirrored, player kart missing**
  The top-left third of photoFinish is a grey gantry pillar and slab the camera has clipped into, and the START/FINISH banner is seen from behind so both the Hebrew and Latin text render reversed (single-sided plane, no back face). The player kart is not in frame and the pack is ~40 m ahead, so the view fails its own brief of two karts nose-to-nose at the line. Needs camera collision/pushback against track furniture plus a back face on the gantry banner.
- **[major] photoFinish camera clips through the gantry and the player kart is not in frame**
  shots/review-r1/photoFinish.png: the top 8% of the frame is the inside of the start/finish sign geometry and a grey pillar occludes the entire left edge. The hero kart is absent from its own hero shot — the pack is a cluster 60 m up the road and nobody is 'nose to nose at the line'. Either the chase camera is not resolving occluders between eye and target, or the view is placed behind the gantry. A near-plane occlusion pull-in (or a simple sphere-cast from target to eye) fixes the clip; the missing hero is a view-setup problem in the harness.
- **[minor] AI karts intersect the chase camera near plane**
  In villageStreet an AI kart and its white cat driver clip into the bottom-left of the frame, overlapping the position HUD, with no camera avoidance or fade. The chase camera needs a proximity fade or push for karts entering the near volume.

## `src/world/sky.js`

- **[critical] Sky bleaches to flat white with no cloud deck in four of seven views**
  gridStart, villageStreet, driftCorner and hilltopVista all have a sky that is a featureless cream-to-mint vertical wash — no blue, no clouds, no horizon definition. oliveGrove and itemChaos prove the cloud shader works, so this is haze/exposure stacking: sky.js applies uHorizonHaze whitening to the dome, lighting.js applies aerial perspective at apDensity 0.0016 with hazeMax 0.82, and post.js then force-blurs the sky with `coc = max(coc, isSky * uDofMax * 0.55)` = 0.19 CoC on the dome. In driftCorner the failure is visible as an enormous soft cyan lobe in the upper-left corner against pale peach — the dome gradient has no coherent shape. In hilltopVista the aerial perspective erases the far hills entirely by ~600 m on a course only 1.5 km across.
- **[major] Sky blows to featureless white; no clouds in half the frames**
  gridStart.png and villageStreet.png have no cloud at all — the sky is a flat grey-white ramp that goes to pure paper at the horizon and takes the far hills with it. hilltopVista.png is worse: the top 12% of the frame is blank white and the entire far ridge dissolves into it, so the course's best vista shot has no horizon. Yet oliveGrove and photoFinish do show cumulus, so the deck exists (coverage 0.45) and is being lost — either behind hazeMax 0.82 or below the camera's elevation cut. The Israeli summer sky should be a deep saturated blue at zenith with hard-edged fair-weather cumulus, not milk.
- **[major] Sky dome clips to flat white over a wide solid angle; horizon washes to cream**
  gridStart shows 60-67% clipped pixels across the upper-middle band; villageStreet 37-39% in the sky row; hilltopVista has no sky at all, just a cream band with the horizon lost. No zenith blue, no graded falloff, only faint white wisps for cloud. Aerial perspective is so aggressive that near and far terrain sit at the same value, killing depth. This plus the exposure issue is why the whole game reads milky — 0.275 mean saturation in driftCorner and villageStreet against roughly 0.45-0.60 for a Mario Kart 8 frame.

## `src/render/lighting.js`

- **[critical] No kart casts a contact shadow — the whole field floats**
  Zoom 3x on the kart in itemChaos.png (crop x520 y340 w260 h220): the sand directly beneath the chassis is the same value as the sand two metres away. Zero darkening, zero AO wedge under the tyres, no shadow from the roll bar or rear bumper. Same in villageStreet, driftCorner and gridStart, where eight grid karts sit on the start straight with no ground contact at all. Either the CSM near cascade does not cover the kart's own depth range or the karts are not on the shadow-casting layer. GTAO's 1.1 m radius at half res also contributes nothing at kart scale. This is the fastest single fix available and it is worth several points on its own.
- **[major] Karts and items cast no contact shadow — everything hovers**
  In photoFinish the eight-kart pack sits on the checker with essentially no darkening beneath any chassis; in itemChaos the three Triple Jaffa oranges float over the road with zero shadow; in villageStreet the player kart has no ground contact at all. MK8 gives every kart a tight, dark, always-present blob or shadow-map contact plus an item shadow — it is what glues objects to the surface. Either the shadow cascade near-range is too coarse to resolve a 1 m object or karts are excluded from castShadow.
- **[major] Shadows are low-resolution blobs with chunky edges and no contact occlusion**
  Tree shadows in oliveGrove and hilltopVista are large dark splotches with visibly stepped, aliased boundaries and no penumbra gradient; the moshav in hilltopVista shows painted-on blobs. There is no visible contact shadow or ambient occlusion where karts, props and buildings meet the ground, which is why everything looks slightly detached from the terrain.

## `src/track/trackMesh.js`

- **[critical] The drivable track has no readable edge — sand ribbon on sand ground**
  In villageStreet, oliveGrove and itemChaos the racing surface and the surrounding terrain are the same pale tan at nearly the same value. There is no berm, no rumble strip, no painted edge line, no grass verge, no cambered lip. In itemChaos the only cue that the right-hand side is off-track is a faint straight-line value seam; in oliveGrove the road simply dissolves into the hillside 40 m ahead. At 79 km/h a player cannot tell where the circuit is. Give the ribbon a hard edge treatment — compacted-gravel shoulder, a darker packed-earth centre worn line, and a light stone kerb on the outside of every corner.
- **[critical] The track has no boundary language — no kerb thickness, shoulder, barrier or apex marker**
  Across hilltopVista, oliveGrove, itemChaos and driftCorner the course is a ribbon of sand or asphalt with a hard straight edge where it meets terrain and nothing else. The red/white rumble strips in villageStreet and driftCorner are paper-thin painted stripes with no bevel or height. itemChaos has a perfectly straight vertical seam on the right where pale track meets orange terrain with zero blend geometry. From hilltopVista you cannot trace the circuit at all. A Mario Kart track is legible from any altitude because of raised kerbs, coloured shoulders, guard rails, sponsor barriers and apex furniture — none of that exists, so nothing reads as a deliberately designed circuit.
- **[major] Kerbs are flat painted strips with no extrusion, bevel or shadow**
  In driftCorner and villageStreet the red/white kerbing is a texture painted onto the road plane at the same height as the asphalt — no 3D relief, no chamfer, no cast shadow, no dirt accumulation at the base. Where kerbs ARE extruded (photoFinish right edge) the red/white blocks float above a blue slab with a visible gap and an unshadowed seam. MK8 kerbs are chunky, beveled, self-shadowing and rumble-readable.

## `src/characters/cat.js`

- **[critical] Karts on the starting grid have no cat drivers**
  In gridStart at 7x zoom, most of the eight grid karts are empty chassis — visible seat back, roll bar and steering wheel with nothing in them. One kart (blue, mid-left) shows a ginger blob in the seat, and villageStreet's near AI kart shows a fully modelled white cat with paws on the wheel, so the cats exist and are correctly parented. They are being dropped inconsistently — most likely a stale/undersized bounding sphere causing frustum culling, or the rig not being visible during the 'countdown' phase. Worst defect in the set: gridStart is the cover shot, and a character kart racer whose karts are driverless reads as broken.

## `src/render/materials/vegetationMaterials.js`

- **[critical] Foliage cards float detached in the sky and shade half-black**
  At 2.5x on the oliveGrove sky, a dozen leaf-cluster quads hang in mid-air with no branch attached, and individual cards are lit half bright-green / half near-black because they use the flat quad normal instead of a spherized or two-sided foliage normal. Edges are 1-bit alpha cutouts with heavy aliasing (no alpha-to-coverage). The same detached cards appear in the sky in driftCorner (right, ~x985) and itemChaos (top-centre). The most conspicuous programmer-art tell in the environment.

## `src/track/furniture.js`

- **[major] Grandstands are empty and there is no crowd anywhere on the course**
  introFlythrough shows a bare bench grandstand structure at the start/finish with zero spectators, and no frame in the set contains a single crowd figure. Mario Kart 8 fills every stand and trackside pocket with cheering characters, flags and reaction animation — a large part of why those frames feel alive. Instanced low-poly cat spectators with a simple wave would close much of the gap cheaply.
- **[minor] Bunting is unlit single-sided flat triangles in a muddy palette, with two strings intersecting**
  3x crop of gridStart at (380,160) and 4x of photoFinish at (340,160): flags are pure flat fill with no shading, no cloth curvature, no thickness, no wind deformation. The photoFinish palette is dark maroon/olive/navy/grey — dull where MK8 would be primary-bright — and the two bunting rows cross each other and pass through the gantry and the cypresses. Trackside sponsor boards are flat matte slabs with no fabric texture, wrinkles, grommets or specular; they read as UI plates dropped into 3D.
- **[minor] Spectators are featureless pale-blue pawns**
  2x crop of gridStart at (0,240): the crowd on the winery roof is a row of identical smooth pale-blue capsules with no arms, faces, colour variation or animation — chess pawns. MK8 lines the barriers with animated Shy Guys waving flags; a static blob row draws the eye and then disappoints it.
- **[minor] Kerbs, finish line and signage are zero-thickness painted decals**
  The red/white kerbs in driftCorner and villageStreet, and the checker line in photoFinish, are flat paint on the surface with no extruded lip, no bevel highlight and no cast shadow — they read as stickers. The speed sign in driftCorner and the 'KAT' banner in villageStreet are single unlit quads on thin poles with no ground shadow. Extrude the kerbs 60-80 mm with a lit top bevel.
- **[minor] Bunting is muddy, doubled and z-fighting; cypresses are untextured flat cones**
  In photoFinish two bunting rows overlap and z-fight, and the flag palette is desaturated maroon/mustard/navy/olive/grey rather than clean primaries. The triangles are single-sided unlit planes with no thickness and no wind motion. The cypress trees behind them are pure flat green cones with a hard aliased outline and no texture or normal variation — the most obvious untextured-primitive tell in the set.

## `src/world/buildings.js`

- **[major] Buildings have no window frames, sills, eaves, gutters, doors or balconies**
  2x crop of driftCorner at (330,150): windows are flat blue rectangles painted into the wall with zero inset, no frame, no sill, no lintel, no glass specular. Roofs meet walls at a razor edge with no fascia, no overhang and therefore no eave shadow. No downpipes, no doors, no balconies, no railings, no courtyards, no vehicles. Solar heaters are present but are a single bare white capsule with no frame or panel. Roof tiling is well done in close-up but flattens to solid red at 60 m, so the mid-ground village is a field of cream boxes with red lids.
- **[major] Building wall faces are single flat values with no eaves, fascia or roof-shadow line**
  Crop gridStart at x0 y240 w420 h220: the pantile roofs are genuinely good (real tile geometry, solar cylinders, a stone-block course) but every plaster wall is one uniform grey-blue with zero texture, zero normal detail, no dirt streak, no window reveal depth. The roof meets the wall at a hard zero-thickness edge — no overhang, no gutter, no cast shadow line under the eave, which is the single strongest cue that a house is a solid object. In driftCorner the hilltop row is a dozen identical stucco boxes with blue rectangles for windows and no variation in mass, colour or roof pitch.
- **[major] Houses lack solar water heaters, window depth, roof-tile relief and any yard dressing**
  At 2.5x in driftCorner, roofs are a flat red smear with no tile modelling, ridge tiles, gutters or eave-overhang shadow; windows and shutters are flat blue rectangles pasted on the wall with no reveal, frame, sill or glass. Almost none of these roofs carries a dud shemesh even though the contract calls for one on every roof (only a handful appear in introFlythrough). No plot has a garden wall, gate, pergola, laundry line, satellite dish, water tank, citrus tree or parked car. In hilltopVista every house is the same blue-grey box with the same red hip roof at the same size.

## `src/game/itemMeshes.js`

- **[major] Item boxes and the Triple Jaffa read as inert grey props**
  In oliveGrove the item boxes form a rigid straight line of matte pale cubes; in the hilltopVista crop they are three translucent grey-blue glass boxes — no emissive rainbow shell, no interior glyph, no rotation, no bob, no ground glow, no pickup shadow. The Triple Jaffa oranges in itemChaos are three matte unlit spheres with no rim light, no spin, no trail and no ground shadow, so the held item reads as static scenery rather than an active weapon.
- **[minor] Triple Jaffa item meshes are blurry noise spheres with a flat alpha leaf and no shadow**
  2x crop of itemChaos at (400,300): the oranges carry a soft low-frequency noise texture with no peel dimpling normal map, no specular highlight and no rim light; the leaf is a flat dark quad stuck on at an angle with a hard alpha edge. The three instances sit at three different apparent scales and heights so the orbit does not read as a ring, and none casts a shadow. The 2D item icon in the HUD slot is a clean flat sticker that does not resemble the 3D item at all.
- **[minor] Items have no glow, rim light or motion — the Triple Jaffa reads as three matte spheres**
  itemChaos.png: the three oranges are flat low-poly spheres with a leaf, no specular, no rim light, no emissive glow, no trail, no spin blur. In oliveGrove the item boxes mid-distance are a row of small pale cardboard cubes rather than the glowing, rotating, rainbow-cycling ? box that anchors MK8's readability. Items are the highest-attention objects on screen and currently they are the lowest-contrast ones.

## `src/world/terrain.js`

- **[major] Terrain outside the track is a featureless bare tan plane across the whole moshav**
  hilltopVista and introFlythrough show 552 real building footprints standing on uniform sand with a single low-frequency stipple: no farmland texture, no crop rows, no orchard grid, no dry-stone terraces, no field boundaries, no gardens, no yards, no wheat, no vineyard rows — despite worldData carrying 52 land-use and 136 land-cover polygons. In driftCorner the ground scatter is thousands of identical 2-3 px near-black specks that read as dirt noise rather than shrubs. This is the largest single missed opportunity: the real-data pipeline is there and nothing is drawn from it.
- **[minor] Hard straight-line seams between land-cover polygons**
  itemChaos.png right side and oliveGrove.png left third both show a dead-straight, unblended value edge where a farmland/barren polygon abuts the sandy road corridor. The splat has no noise-broken transition, so real Overture polygon boundaries read as authored geometry errors. Break the mask edge with the existing noise field and feather it over 2-4 m.

## `src/characters/kart.js`

- **[major] Kart materials are matte unlit clay — no clearcoat, no livery, no tyre detail**
  At 3x on itemChaos: the body is a dusty desaturated brick-red with not one specular highlight anywhere on the panel; the tyres are uniform matte grey-brown with no tread pattern, no sidewall lettering and a featureless disc where a rim should be; the exhausts are two plain grey cylinders. In gridStart the eight grid karts are indistinguishable dark blobs with no per-driver colour identity. MK8 karts are candy-lacquered with a hard clearcoat lobe and per-character liveries — that is what makes eight karts readable in one frame. Add a clearcoat/specular layer, push body saturation, and give each roster entry a distinct primary colour that survives at 40 m.
- **[major] Kart bodywork is near-black with no specular, livery or number readability**
  At 7-8x the grid karts are dark silhouettes: no rim light, no clearcoat or specular response, no visible livery decals, no readable racing numbers, no exhaust, no tyre tread. The underlying geometry (tube frame, wing, wheels) is decent, but the material makes eight distinct characters read as one dark blob at any distance. Raise metallic/clearcoat, add a rim/fill light, and scale the livery and number so they read from the chase camera.

## `src/ui/minimap.js`

- **[major] Minimap tracks only the player — the seven AI karts and the item boxes are absent**
  3x crop of the minimap in itemChaos: the plate, olive map, cased track ribbon and checkpoint dots are nicely made, but the only marker is the player arrow (which itself double-draws — a yellow glow disc plus a cream circle behind the arrowhead). No rival positions, no item-box markers, no lap-progress ticks. Half the reason a MK8 minimap exists is knowing where the pack is. The 'BEST --'--"---' placeholder dashes also read as unfinished.

## `src/game/race.js`

- **[major] Timing panel shows TOTAL less than LAP — impossible state**
  photoFinish (lap 3/3) reads TOTAL 0'02"283 while LAP reads 2'30"150. Total elapsed cannot be shorter than the current lap split. Either the total is being reset at each crossing or the two fields are wired to swapped sources. It is legible at a glance in the frame and undermines every timing readout.

## `src/game/ai.js`

- **[major] The AI pack disintegrates by t=4.9 s, so every action frame is an empty solo shot**
  views.json shows villageStreet, oliveGrove and itemChaos all at raceTime 4.92 s with the player already in 1st and no opponent anywhere in frame. From a standing start, four seconds of racing should not break an eight-kart field apart. 'itemChaos' contains zero chaos — three static oranges and an empty forest road. MK8 packs stay bunched for the entire first lap and that density is most of what makes the frames look alive. Tighten AI pace to the player's and add rubber-banding so the pack is still a pack at the five-second mark.

## `src/render/materials/terrainMaterial.js`

- **[major] Ground is a single flat khaki carpet with no fields, terraces or dry-stone walls**
  introFlythrough and hilltopVista show the entire moshav on one uniform tan surface — no wheat fields, vineyard rows, orchard grids, dry limestone terracing, wadi vegetation or barren-rock variation, despite worldData carrying 52 land-use and 136 land-cover polygons that would drive all of it. The driftCorner hillside is bare orange-tan speckled with tiny dark dots that read as noise rather than shrubs. Splat the real polygons into the terrain material with distinct albedo, roughness and detail-normal layers.

## `src/world/roads.js`

- **[major] Track surface albedo swings between frames and shows smeary tiling artifacts**
  The same start/finish area reads as warm tan sand in gridStart and cool grey asphalt in photoFinish and introFlythrough. villageStreet's road is muddy brown-grey with large blurry dark smudges from stretched low-frequency noise, and photoFinish's asphalt has the same blotches. There is no aggregate detail, no lane marking, no wear along the racing line, no wet/dry variation. A stable, tiling-free surface with a real detail normal and a painted racing line fixes both readability and the material-quality read.

## `src/physics/collision.js`

- **[minor] Karts interpenetrate when bunched, and photoFinish does not deliver its brief**
  In shots/review-r1/photoFinish.png the trailing seven karts are clumped into an overlapping mass with chassis intersecting each other, while the player runs alone ~40 m ahead — so the frame that is supposed to be 'two karts nose to nose at the line' is neither a photo finish nor a clean pack. Separately the introFlythrough frame still shows the 'HOLD ACCELERATE' input prompt in the middle of what is meant to be a cinematic.

## `src/track/track.js`

- **[minor] Minimap lacks a start/finish marker, lap direction and any alternate route**
  The minimap art is one of the best assets in the game, but the circuit it depicts has no start/finish indicator, no direction-of-travel arrow, and the two lobes cross at a single point with no bridge or underpass shown, so the crossing is ambiguous. The layout is all medium-radius sweeps with no signature straight, hairpin cluster or split/shortcut line — Mario Kart tracks almost always offer an alternate route, and its absence is visible in the map.
