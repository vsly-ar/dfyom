// User-facing strings of the Line inspector (engraved-patterns.md E1, E2). Terms from docs/glossary.md
// (line, V-groove). Doc: docs/modes/engraved-patterns.md#ui
export const lineMessages = {
  groups: { paths: 'Paths', depth: 'Depth' },
  /** DF147 SL2: the geometry mode and the inline fields (engraved-patterns.md § Simple Line). */
  geometry: 'Geometry',
  geometryModes: { straight: 'Straight', arc: 'Arc', shape: 'Shape' },
  startU: 'Start u',
  startV: 'Start v',
  endU: 'End u',
  endV: 'End v',
  throughU: 'Through u',
  throughV: 'Through v',
  pointsNote: 'Points on the face, from its front-left corner; a value may be a formula.',
  throughNote: 'A point the arc passes through, between its start and its end.',
  lengthReadout: (length: string) => `Length ${length}`,
  arcReadout: (radius: string, sweep: string) => `Radius ${radius}, sweep ${sweep}°`,
  convert: 'Convert to shape',
  converted: (name: string) => `Converted to ${name}`,
  parallel: 'Parallel to',
  edges: { front: 'Front edge', back: 'Back edge', left: 'Left edge', right: 'Right edge' },
  distance: 'Distance from edge',
  parallelNote: 'Places a straight line across the whole face, this far from the edge.',
  /** One path's shape: "Path 1". */
  path: (n: number) => `Path ${n}`,
  pathU: 'Position u',
  pathV: 'Position v',
  pathNote: 'The shape’s centre on the face. Every loop and open path of the shape is a line.',
  depthMode: 'Depth',
  modes: {
    constant: 'Constant',
    ramp: 'Start → end',
    levels: 'From SVG levels',
    through: 'Through',
  },
  /** DF147 SL3: a through Line (engraved-patterns.md § Cutting the part out along a line). */
  throughDepth:
    'Cuts through the stock with a flat end mill: the slot is as wide as the tool, and an end on the stock edge is entered from outside. Hold both sides of the line: they come apart on the last pass.',
  depth: 'Depth',
  start: 'At start',
  end: 'At end',
  rampNote: 'The depth changes evenly along each line, from its start to its end.',
  max: 'Deepest',
  min: 'Shallowest',
  levelsNote:
    'Depth from the shapes’ levels, set by an imported SVG: black or level 1 cuts deepest, white or level 0 shallowest. A path without levels cuts deepest.',
  blend: 'Blend',
  blendNote:
    'Where the level steps between two joined lines, the depth changes over this length on either side.',
  /** A shape the part no longer has (its name, never its id). */
  shapeMissing: 'Missing shape',
  /** DF147 SL1: the Path picker's Shape Editor entries and the button under it. */
  editor: 'Shape Editor',
  newShape: 'New shape…',
  editShapeEntry: 'Edit shape…',
  editInEditor: 'Edit in Shape Editor',
  /** The depth legend under the levels' fields (engraved-patterns.md § Depth legend). */
  legend: {
    ticks: (deepest: string, shallowest: string, used: readonly string[]) =>
      `Depth legend: dark is deep, ${deepest}; light is shallow, ${shallowest}. ${used.length === 1 ? 'Depth' : 'Depths'} in use: ${used.join(', ')}.`,
    continuous: (deepest: string, shallowest: string, from: string, to: string) =>
      `Depth legend: dark is deep, ${deepest}; light is shallow, ${shallowest}. The depth fades from ${from} to ${to}.`,
  },
}
