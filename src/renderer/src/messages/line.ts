// User-facing strings of the Line inspector (engraved-patterns.md E1). Terms from docs/glossary.md
// (line, V-groove). Doc: docs/modes/engraved-patterns.md#ui
export const lineMessages = {
  groups: { paths: 'Paths', depth: 'Depth' },
  /** One path's shape: "Path 1". */
  path: (n: number) => `Path ${n}`,
  pathU: 'Position u',
  pathV: 'Position v',
  pathNote: 'The shape’s centre on the face. Every loop and open path of the shape is a line.',
  depthMode: 'Depth',
  modes: { constant: 'Constant', ramp: 'Start → end' },
  depth: 'Depth',
  start: 'At start',
  end: 'At end',
  rampNote: 'The depth changes evenly along each line, from its start to its end.',
  /** A shape the part no longer has (its name, never its id). */
  shapeMissing: 'Missing shape',
}
