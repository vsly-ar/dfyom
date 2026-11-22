// User-facing strings of the chamfer inspector and the Add menu's Chamfer item (v0.4 task U4).
// Terms from docs/glossary.md (chamfer, edge). Doc: docs/conventions/ui.md#chamfer-inspector
export const chamferMessages = {
  groups: { edge: 'Edge', chamfer: 'Chamfer' },
  edge: 'Edge',
  /** An Edge option: "Drilling 2 · Ø 3.4 mm". */
  edgeOption: (name: string, diameter: string) => `${name} · Ø ${diameter}`,
  pickEdge: 'Pick the edge in the viewport',
  pickEdgeField: 'Edge',
  /** The edge operation is gone or not round any more (the command refuses such an edge). */
  edgeMissing: (id: string) => `${id} (not a drilling, circular pocket or circular opening)`,
  diameter: 'Diameter',
  angle: 'Angle',
  depth: 'Depth',
  depthNote: 'From diameter and angle.',
  /** Add menu: no drilling, circular pocket or circular opening in the part (ui.md § Feature rows and Add). */
  noEdge:
    'Add a drilling, a circular pocket or a circular opening first: a chamfer breaks its edge.',
  /** The section illustration's accessible name, built from the values. */
  sectionLabel: (p: {
    diameter: string
    angle: string
    depth: string
    edgeName: string
    edgeDiameter: string
    edgeBottom: string
  }) =>
    `Section: chamfer Ø ${p.diameter} at ${p.angle}, ${p.depth} deep, on ${p.edgeName} Ø ${p.edgeDiameter} ${p.edgeBottom}.`,
  edgeThrough: 'through',
  edgeDeep: (depth: string) => `${depth} deep`,
} as const
