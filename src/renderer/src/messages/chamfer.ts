// User-facing strings of the chamfer inspector and the Add menu's Chamfer item (v0.4 task U4).
// Terms from docs/glossary.md (chamfer, edge). Doc: docs/conventions/ui.md#chamfer-inspector
export const chamferMessages = {
  groups: { edge: 'Edge', chamfer: 'Chamfer' },
  edge: 'Edge',
  /** An Edge option: "Drilling 2 · Ø 3.4 mm". */
  edgeOption: (name: string, diameter: string) => `${name} · Ø ${diameter}`,
  pickEdge: 'Pick the edge in the viewport',
  pickEdgeField: 'Edge',
  /**
   * The edge operation is gone or not round any more (the command refuses such an edge): its name,
   * never its id (DF43; "Unknown operation" when gone).
   */
  edgeMissing: (name: string) => `${name} (not a drilling, pocket or inside profile)`,
  /** D45: the chamfer's size is its width at the face ("1.5 × 45°"); depth is the alternative. */
  width: 'Width',
  angle: 'Angle',
  depth: 'Depth',
  depthNote: 'Or enter the depth: the width follows through the angle.',
  diameter: 'Diameter',
  diameterNote: 'From the edge and the width.',
  /** Add menu: no drilling, pocket or inside profile in the part (ui.md § Feature rows and Add). */
  noEdge: 'Add a drilling, a pocket or an inside profile first: a chamfer breaks its edge.',
  /** The section illustration's accessible name, built from the values. */
  sectionLabel: (p: {
    width: string
    diameter: string
    angle: string
    depth: string
    edgeName: string
    edgeDiameter: string
    edgeBottom: string
  }) =>
    `Section: chamfer ${p.width} wide at ${p.angle} (Ø ${p.diameter}), ${p.depth} deep, on ${p.edgeName} Ø ${p.edgeDiameter} ${p.edgeBottom}.`,
  edgeThrough: 'through',
  edgeDeep: (depth: string) => `${depth} deep`,
} as const
