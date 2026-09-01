/**
 * What a place is made of.
 *
 * The geometry of a course comes from real GIS data, but almost none of the *material* does:
 * across the 365 Dogpatch buildings nearest the circuit, Overture supplies a roof shape for
 * zero of them and a facade material for zero of them, and 95% carry no class at all. Only
 * height is well populated. So every surface falls through to a default, and if that default
 * is Amikam's the San Francisco waterfront renders with terracotta pantiles and Jerusalem
 * stone — which is exactly what the first Dogpatch screenshot showed.
 *
 * A theme is therefore not decoration; it is the entire material identity of a level. Each
 * world asset names its own (`world.meta.theme`), so the renderers can ask the world what it
 * is made of rather than being told by the boot sequence.
 *
 * Tints are multiplicative against the base material colour, so 1.0 is "unchanged".
 */

/* Moshav Amikam: lime-washed plaster, Jerusalem stone, clay pantiles, farm sheeting. */
const LEVANT = {
  id: 'levant',
  wallTints: [
    [1.00, 0.99, 0.96], [0.99, 0.95, 0.87], [0.97, 0.91, 0.79],
    [1.00, 0.97, 0.92], [0.94, 0.88, 0.76], [0.98, 0.95, 0.90],
    [0.92, 0.85, 0.72], [1.00, 0.98, 0.94], [0.88, 0.84, 0.78],
    [0.99, 0.92, 0.85], [0.96, 0.94, 0.91], [0.91, 0.86, 0.75],
    [1.00, 0.94, 0.90], [0.86, 0.83, 0.79],
  ],
  // clay pantiles run from fresh orange to sun-bleached brown; a few roofs are re-laid grey
  roofTints: [
    [1.02, 0.94, 0.88], [0.80, 0.70, 0.64], [1.18, 1.02, 0.86],
    [0.68, 0.62, 0.60], [1.10, 0.88, 0.72], [0.96, 0.90, 0.86],
    [1.14, 0.98, 0.82], [0.74, 0.66, 0.60], [0.88, 0.80, 0.76],
    [1.06, 0.86, 0.66], [0.92, 0.86, 0.86], [1.00, 0.80, 0.62],
  ],
  // fibre-cement / galvanised sheeting on the farm buildings
  sheetTints: [[0.60, 0.64, 0.68], [0.70, 0.71, 0.70], [0.52, 0.56, 0.60], [0.66, 0.66, 0.64]],
  flatBias: 0,          // added to the probability a roof is flat
  sheetChance: 0.55,
  stoneChance: 0.11,
  // Trackside boards are bilingual here: the big line is Hebrew, the small line English.
  signs: {
    gantry:   ['מסלול מושב עמיקם', 'AMIKAM VILLAGE CIRCUIT'],
    startFin: ['זינוק · סיום', 'START / FINISH'],
    winery:   ['יקב רמות מנשה', 'MENASHE HILLS WINERY'],
    tyres:    ['צמיגי עמיקם', 'AMIKAM TYRES'],
    marshal:  ['עמדת שופט', 'MARSHAL POST'],
    grandPrix:['אליפות החתולים', 'KAT RACING GRAND PRIX'],
  },
};

/*
 * Dogpatch: one of the few San Francisco neighbourhoods that survived 1906, so it is red brick
 * warehouses and Victorian workers' cottages standing next to corrugated industrial sheds and
 * new grey-panelled infill. Almost everything is flat-roofed — a pitched terracotta roof is the
 * single most out-of-place thing you can put on this shore — and what pitch exists is shallow
 * clapboard gable on the old cottages. Roofs read as tar, gravel and galvanised steel.
 */
const BAYFRONT = {
  id: 'bayfront',
  wallTints: [
    [0.78, 0.46, 0.38], [0.72, 0.41, 0.34], [0.85, 0.52, 0.42],   // red brick, weathered
    [0.66, 0.38, 0.33],                                            // dark engineering brick
    [0.94, 0.94, 0.92], [0.98, 0.97, 0.94], [0.90, 0.90, 0.88],   // painted clapboard
    [0.72, 0.74, 0.76], [0.62, 0.65, 0.68], [0.55, 0.58, 0.61],   // industrial grey panel
    [0.86, 0.82, 0.74], [0.80, 0.77, 0.71],                        // stucco, cream and buff
    [0.48, 0.52, 0.56],                                            // dark corrugated shed
    [0.70, 0.60, 0.52],                                            // sun-bleached brick
  ],
  // tar-and-gravel, asphalt sheet, galvanised steel — dark and desaturated, never orange
  roofTints: [
    [0.42, 0.44, 0.46], [0.36, 0.38, 0.40], [0.50, 0.52, 0.54],
    [0.30, 0.32, 0.34], [0.46, 0.47, 0.47], [0.55, 0.57, 0.58],
    [0.38, 0.40, 0.43], [0.62, 0.63, 0.62],
  ],
  sheetTints: [[0.58, 0.62, 0.66], [0.68, 0.70, 0.71], [0.46, 0.50, 0.54], [0.74, 0.75, 0.73]],
  flatBias: 0.55,       // the waterfront is overwhelmingly flat-roofed
  sheetChance: 0.72,
  stoneChance: 0.02,    // brick, not ashlar
  // Same two-line board, but the shore speaks English. The names are real: Pier 70 is the old
  // Union Iron Works yard the Illinois straight runs past, and the American Industrial Center
  // is the block of warehouses on 3rd that Tennessee Run goes behind.
  signs: {
    gantry:   ['DOGPATCH WATERFRONT', 'SAN FRANCISCO · CALIFORNIA'],
    startFin: ['START / FINISH', 'ILLINOIS STREET'],
    winery:   ['PIER 70 IRON WORKS', 'SHIPS · PLATE · FORGE'],
    tyres:    ['AMERICAN INDUSTRIAL CENTER', 'THIRD STREET'],
    marshal:  ['MARSHAL POST', 'TURN 4 · 22ND ST'],
    grandPrix:['KAT RACING GRAND PRIX', 'BAY CIRCUIT'],
  },
};

export const THEMES = { levant: LEVANT, bayfront: BAYFRONT };

/** The theme a world declares, falling back to Amikam's so an older asset still renders. */
export const themeOf = world => THEMES[world?.meta?.theme] || THEMES.levant;
