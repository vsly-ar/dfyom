// Test-only: the v0.4-llm-first exit part (task X0), the black-box test's enclosure base. The
// stock, the clamps, and what the app's own reference tools read from the STL: levels, sections
// and holes, plus the findings on the black-box test's saved programs. Not app code; headless.
// `enclosure-exit.test.ts` recomputes every value from the STL (and the programs), so the record
// cannot drift; X1 asserts its flow reads the same values.
// Docs: docs/plans/v0.4-llm-first.md#exit-criteria, docs/conventions/testing.md#fixtures

/** The stock as `design.part.add` / the stock library takes it: a 250 × 200 × 40 hardwood block. */
export const EXIT_STOCK = {
  name: 'Hardwood',
  shape: 'block',
  length: '250',
  width: '200',
  thickness: '40',
  material: { name: 'Oak', class: 'hardwood' },
} as const

/**
 * `design.reference.import { sourceUnit: 'mm' }` places the STL (249.5 × 177.06 × 39 mm) by its
 * default fit: centred in X/Y, its top on the stock top, so its bottom is 1 mm above the stock
 * bottom (as the black-box test placed it). Part frame, mm.
 */
export const EXIT_PLACED = {
  min: { x: 0.252, y: 11.47, z: -39 },
  max: { x: 249.748, y: 188.53, z: 0 },
} as const

/**
 * The four toe clamps of the black-box test (pads 30 × 10 mm at x 30–60 / 190–220, y 0–10 /
 * 190–200, 25 mm high; its report, 2026-11-22), as `plan.workholding.set` items: on both setups
 * (`copyFrom` for the second), `reach` (50) and the setup's margin (2 mm) at their defaults. They
 * sit symmetrically about the stock centre, so the −z setup's mirrored frame puts them on the
 * same pads.
 */
export const EXIT_CLAMPS = [
  { kind: 'toeClamp', edge: 'vMin', at: '45', width: '30', grip: '10', top: '25' },
  { kind: 'toeClamp', edge: 'vMin', at: '205', width: '30', grip: '10', top: '25' },
  { kind: 'toeClamp', edge: 'vMax', at: '45', width: '30', grip: '10', top: '25' },
  { kind: 'toeClamp', edge: 'vMax', at: '205', width: '30', grip: '10', top: '25' },
] as const

/** Default `reach` of a toe clamp and the setup margin (workholding.md), mm. */
export const EXIT_CLAMP_REACH = 50
export const EXIT_MARGIN = 2

type V2 = readonly [number, number]

export interface ExpectedLevel {
  readonly depth: number
  readonly facing: 'face' | 'opposite'
  readonly area: number
  readonly visibleArea: number
  readonly bounds: readonly [V2, V2]
  readonly depthFromOpposite?: number
}

/**
 * `design.reference.find { kind: 'levels' }` from `stock.top` (both sides, the default), depths
 * from the stock top: the rim (0), the cavity floor (34.815, i.e. 5.185 above the stock bottom),
 * and from the bottom the rim's underside step (5.185), the four hole ends (4.944), the inner step
 * (2.771) and the part's bottom (1, the 1 mm facing).
 */
export const EXIT_LEVELS: readonly ExpectedLevel[] = [
  {
    depth: 0,
    facing: 'face',
    area: 5322.944,
    visibleArea: 5322.944,
    bounds: [
      [0.252, 11.47],
      [249.748, 188.529],
    ],
  },
  {
    depth: 34.815,
    facing: 'face',
    area: 32012.27,
    visibleArea: 32010.269,
    bounds: [
      [7.495, 18.715],
      [242.506, 178.063],
    ],
  },
  {
    depth: 34.815,
    facing: 'opposite',
    area: 562.915,
    visibleArea: 561.032,
    bounds: [
      [0.252, 11.47],
      [249.748, 188.53],
    ],
    depthFromOpposite: 5.185,
  },
  {
    depth: 35.056,
    facing: 'opposite',
    area: 18.798,
    visibleArea: 14.87,
    bounds: [
      [35.246, 54.512],
      [214.754, 145.489],
    ],
    depthFromOpposite: 4.944,
  },
  {
    depth: 37.229,
    facing: 'opposite',
    area: 2753.563,
    visibleArea: 2751.938,
    bounds: [
      [1.056, 12.276],
      [248.943, 187.725],
    ],
    depthFromOpposite: 2.771,
  },
  {
    depth: 39,
    facing: 'opposite',
    area: 33944.705,
    visibleArea: 33944.705,
    bounds: [
      [5.082, 16.299],
      [244.919, 183.701],
    ],
    depthFromOpposite: 1,
  },
]

export interface ExpectedLoop {
  readonly role: 'outer' | 'hole'
  readonly area: number
  readonly bounds: readonly [V2, V2]
  readonly circle?: { readonly center: V2; readonly diameter: number }
  readonly minInsideRadius?: number
  readonly sharp: readonly V2[]
}

export interface ExpectedSection {
  readonly face: 'stock.top' | 'stock.bottom'
  readonly depth: number
  /** What the section is for in the flow. */
  readonly use: string
  /** Sorted by role, then bounds (v, u): the order the test compares in. */
  readonly loops: readonly ExpectedLoop[]
}

const holeCircles = (d: number, area: number, r: number): ExpectedLoop[] =>
  (
    [
      [36.469, 55.734],
      [213.531, 55.734],
      [36.469, 144.265],
      [213.531, 144.265],
    ] as const
  ).map(([u, v]) => ({
    role: 'hole',
    area,
    bounds: [
      [u - d / 2, v - d / 2],
      [u + d / 2, v + d / 2],
    ],
    circle: { center: [u, v], diameter: d },
    minInsideRadius: r,
    sharp: [],
  }))

/**
 * `design.reference.find { kind: 'section' }` in the middle of each band between the levels (the
 * rule `holes` uses), default tolerance 0.01 mm: the wall band from the top (outline and cavity,
 * the cavity's two sharp corners at the back-wall inset), then from the bottom the inner step
 * band (with the countersinks), the outer step band (the bores) and the web under the cavity
 * floor (no holes). Face frames: the bottom's mirrors v. Hole-circle bounds are centre ± d/2.
 */
export const EXIT_SECTIONS: readonly ExpectedSection[] = [
  {
    face: 'stock.top',
    depth: 20,
    use: 'outline (loops: outer) and cavity (loops: holes) → shape',
    loops: [
      {
        role: 'hole',
        area: 32014.323,
        bounds: [
          [7.487, 18.713],
          [242.513, 178.063],
        ],
        minInsideRadius: 57.916,
        sharp: [
          [171.68, 178.063],
          [78.32, 178.063],
        ],
      },
      {
        role: 'outer',
        area: 37336.823,
        bounds: [
          [0.258, 11.467],
          [249.745, 188.53],
        ],
        sharp: [],
      },
    ],
  },
  {
    face: 'stock.bottom',
    depth: 1.886,
    use: 'inner bottom step (1 → 2.771): its outer loop; the countersinks cut through',
    loops: [
      ...holeCircles(3.298, 8.541, 1.649),
      {
        role: 'outer',
        area: 34021.349,
        bounds: [
          [5.081, 16.288],
          [244.928, 183.704],
        ],
        sharp: [],
      },
    ],
  },
  {
    face: 'stock.bottom',
    depth: 3.858,
    use: 'outer bottom step (2.771 → 5.185): its outer loop; the bores cut through',
    loops: [
      ...holeCircles(2.447, 4.702, 1.223),
      {
        role: 'outer',
        area: 36775.122,
        bounds: [
          [1.05, 12.271],
          [248.951, 187.734],
        ],
        sharp: [],
      },
    ],
  },
  {
    face: 'stock.bottom',
    depth: 5.065,
    use: 'the 0.241 mm web between the hole ends and the cavity floor: no holes',
    loops: [
      {
        role: 'outer',
        area: 36775.192,
        bounds: [
          [1.053, 12.278],
          [248.938, 187.729],
        ],
        sharp: [],
      },
    ],
  },
]

/**
 * `design.reference.find { kind: 'holes' }`: none from `stock.top`; from `stock.bottom` one group
 * of four M2 countersunk holes in a 2 × 2 grid, mouth on the part's bottom (1 mm above the stock
 * bottom: `note: 'belowFace'`, so the hole goes on the facing's surface), flat end 4.944 mm from
 * the stock bottom.
 */
export const EXIT_HOLES = {
  top: { holeCount: 0 },
  bottom: {
    holeCount: 4,
    group: {
      count: 4,
      holes: [
        [36.469, 55.734],
        [213.531, 55.734],
        [36.469, 144.265],
        [213.531, 144.265],
      ],
      size: {
        diameter: 2.447,
        top: 1,
        depth: 4.944,
        bottom: 'flat',
        mouth: { type: 'countersink', diameter: 4.861, angle: 82.847 },
      },
      pattern: { kind: 'grid', origin: [36.469, 55.734], pitch: [177.062, 88.531], count: [2, 2] },
    },
    note: 'belowFace',
  },
} as const

/**
 * Expected findings on the black-box test's saved programs (`enclosure-{top,bottom}.nc.gz`):
 * defects of those programs that X1's own programs must not repeat, kept as regression records,
 * **not** passes.
 */
export const EXIT_FINDINGS = {
  /**
   * Pinhole at each of the four holes. The reference leaves `web` = cavity floor (5.185 from the
   * stock bottom) − hole end (4.944) between them. The saved 2.5 mm 118° drill goes to Z −5.691:
   * its shoulder (tip − point length 0.751) stops at 4.940, the hole's flat end, but the point
   * passes the cavity floor by `pastFloor` (the 0.5 mm deviation cells see 0.374 of it, deviation.md
   * § X0). A flat-ended hole over a web thinner than the point length cannot be drilled with a
   * pointed drill.
   */
  drillBreakthrough: {
    holeEnd: 4.944,
    cavityFloor: 5.185,
    web: 0.241,
    drillDiameter: 2.5,
    drillTip: 5.691,
    pointLength: 0.751,
    pastFloor: 0.506,
    pastFloorAtHalfMmCells: 0.374,
  },
  /**
   * The G-code oracle (`gcodeClearance`, tool radius 3 mm for every move, clamp boxes from the
   * pads to `reach`, top 25) on the saved programs: the top keeps 2.504 mm; the bottom misses Q44's
   * 2 mm twice: a feed arc of the outer step at Z −2.77 passes 1.172 mm from a pad corner (X63
   * Y13), and its links at Z26 cross the clamps 1 mm above their tops (inside the margin, so the
   * XY gap is negative). The black-box report's own check said 2.00 mm.
   */
  savedClearance: {
    top: 2.504,
    bottom: -0.372,
    /** Bottom, counting only moves more than 1 mm under the clamp tops' margin (Z < 26). */
    bottomBelowZ26: 1.172,
  },
} as const
