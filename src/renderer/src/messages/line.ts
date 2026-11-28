// User-facing strings of the Line inspector (engraved-patterns.md E1, E2). Terms from docs/glossary.md
// (line, V-groove). Doc: docs/modes/engraved-patterns.md#ui
export const lineMessages = {
  groups: { paths: 'Paths', depth: 'Depth' },
  /** One path's shape: "Path 1". */
  path: (n: number) => `Path ${n}`,
  pathU: 'Position u',
  pathV: 'Position v',
  pathNote: 'The shape’s centre on the face. Every loop and open path of the shape is a line.',
  depthMode: 'Depth',
  modes: { constant: 'Constant', ramp: 'Start → end', levels: 'From SVG levels' },
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
