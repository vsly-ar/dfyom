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
  edgeMissing: (name: string) => `${name} (not a drilling, pocket or outside/inside profile)`,
  /** D45: the chamfer's size is its width at the face ("1.5 × 45°"); depth is the alternative. */
  width: 'Width',
  angle: 'Angle',
  depth: 'Depth',
  depthNote: 'Or enter the depth: the width follows through the angle.',
  diameter: 'Diameter',
  diameterNote: 'From the edge and the width.',
  /** Add menu: no drilling, pocket or outside/inside profile in the part (ui.md § Feature rows and Add). */
  noEdge: 'Add a drilling, a pocket or a profile first: a chamfer breaks its edge.',
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
  /** A general edge's section (edge chamfers E3): one wall with its bevel, no diameter. */
  wallSectionLabel: (p: {
    width: string
    angle: string
    depth: string
    edgeName: string
    side: 'inside' | 'outside'
    edgeBottom: string
  }) =>
    `Section: chamfer ${p.width} wide at ${p.angle}, ${p.depth} deep, along ${p.side === 'outside' ? 'the outline of' : 'the wall of'} ${p.edgeName}, ${p.edgeBottom}.`,
  /** An Edge option for a general edge (E3): "Profile 1 · outline", "Pocket 2 · rim". */
  edgeLoopOption: (name: string, role: 'rim' | 'opening' | 'outline') => `${name} · ${role}`,
  /** DF147 SL4: a through Line in the Edge field. */
  edgeLineOption: (name: string) => `${name} · cut-off`,
  /** DF147 SL4: a through Line's chamfer: the side that stays (of the line, start to end). */
  edgeSide: 'Side that stays',
  edgeSides: { left: 'Left', right: 'Right' },
  edgeSideNote:
    'Only the wall on this side is bevelled, left or right looking from the line’s start to its end. The other side is the offcut.',
  /** E4a: the Loops group of a general edge with several loops, one checkbox per loop. */
  loops: 'Loops',
  /** The Loops accordion's summary while closed: how many loops are bevelled. */
  loopsSummary: (chosen: number, all: number) =>
    chosen === all ? `All ${all}` : `${chosen} of ${all}`,
  /** A piece's outer loop by the edge's role: "Rim", "Rim 2", "Opening", "Outline". */
  loopRole:
    (role: 'rim' | 'opening' | 'outline') =>
    (n: number): string =>
      `${{ rim: 'Rim', opening: 'Opening', outline: 'Outline' }[role]}${n > 1 ? ` ${n}` : ''}`,
  island: (n: number) => `Island ${n}`,
  loopsNote: 'The loops this chamfer bevels; at least one.',
  /** E4a: the corner lift switch. */
  cornerLift: 'Corner lift',
  cornerLiftNote: 'Lift the V-bit into sharp inside corners for a crisp mitre.',
  /** E4b: which edge of a through profile, the top or the bottom (from a flipped setup). */
  side: 'Side',
  sides: { top: 'Top edge', bottom: 'Bottom edge' },
  sideNote: 'The bottom edge is cut from a flipped setup; the bevel stops at the tabs.',
  edgeThrough: 'through',
  edgeDeep: (depth: string) => `${depth} deep`,
} as const
