/**
 * The circuits.
 *
 * A course is a control polyline plus named sectors; `track.js` turns that into a spline, a
 * racing line, checkpoints, a grid and everything downstream. Both courses are laid over real
 * road geometry — `snapToRoads` re-resolves every point marked `road` against the live data at
 * build time — so a control point is a claim about a place, not a doodle.
 *
 * Coordinates are metres, +X east / +Z south, origin at the centre of the world's heightfield.
 */

/*
 * Circuit control polyline, metres, +X east / +Z south, origin = centre of the moshav.
 * Coordinates marked `road` are lifted verbatim from `world.roads` (and re-resolved against
 * the live data at build time, see `snapToRoads`); the rest are purpose-built track.
 */
const AMIKAM_CONTROL = [
  // --- 1. Rehov Rakefet, start/finish straight (heading WSW) -------------- road
  [-121.4, 37.7], [-165.8, 7.3], [-174.9, -10.9],
  // --- 2. Rakefet West, climbing out of the village ---------------------- road
  [-239.5, -73.2], [-279.5, -127.3], [-324.4, -190.3], [-355.5, -252.6], [-363.8, -269.1],
  // --- 3. The Menashe Climb (farm track) --------------------------------- road
  [-401.2, -333.6], [-463.7, -404.4], [-532.1, -581.0], [-535.4, -630.7],
  // --- 4. Ridge Road along the plateau ----------------------------------- road
  [-510.4, -652.5], [-486.0, -667.3], [-429.9, -693.7], [-386.4, -675.7],
  [-352.5, -665.2], [-327.1, -651.5], [-295.2, -637.9],
  // --- 5. Pisgat Amikam hairpin ------------------------------------------ built
  [-266, -632], [-243, -617], [-238, -592], [-256, -572], [-284, -569],
  // --- 6. The Nose: flat-out descent off the ridge ------------------------ built
  [-296, -540], [-304, -495], [-311, -455], [-319, -412], [-328, -368], [-338, -328], [-345, -302],
  // --- 7. Wadi hairpin, on the real track junction ------------------------ built
  [-346, -280], [-336, -260], [-314, -252], [-292, -264], [-284, -288], [-288, -314],
  [-299, -357], [-240, -419],
  // --- 8. The Plunge (real hill path, up to 30%) ------------------------- road
  [-173, -491.3], [-147.2, -514.4], [-121.5, -526.0], [-96.3, -538.6], [-65.1, -532.9],
  [-37.7, -526.6], [-7.9, -534.0], [20.4, -532.5], [44.9, -519.0], [69.5, -504.4],
  // --- 9. Narkis Straight + bale chicane --------------------------------- road/built
  [95, -489], [113, -466], [118, -440],
  [117, -408], [128, -372], [112, -326], [106, -292], [105, -232],
  // --- 10. Kalanit Sweeper, back up into the village --------------------- road
  [148.2, -206.2], [165.0, -184.2], [208.3, -93.9],
  // --- 11. Tzivoni and the last corner ----------------------------------- road/built
  [161.4, -38.7], [138.3, -30.3], [121.0, -25.0], [83.0, -2.0], [46, 44], [16, 84],
  [-13.6, 83.1], [-84.6, 54.1],
];

/*
 * Named sectors. `i` is the first CONTROL index of the sector; `w` its centreline width and
 * `surface` the material name understood by `src/physics/collision.js`.
 */
const AMIKAM_SECTORS = [
  { i: 0,  name: 'Rehov Rakefet',   he: 'רחוב רקפת',      surface: 'tarmac',     w: 13.5 },
  { i: 3,  name: 'Rakefet West',    he: 'רקפת מערב',      surface: 'tarmac',     w: 12.5 },
  { i: 8,  name: 'Menashe Climb',   he: 'עליית מנשה',     surface: 'dirt_track', w: 11.5 },
  { i: 12, name: 'Ridge Road',      he: 'דרך הרכס',       surface: 'dirt_track', w: 11.5 },
  { i: 19, name: 'Pisgat Amikam',   he: 'פסגת עמיקם',     surface: 'dirt_track', w: 13.0 },
  { i: 24, name: 'The Nose',        he: 'המורד',          surface: 'dirt_track', w: 12.5 },
  { i: 31, name: 'Wadi Hairpin',    he: 'סיבוב הוואדי',   surface: 'dirt_track', w: 13.5 },
  { i: 37, name: 'The Plunge',      he: 'הצניחה',         surface: 'dirt_track', w: 11.5 },
  { i: 47, name: 'Narkis Straight', he: 'רחוב נרקיס',     surface: 'tarmac',     w: 13.0 },
  { i: 54, name: 'Kalanit Sweeper', he: 'רחוב כלנית',     surface: 'tarmac',     w: 13.5 },
  { i: 57, name: 'Tzivoni',         he: 'רחוב צבעוני',    surface: 'tarmac',     w: 11.5 },
];

/*
 * Dogpatch Waterfront — a street circuit on San Francisco's eastern shore.
 *
 * Where Amikam is a hill village of farm tracks and switchbacks, Dogpatch is flat reclaimed
 * industrial waterfront on a rotated grid, so the lap is what that geography actually gives
 * you: a proper street circuit of long straights and hard 90-degree corners, anticlockwise,
 * five lefts and one right. Every control point is an intersection measured off the real
 * Overture road network — see the grid in tools/places.mjs and the extract in ov_place.py.
 *
 *   1  Pier 70 Straight ....... Illinois St northbound, the fast waterfront leg past the yard
 *   2  Twentieth Street ....... west along Dogpatch's main street, Esprit Park on the left
 *   3  Esprit Park Esses ...... Indiana St southbound down the park's western edge
 *   4  Dogpatch Corner ........ the 22nd St block east, then the lap's only right-hander
 *   5  Tennessee Run .......... south between the warehouses of the Industrial Center
 *   6  Twenty-Third Turn ...... east back to Illinois and the start/finish line
 *
 * About 1.8 km, which is within a few metres of Amikam's lap — deliberately, so the two
 * courses feel like the same game.
 */
const DOGPATCH_CONTROL = [
  // --- 1. Pier 70 Straight: Illinois St northbound past the old shipyard      road
  [246, 147], [248, 131], [244, 77], [239, 22], [235, -33], [231, -87],
  [227, -142], [223, -197], [218, -251], [214, -306], [210, -361], [206, -376],
  // --- 2. Twentieth Street, westbound across the neighbourhood                road
  [196, -388], [183, -396], [168, -398], [104, -394], [41, -390], [-22, -386],
  [-86, -382], [-101, -378],
  // --- 3. Esprit Park Esses: Indiana St south down the park's western edge    road
  [-113, -369], [-121, -356], [-123, -341], [-121, -288],
  [-118, -236], [-116, -184], [-113, -132], [-109, -117],
  // --- 4. Dogpatch Corner: the 22nd St block, into the lap's only right-hander road
  [-100, -104], [-86, -96],
  [-70, -94], [20, -101], [35, -99],
  // --- 5. Tennessee Run, south past the American Industrial Center            road
  [48, -92], [58, -79], [62, -65],
  [69, 4], [75, 73], [81, 141], [87, 160],
  // --- 6. Twenty-Third Turn, east back to the start/finish line               road
  [102, 173], [122, 178],
  [209, 174], [225, 171], [238, 161],
];

const DOGPATCH_SECTORS = [
  { i: 0,  name: 'Pier 70 Straight',   surface: 'tarmac', w: 14.0 },
  { i: 12, name: 'Twentieth Street',   surface: 'tarmac', w: 13.0 },
  { i: 20, name: 'Esprit Park Esses',  surface: 'tarmac', w: 12.5 },
  { i: 28, name: 'Dogpatch Corner',    surface: 'tarmac', w: 12.5 },
  { i: 33, name: 'Tennessee Run',      surface: 'tarmac', w: 13.0 },
  { i: 40, name: 'Twenty-Third Turn',  surface: 'tarmac', w: 13.5 },
];

export const COURSES = {
  amikam: {
    slug: 'amikam', world: 'amikam', theme: 'levant',
    name: 'Amikam Village Circuit', nameHe: 'מסלול מושב עמיקם',
    control: AMIKAM_CONTROL, sectors: AMIKAM_SECTORS,
    jump: true, shortcut: true,
  },
  dogpatch: {
    slug: 'dogpatch', world: 'dogpatch', theme: 'bayfront',
    name: 'Dogpatch Waterfront',
    control: DOGPATCH_CONTROL, sectors: DOGPATCH_SECTORS,
    // A flat street circuit has nowhere to launch from and no orchard to cut through.
    jump: false, shortcut: false,
    // The control polyline is already built from measured intersections of the real road
    // network, with proper corner arcs. Re-snapping it to those same roads only adds noise.
    snap: false,
  },
};

export const courseOf = slug => COURSES[slug] || COURSES.amikam;
