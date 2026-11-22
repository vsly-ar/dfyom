/**
 * Per operation: removal, cut and retained labelled meshes plus its surface table. Each
 * operation is built in its face frame (`u` → x, `v` → y, `n` → z, its stock face at z = 0, the
 * stock as `localStock`) exactly as a top operation, then every vertex is placed into the part
 * frame in float64 (before the float32 mesh I/O). v0.1 contours use the offset-loft; general
 * shapes (v0.3) the labelled prisms of `shape-solids.ts`.
 * Doc: docs/architecture/geometry.md#building-the-solids, #non-top-faces-v02,
 * docs/architecture/shapes.md#geometry-for-shape-operations
 */
import { AppError } from '../../shared/errors/app-error'
import { ctx, Err, fail, Ok, type AppResult } from '../../shared/result'
import {
  arcSegments,
  contourElements,
  offsetContour,
  perimeter,
  type ContourLabel,
} from './contour'
import { faceFrame, localStock, type Direction, type FaceFrame } from './face'
import {
  AIR,
  localSolids,
  Table,
  type LocalMesh,
  type LocalSolids as LocalSolidsOf,
  type SurfaceTable,
} from './local-solids'
import { offsetBand, offsetLoft, type LabelledMesh } from './loft'
import {
  CHORD_TOLERANCE,
  EPSILON,
  OVERSHOOT,
  applyPlacement,
  chamferDepth,
  isAnalyticOperation,
  type AnalyticContour as Contour,
  type AnalyticOperation,
  type AnalyticShape,
  type Level,
  type OperationGeometry,
  type PartGeometryInput,
  type StockGeometry,
  type Vec3,
  placeAt,
} from './model'
import { tiledBox, type Triangulate } from './prism'
import { shapePocket, shapeProfile } from './shape-solids'
import type { Region2dPort } from './2d/port'

export { AIR, type SurfaceTable } from './local-solids'

/**
 * A mesh with its vertices in the part frame: placed from its face frame in float64 before the
 * float32 mesh I/O, so one part-frame value rounds to the same float32 in every mesh and walls of
 * two directions meet as exactly as levels do (docs/architecture/shapes.md#geometry-for-shape-operations).
 */
export interface PlacedMesh {
  readonly mesh: LabelledMesh
}

/** What building needs besides the operation: caps' triangulator, the 2D port for general shapes. */
export interface BuildContext {
  readonly triangulate: Triangulate
  /** Required by general shapes (named, rotated, `on`, blind, tab positions); a host bug without. */
  readonly region2d?: Region2dPort
}

type LocalSolids = LocalSolidsOf<AnalyticShape>

/** One operation's solids: (∪ removal − ∪ cut) − ∪ retained. */
export interface OperationSolids {
  readonly id: string
  /** Approach direction (the stock: `+z`). */
  readonly direction: Direction
  /** Face frame of the direction at its stock face: where the meshes were built. */
  readonly frame: FaceFrame
  readonly surfaces: SurfaceTable
  readonly removal: readonly PlacedMesh[]
  /** Subtracted from the removal (the kept side of a profile slot). */
  readonly cut: readonly PlacedMesh[]
  /** Retained regions (tabs); fillets are built into their loft instead. */
  readonly retained: readonly PlacedMesh[]
  /** Nominal retained regions (no overshoot) for the `dfm.retainedRemoved` check. */
  readonly nominal: readonly NominalRegion[]
}

/**
 * A retained region at its nominal size: a tab across exactly the slot, or a floor fillet's
 * zone (the prism `zf..zf + f` minus the pocket's own removal, when `minusRemoval`).
 */
export interface NominalRegion {
  /** Region role, e.g. `tab[0]`, `floorFillet`. */
  readonly region: string
  /** The operation parameter that makes it, e.g. `tabs`, `floorRadius`. */
  readonly parameter: string
  readonly mesh: PlacedMesh
  readonly minusRemoval: boolean
  /**
   * Removals of the same direction whose bounds lie inside this shape (u, v of the face frame)
   * cannot reach the region.
   */
  readonly clearInside?: AnalyticShape
}

/** Half the narrowest size: the largest inward offset a contour allows. */
export function inradius(c: Contour): number {
  return c.kind === 'circle' ? c.radius : Math.min(c.length, c.width) / 2
}

/**
 * An `inside` profile whose slot covers the whole opening (the inset left inside the slot is
 * within the chord tolerance): no offcut, so no tabs are built.
 */
export function slotCoversOpening(op: Extract<OperationGeometry, { kind: 'profile' }>): boolean {
  if (!isAnalyticOperation(op)) return false
  return op.side === 'inside' && inradius(op.shape.contour) - op.slotWidth <= CHORD_TOLERANCE
}

/** True if some operation needs the general builders, and so the 2D port. */
export function needsRegion2d(input: PartGeometryInput): boolean {
  return input.operations.some(
    (op) => (op.kind === 'pocket' || op.kind === 'profile') && !isAnalyticOperation(op),
  )
}

const key = (l: ContourLabel): string => `${l.role}[${l.index}]`

/**
 * `wall[i]` and `corner[i]` roles of a contour, leaving out elements of zero size
 * (`corner[i]` when `cornerRadius` = 0, walls of zero length). Returns label → face index.
 */
function contourRoles(table: Table, contour: Contour): (l: ContourLabel) => number {
  const index = new Map<string, number>()
  const els = contourElements(contour)
  // design order: walls first, then corners, each by index
  const sorted = [...els].sort(
    (a, b) =>
      (a.label.role === 'wall' ? 0 : 1) - (b.label.role === 'wall' ? 0 : 1) ||
      a.label.index - b.label.index,
  )
  for (const e of sorted) {
    const size = e.kind === 'line' ? Math.hypot(e.to[0] - e.from[0], e.to[1] - e.from[1]) : e.radius
    if (size > EPSILON) index.set(key(e.label), table.add(key(e.label)))
  }
  return (l) => index.get(key(l)) ?? AIR
}

/**
 * A box `0..L × 0..W × −T..0` with `stock.top`, `.bottom`, `.side[0..3]`, every face in tiles of
 * ≈ `FACE_TILE` (each tile its own face id, all mapped to the face's role).
 */
export function stockSolids(stock: StockGeometry): AppResult<OperationSolids> {
  const table = new Table()
  const mesh = tiledBox([0, 0, -stock.thickness], [stock.length, stock.width, 0], (f) =>
    table.add(f),
  )
  return Ok(placed('+z', stock, result('stock', table, { removal: [{ mesh, at: [0, 0, 0] }] })))
}

/**
 * The operation's solids: built in the face frame of its direction against the stock seen from
 * there (`localStock`: face rectangle, extent along `n`), then placed by the face frame.
 */
export function operationSolids(
  op: OperationGeometry,
  stock: StockGeometry,
  context: BuildContext,
): AppResult<OperationSolids> {
  const direction = op.direction ?? '+z'
  return build(op, localStock(direction, stock), context)
    .map((local) => placed(direction, stock, local))
    .mapErr(ctx('operationSolids', { operation: op.id, kind: op.kind }))
}

/** Every mesh's vertices placed by the face frame of `direction` into the part frame (float64). */
function placed(direction: Direction, stock: StockGeometry, local: LocalSolids): OperationSolids {
  const frame = faceFrame(direction, stock)
  const place = ({ mesh, at }: LocalMesh): PlacedMesh => {
    const t = placeAt(frame, at)
    const p = mesh.positions
    const positions = new Float64Array(p.length)
    for (let i = 0; i < p.length; i += 3) {
      const q = applyPlacement(t, [p[i]!, p[i + 1]!, p[i + 2]!])
      positions[i] = q[0]
      positions[i + 1] = q[1]
      positions[i + 2] = q[2]
    }
    return { mesh: { ...mesh, positions } }
  }
  return {
    id: local.id,
    direction,
    frame,
    surfaces: local.surfaces,
    removal: local.removal.map(place),
    cut: local.cut.map(place),
    retained: local.retained.map(place),
    nominal: local.nominal.map((r) => ({ ...r, mesh: place(r.mesh) })),
  }
}

function build(
  op: OperationGeometry,
  stock: StockGeometry,
  context: BuildContext,
): AppResult<LocalSolids> {
  switch (op.kind) {
    case 'facing':
      return facing(op, stock)
    case 'pocket':
      if (isAnalyticOperation(op)) return pocket(op)
      return general(op, context).andThen((c) => shapePocket(op, c))
    case 'drilling':
      return drilling(op, stock)
    case 'chamfer':
      return chamfer(op)
    case 'profile':
      if (isAnalyticOperation(op)) return profile(op, stock)
      return general(op, context).andThen((c) => shapeProfile(op, stock, c))
  }
}

/** The context of the general builders; without the 2D port a host bug. */
function general(
  op: OperationGeometry,
  context: BuildContext,
): AppResult<{ triangulate: Triangulate; region2d: Region2dPort }> {
  if (context.region2d === undefined)
    return fail('internal.unexpected', `${op.id}: a shape operation needs the 2D port`, {
      where: 'operationSolids',
      data: { operationId: op.id },
    })
  return Ok({ triangulate: context.triangulate, region2d: context.region2d })
}

const result = localSolids<AnalyticShape>

function facing(
  op: Extract<OperationGeometry, { kind: 'facing' }>,
  stock: StockGeometry,
): AppResult<LocalSolids> {
  const table = new Table()
  // the floor in tiles (later cuts cross it), the faces outside the stock air
  const mesh = tiledBox(
    [-OVERSHOOT, -OVERSHOOT, -op.depth],
    [stock.length + OVERSHOOT, stock.width + OVERSHOOT, OVERSHOOT],
    (f) => (f === 'bottom' ? table.add('floor') : AIR),
  )
  return Ok(result(op.id, table, { removal: [{ mesh, at: [0, 0, 0] }] }))
}

/** Levels (0, ov) → (0, zf + f) → fillet levels φₖ → (f, zf). */
function pocketLevels(zf: number, f: number): Level[] {
  const levels: Level[] = [{ offset: 0, z: OVERSHOOT }]
  if (f <= EPSILON) return [...levels, { offset: 0, z: zf }]
  levels.push({ offset: 0, z: zf + f })
  const n = arcSegments(f, Math.PI / 2)
  for (let k = 1; k <= n; k++) {
    const phi = (k * Math.PI) / (2 * n)
    levels.push({ offset: f * (1 - Math.cos(phi)), z: zf + f * (1 - Math.sin(phi)) })
  }
  return levels
}

function pocket(op: AnalyticOperation<'pocket'>): AppResult<LocalSolids> {
  const table = new Table()
  const floor = table.add('floor')
  const role = contourRoles(table, op.shape.contour)
  const fillet = op.floorRadius > EPSILON ? table.add('floorFillet') : AIR
  const zf = op.onZ - op.depth
  const at: Vec3 = [op.shape.center[0], op.shape.center[1], 0]
  const removal = offsetLoft(op.shape.contour, pocketLevels(zf, op.floorRadius), {
    band: (k, l) => (k === 0 ? role(l) : fillet),
    top: AIR,
    bottom: floor,
  })
  if (removal.isErr() || op.floorRadius <= EPSILON)
    return removal.map((mesh) => result(op.id, table, { removal: [{ mesh, at }] }))
  // nominal fillet zone: the prism zf..zf + f minus this loft (same flattening at offset 0)
  const zone = offsetLoft(
    op.shape.contour,
    [
      { offset: 0, z: zf + op.floorRadius },
      { offset: 0, z: zf },
    ],
    { band: () => AIR, top: AIR, bottom: AIR },
  )
  // the zone lies between the contour and its inset by f: removals inside the inset miss it
  const inset = offsetContour(op.shape.contour, op.floorRadius)
  return zone.map((z) =>
    result(op.id, table, {
      removal: [{ mesh: removal.unwrap(), at }],
      nominal: [
        {
          region: 'floorFillet',
          parameter: 'floorRadius',
          mesh: { mesh: z, at },
          minusRemoval: true,
          ...(inset.isSome() && {
            clearInside: { center: op.shape.center, contour: inset.unwrap() },
          }),
        },
      ],
    }),
  )
}

function drilling(
  op: Extract<OperationGeometry, { kind: 'drilling' }>,
  stock: StockGeometry,
): AppResult<LocalSolids> {
  const table = new Table()
  const wall = table.add('wall')
  const bottom = op.bottom.kind === 'through' ? AIR : table.add('bottom')
  const r = op.diameter / 2
  const levels: Level[] = [{ offset: 0, z: OVERSHOOT }]
  switch (op.bottom.kind) {
    case 'through':
      levels.push({ offset: 0, z: -stock.thickness - OVERSHOOT })
      break
    case 'flat':
      levels.push({ offset: 0, z: op.onZ - op.bottom.depth })
      break
    case 'drillPoint': {
      const zf = op.onZ - op.bottom.depth
      const half = (op.bottom.pointAngle / 2) * (Math.PI / 180)
      levels.push({ offset: 0, z: zf }, { offset: r, z: zf - r / Math.tan(half) })
      break
    }
  }
  return offsetLoft({ kind: 'circle', radius: r }, levels, {
    band: (k) => (k === 0 ? wall : bottom),
    top: AIR,
    bottom,
  }).map((mesh) =>
    result(op.id, table, {
      removal: [{ mesh, at: [op.center[0], op.center[1], 0] }],
    }),
  )
}

/**
 * How far a chamfer's cone runs on past the edge diameter, into the edge operation's empty
 * removal (mm): more than both rings' chord sagitta, so the cone meets the edge's wall inside
 * the hole and leaves no film of stock.
 */
export const CHAMFER_RUN_IN = 4 * CHORD_TOLERANCE

/**
 * A chamfer (v0.4): the cone frustum from the face (`diameter`) down past the edge's diameter,
 * built around the edge's axis in the same face frame as the edge, so both are placed by the same
 * float64 transform (coaxial). Above the face a cylinder of `diameter` up to the overshoot (the
 * mouth's column is the edge's own removal); the bottom cap lies inside the edge's removal (air).
 * Doc: docs/modes/design-v0.4.md#implementation-c2
 */
function chamfer(op: Extract<OperationGeometry, { kind: 'chamfer' }>): AppResult<LocalSolids> {
  const table = new Table()
  const cone = table.add('cone')
  const R = op.diameter / 2
  const runIn = Math.min(CHAMFER_RUN_IN, op.edgeDiameter / 4)
  const tan = Math.tan(((op.angle / 2) * Math.PI) / 180)
  const levels: Level[] = [
    { offset: 0, z: OVERSHOOT },
    { offset: 0, z: op.onZ },
    { offset: R - op.edgeDiameter / 2 + runIn, z: op.onZ - chamferDepth(op) - runIn / tan },
  ]
  return offsetLoft({ kind: 'circle', radius: R }, levels, {
    band: () => cone,
    top: AIR,
    bottom: AIR,
  }).map((mesh) =>
    result(op.id, table, { removal: [{ mesh, at: [op.center[0], op.center[1], 0] }] }),
  )
}

/** Arc length (from the start of wall[0]) of the first tab: the middle of wall[0]; circle: front. */
function firstTab(c: Contour): number {
  return c.kind === 'circle' ? 0 : (c.length - 2 * c.cornerRadius) / 2
}

function profile(op: AnalyticOperation<'profile'>, stock: StockGeometry): AppResult<LocalSolids> {
  const table = new Table()
  const offcut = table.add('offcut')
  const shape = op.shape.contour
  const role = contourRoles(table, shape)
  const T = stock.thickness
  const at: Vec3 = [op.shape.center[0], op.shape.center[1], 0]
  const s = op.slotWidth
  const outside = op.side === 'outside'

  // removal prism: −T − ov..ov, inscribed; kept-side prism: −T − 2ov..2ov, circumscribed
  const removalLevels = [
    { offset: 0, z: OVERSHOOT },
    { offset: 0, z: -T - OVERSHOOT },
  ]
  const cutLevels = [
    { offset: 0, z: 2 * OVERSHOOT },
    { offset: 0, z: -T - 2 * OVERSHOOT },
  ]
  const prism = (c: Contour, levels: Level[], face: (l: ContourLabel) => number, cut: boolean) =>
    offsetLoft(
      c,
      levels,
      { band: (_k, l) => face(l), top: AIR, bottom: AIR },
      cut ? 'circumscribed' : 'inscribed',
    )

  // inside profile whose slot covers the opening (an inset within the chord tolerance counts):
  // no offcut, and nothing for tabs to hold
  const covers = slotCoversOpening(op)
  const tabCount = covers ? 0 : op.tabs.count
  const offset = (d: number): AppResult<Contour> =>
    offsetContour(shape, d).okOr(
      new AppError('geometry.evaluation', 'profile offset passes the shape center', {
        issues: [
          {
            path: ['slotWidth'],
            rule: 'loftInvalid',
            message: 'offset passes the shape center',
            params: { offset: d },
          },
        ],
        where: 'operationSolids',
      }),
    )

  const tabTable = Array.from({ length: tabCount }, (_, i) => ({
    top: table.add(`tab[${i}].top`),
    end: [table.add(`tab[${i}].end[0]`), table.add(`tab[${i}].end[1]`)] as const,
  }))

  const removal = outside
    ? offset(-s).andThen((c) => prism(c, removalLevels, () => offcut, false))
    : prism(shape, removalLevels, role, false)
  if (removal.isErr()) return Err(removal.unwrapErr())

  const cut: LocalMesh[] = []
  if (outside || !covers) {
    const kept = outside
      ? prism(shape, cutLevels, role, true)
      : offset(s).andThen((c) => prism(c, cutLevels, () => offcut, true))
    if (kept.isErr()) return Err(kept.unwrapErr())
    cut.push({ mesh: kept.unwrap(), at })
  }

  // tabs: offset bands across the slot plus ov on both sides, up from below the stock bottom
  const P = perimeter(shape)
  const room = inradius(shape)
  const inner = outside ? Math.min(OVERSHOOT, room / 2) : s + Math.min(OVERSHOOT, (room - s) / 2)
  const outer = outside ? -s - OVERSHOOT : -OVERSHOOT
  const retained: LocalMesh[] = []
  const nominal: LocalSolids['nominal'][number][] = []
  for (let i = 0; i < tabCount; i++) {
    const c = firstTab(shape) + (i * P) / tabCount
    const along = { from: c - op.tabs.width / 2, to: c + op.tabs.width / 2 }
    const band = offsetBand(
      shape,
      { ...along, inner, outer, bottom: -T - 2 * OVERSHOOT, top: -T + op.tabs.thickness },
      { top: tabTable[i]!.top, bottom: AIR, side: AIR, end: tabTable[i]!.end },
    )
    // nominal tab: exactly across the slot, from the stock bottom to the tab top
    const exact = offsetBand(
      shape,
      {
        ...along,
        inner: outside ? 0 : s,
        outer: outside ? -s : 0,
        bottom: -T,
        top: -T + op.tabs.thickness,
      },
      { top: AIR, bottom: AIR, side: AIR, end: [AIR, AIR] },
    )
    const both = band.andThen((b) => exact.map((e) => [b, e] as const))
    if (both.isErr()) return Err(both.unwrapErr().withContext('tab', { index: i }))
    const [b, e] = both.unwrap()
    retained.push({ mesh: b, at })
    nominal.push({
      region: `tab[${i}]`,
      parameter: 'tabs',
      mesh: { mesh: e, at },
      minusRemoval: false,
    })
  }
  return Ok(
    result(op.id, table, { removal: [{ mesh: removal.unwrap(), at }], cut, retained, nominal }),
  )
}
