/**
 * Per operation: removal, cut and retained labelled meshes plus its surface table. Each
 * operation is built in its face frame (`u` → x, `v` → y, `n` → z, its stock face at z = 0, the
 * stock as `localStock`) exactly as a top operation, then placed by the face frame.
 * Doc: docs/architecture/geometry.md#building-the-solids, #non-top-faces-v02
 */
import { AppError } from '../../shared/errors/app-error'
import { ctx, Err, Ok, type AppResult } from '../../shared/result'
import {
  arcSegments,
  contourElements,
  offsetContour,
  perimeter,
  type ContourLabel,
} from './contour'
import { faceFrame, localStock, type Direction, type FaceFrame } from './face'
import { offsetBand, offsetLoft, type LabelledMesh } from './loft'
import {
  CHORD_TOLERANCE,
  EPSILON,
  OVERSHOOT,
  type Contour,
  type Level,
  type OperationGeometry,
  type Placement,
  type Shape,
  type StockGeometry,
  type Vec3,
  placeAt,
} from './model'

/** A mesh in its local frame plus the rigid placement into the part frame. */
export interface PlacedMesh {
  readonly mesh: LabelledMesh
  readonly place: Placement
}

/** A mesh built around `at` in its operation's face frame (placed later by that frame). */
interface LocalMesh {
  readonly mesh: LabelledMesh
  readonly at: Vec3
  /**
   * The z of the mesh's key level (a floor, a tab top), moved from the vertices into the float64
   * placement: mesh I/O is float32, so this level lands exactly where the analytic model puts it
   * and meets the same level of other directions without a float32 gap (fewer slivers).
   */
  readonly level?: number
}

/**
 * Surface roles of one operation (or the stock); a mesh's face label is the index here.
 * Index 0 is `air` (never survives); `offcut` (profiles) may survive but is not referenceable.
 */
export type SurfaceTable = readonly string[]

export const AIR = 0

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
  readonly clearInside?: Shape
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
  return op.side === 'inside' && inradius(op.shape.contour) - op.slotWidth <= CHORD_TOLERANCE
}

/** Surface table under construction: role → index. */
class Table {
  private readonly roles: string[] = ['air']
  add(role: string): number {
    this.roles.push(role)
    return this.roles.length - 1
  }
  get surfaces(): SurfaceTable {
    return this.roles
  }
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

/** A box `0..L × 0..W × −T..0` with `stock.top`, `.bottom`, `.side[0..3]`. */
export function stockSolids(stock: StockGeometry): AppResult<OperationSolids> {
  const table = new Table()
  const top = table.add('top')
  const bottom = table.add('bottom')
  const sides = [0, 1, 2, 3].map((i) => table.add(`side[${i}]`))
  const contour: Contour = {
    kind: 'rectangle',
    length: stock.length,
    width: stock.width,
    cornerRadius: 0,
  }
  return offsetLoft(
    contour,
    [
      { offset: 0, z: 0 },
      { offset: 0, z: -stock.thickness },
    ],
    { band: (_k, l) => (l.role === 'wall' ? sides[l.index]! : AIR), top, bottom },
  ).map((mesh) =>
    placed(
      '+z',
      stock,
      result('stock', table, {
        removal: [{ mesh, at: [stock.length / 2, stock.width / 2, 0] }],
      }),
    ),
  )
}

/**
 * The operation's solids: built in the face frame of its direction against the stock seen from
 * there (`localStock`: face rectangle, extent along `n`), then placed by the face frame.
 */
export function operationSolids(
  op: OperationGeometry,
  stock: StockGeometry,
): AppResult<OperationSolids> {
  const direction = op.direction ?? '+z'
  return build(op, localStock(direction, stock))
    .map((local) => placed(direction, stock, local))
    .mapErr(ctx('operationSolids', { operation: op.id, kind: op.kind }))
}

/** An operation built in its face frame, before placement. */
interface LocalSolids {
  readonly id: string
  readonly surfaces: SurfaceTable
  readonly removal: readonly LocalMesh[]
  readonly cut: readonly LocalMesh[]
  readonly retained: readonly LocalMesh[]
  readonly nominal: readonly (Omit<NominalRegion, 'mesh'> & { readonly mesh: LocalMesh })[]
}

/** Every mesh placed by the face frame of `direction` (the identity for `+z`). */
function placed(direction: Direction, stock: StockGeometry, local: LocalSolids): OperationSolids {
  const frame = faceFrame(direction, stock)
  const place = ({ mesh, at, level = 0 }: LocalMesh): PlacedMesh =>
    level === 0
      ? { mesh, place: placeAt(frame, at) }
      : { mesh: shifted(mesh, -level), place: placeAt(frame, [at[0], at[1], at[2] + level]) }
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

/** `mesh` moved by `dz` along z (float64, before the float32 mesh I/O). */
function shifted(mesh: LabelledMesh, dz: number): LabelledMesh {
  const positions = Float64Array.from(mesh.positions)
  for (let i = 2; i < positions.length; i += 3) positions[i]! += dz
  return { ...mesh, positions }
}

function build(op: OperationGeometry, stock: StockGeometry): AppResult<LocalSolids> {
  switch (op.kind) {
    case 'facing':
      return facing(op, stock)
    case 'pocket':
      return pocket(op)
    case 'drilling':
      return drilling(op, stock)
    case 'profile':
      return profile(op, stock)
  }
}

const result = (
  id: string,
  table: Table,
  parts: {
    removal: LocalMesh[]
    cut?: LocalMesh[]
    retained?: LocalMesh[]
    nominal?: LocalSolids['nominal'][number][]
  },
): LocalSolids => ({
  id,
  surfaces: table.surfaces,
  removal: parts.removal,
  cut: parts.cut ?? [],
  retained: parts.retained ?? [],
  nominal: parts.nominal ?? [],
})

function facing(
  op: Extract<OperationGeometry, { kind: 'facing' }>,
  stock: StockGeometry,
): AppResult<LocalSolids> {
  const table = new Table()
  const floor = table.add('floor')
  const contour: Contour = {
    kind: 'rectangle',
    length: stock.length + 2 * OVERSHOOT,
    width: stock.width + 2 * OVERSHOOT,
    cornerRadius: 0,
  }
  return offsetLoft(
    contour,
    [
      { offset: 0, z: OVERSHOOT },
      { offset: 0, z: -op.depth },
    ],
    { band: () => AIR, top: AIR, bottom: floor },
  ).map((mesh) =>
    result(op.id, table, {
      removal: [{ mesh, at: [stock.length / 2, stock.width / 2, 0], level: -op.depth }],
    }),
  )
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

function pocket(op: Extract<OperationGeometry, { kind: 'pocket' }>): AppResult<LocalSolids> {
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
    return removal.map((mesh) => result(op.id, table, { removal: [{ mesh, at, level: zf }] }))
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
      removal: [{ mesh: removal.unwrap(), at, level: zf }],
      nominal: [
        {
          region: 'floorFillet',
          parameter: 'floorRadius',
          mesh: { mesh: z, at, level: zf },
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
      removal: [
        {
          mesh,
          at: [op.center[0], op.center[1], 0],
          level: op.bottom.kind === 'through' ? 0 : op.onZ - op.bottom.depth,
        },
      ],
    }),
  )
}

/** Arc length (from the start of wall[0]) of the first tab: the middle of wall[0]; circle: front. */
function firstTab(c: Contour): number {
  return c.kind === 'circle' ? 0 : (c.length - 2 * c.cornerRadius) / 2
}

function profile(
  op: Extract<OperationGeometry, { kind: 'profile' }>,
  stock: StockGeometry,
): AppResult<LocalSolids> {
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
    const level = -T + op.tabs.thickness
    retained.push({ mesh: b, at, level })
    nominal.push({
      region: `tab[${i}]`,
      parameter: 'tabs',
      mesh: { mesh: e, at, level },
      minusRemoval: false,
    })
  }
  return Ok(
    result(op.id, table, { removal: [{ mesh: removal.unwrap(), at }], cut, retained, nominal }),
  )
}
