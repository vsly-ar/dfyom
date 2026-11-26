// User-facing strings of the engraved pattern inspector and its Presets dialog (engraved-patterns.md
// E3, E4). Terms from docs/glossary.md (engraved pattern, motif, engraving preset, tile, line, V-groove).
// Doc: docs/modes/engraved-patterns.md#ui, docs/modes/engraved-patterns.md#presets,
// docs/modes/engraved-patterns.md#implementation-e4
export const engravingMessages = {
  groups: {
    motif: 'Motif',
    layout: 'Layout',
    placement: 'Placement',
    area: 'Area',
    depth: 'Depth',
    cut: 'Cut',
  },
  motif: 'Motif',
  preset: 'Preset',
  motifKinds: { preset: 'Preset', shapes: 'Shapes' } as Record<string, string>,
  motifNote:
    'Shapes: the part’s shapes drawn together as one motif; an imported SVG’s levels set the depth.',
  shapes: 'Shapes',
  shape: (n: number) => `Shape ${n}`,
  addShape: 'Add shape',
  removeShape: 'Remove',
  /** A shape the part no longer has (its name, never its id). */
  shapeMissing: 'Missing shape',
  on: 'On',
  boundary: 'Boundary',
  boundaryFace: 'Whole face',
  boundaryCenter: (i: 0 | 1) => (i === 0 ? 'Boundary u' : 'Boundary v'),
  boundaryRotation: 'Boundary rotation',
  margin: 'Margin',
  fit: 'Fit',
  fits: { whole: 'Size', boundary: 'Fit to boundary', clip: 'Clip' } as Record<string, string>,
  fitNote:
    'Fit to boundary scales the motif to the boundary less the margin and centres it. Size keeps the width you give, at its centre. Clip cuts its lines at the boundary less the margin.',
  /** E4: the fits of a motif repeated as tiles. */
  tileFits: { clip: 'Clip', whole: 'Whole tiles' } as Record<string, string>,
  tileFitNote:
    'Clip cuts the tiles’ lines at the boundary less the margin. Whole tiles keeps only the tiles that fit inside it.',
  size: 'Width',
  tileSize: 'Tile width',

  // E4: the Layout group (a motif repeated as a tile on Pattern's lattices)
  layout: 'Layout',
  layouts: {
    single: 'Single',
    square: 'Square',
    staggered: 'Staggered',
    hex: 'Hex',
    polar: 'Polar',
  } as Record<string, string>,
  layoutNote:
    'Single places the motif once. The lattices repeat it as a tile across the area; lines meeting at the tiles’ seams are cut once.',
  spacing: 'Spacing',
  spacings: { gap: 'Gap', pitch: 'Pitch' } as Record<string, string>,
  gap: 'Gap',
  gapNote: 'Space between the tiles. 0 joins them: the lines run on from tile to tile.',
  pitch: (i: number, polar: boolean) =>
    polar
      ? i === 0
        ? 'Pitch along rings'
        : 'Pitch between rings'
      : i === 0
        ? 'Pitch along rows'
        : 'Pitch between rows',
  angle: 'Angle',
  radial: 'Face out',
  radialNote: 'Each tile on a ring turns to face away from the centre.',
  origin: (i: 0 | 1) => (i === 0 ? 'Origin u' : 'Origin v'),
  originShort: 'Origin',
  originPlaceholder: 'Area centre',
  alternate: 'Flip every other tile',
  alternateShort: 'Flip',
  sizePlaceholder: 'Its own',
  center: (i: 0 | 1) => (i === 0 ? 'Centre u' : 'Centre v'),
  centerShort: 'Centre',
  centerPlaceholder: 'Area centre',
  rotation: 'Rotation',
  depthMode: 'Depth',
  depthModes: { levels: 'From levels', constant: 'Constant' } as Record<string, string>,
  max: 'Deepest',
  min: 'Shallowest',
  depth: 'Depth',
  levelsNote:
    'Darker lines of the motif cut deeper: black or level 1 at Deepest, the lightest at Shallowest.',
  tool: 'Tool',
  /** The read-out under the name: "14 lines · 60 mm wide · 2.1 m"; tiles: "209 tiles · 19 lines …". */
  readout: (lines: number, width: string, length: string, tiles?: number) =>
    `${tiles === undefined ? '' : `${tiles} ${tiles === 1 ? 'tile' : 'tiles'} · `}${lines} ${lines === 1 ? 'line' : 'lines'} · ${width} wide · ${length} of groove`,

  // the Presets dialog (engraved-patterns.md § Presets)
  presetsButton: 'Presets…',
  presetsTitle: 'Engraving presets',
  presetsDescription:
    'Pick a motif. Tiles repeat across the area, round motifs fit the boundary, the others keep their size; you can scale them all.',
  presetCurrent: 'Current',
  presetGroups: { tile: 'Tiles', single: 'Motifs', round: 'Round' } as Record<string, string>,
  presetNames: {
    waves: 'Waves',
    chevrons: 'Chevrons',
    crosshatch: 'Crosshatch',
    scales: 'Scales',
    seigaiha: 'Seigaiha',
    'basket-weave': 'Basket weave',
    'greek-key': 'Greek key',
    'wood-grain': 'Wood grain',
    vine: 'Vine',
    rosette: 'Rosette',
    sunburst: 'Sunburst',
    ripples: 'Ripples',
    mandala: 'Mandala',
  } as Record<string, string>,
  presetDescriptions: {
    waves: 'Rows of soft waves.',
    chevrons: 'Zigzag rows, light and dark.',
    crosshatch: 'Two sets of crossing lines.',
    scales: 'Overlapping fish scales.',
    seigaiha: 'Japanese wave arcs in fans.',
    'basket-weave': 'Short strokes in alternating blocks.',
    'greek-key': 'A meander band.',
    'wood-grain': 'Flowing grain lines, deeper in the middle.',
    vine: 'A leafy vine with tapering ends.',
    rosette: 'Twelve overlapping circles in a ring.',
    sunburst: 'Rays from a centre, tapering out.',
    ripples: 'Wavy rings, deep to light.',
    mandala: 'Petals and rings.',
  } as Record<string, string>,
  /** A preset card's numbers: "20 × 10 mm · tile". */
  presetSize: (w: string, h: string) => `${w} × ${h}`,
}
