/**
 * Mapping a split source part into its pieces (split parts 4a): per non-empty cell a piece part
 * record in its own frame (its blank's front-left top corner) with the source's operations mapped
 * by the doc's table and a generated outline, plus the findings the mapping makes (`cutsFeature`).
 * Pure; the 2D port clips shapes.
 * Doc: docs/modes/split-parts.md#mapping-the-source-into-a-piece,
 * docs/modes/split-parts.md#blanks-and-margins
 */
import { Err, fail, Ok, type AppResult } from '../../../shared/result'
import type { Region2dPort } from '../../geometry/2d/port'
import { chainBounds, type Bounds2 } from '../../geometry/2d/model'
import type { DfmWarning, OperationGeometry } from '../../geometry/model'
import { toGeometryInput } from '../geometry-input'
import type { LoadedPart } from '../load'
import { fieldContext, type Operation } from '../operation'
import type { OperationDTO, OperationShapeDTO, PartDTO, SplitDTO } from '../part.dto'
import { orientedShape, shapeDefinition, shapeOrientation } from '../placement'
import type { ShapeDefinition } from '../shape'
import type { ShapeDTO, ShapeItemDTO } from '../shape.dto'
import { SurfaceTable } from '../surfaces'
import { STOCK_FACE } from '../../geometry/face'
import { operationTools } from '../tool-choice'
import type { UnitSystem } from '../../project/document'
import type { QuantityDTO } from '../../quantity/quantity.dto'
import { parseLiteral } from '../../quantity/parse'
import {
  EPS,
  regionBounds,
  shapeRegion,
  splitLayout,
  splitNumbers,
  type Cell,
  type Layout,
  type Rect,
} from './layout'
import { dowelOperations } from './dowels'

/** Rounding of computed lengths: 1 µm (exact rationals over 10⁶). */
const MICRO = 1_000_000

/** The design code of every split finding; `params.rule` names the rule (split-parts.md § DFM). */
export const SPLIT_CODE = 'design.split'

export type SplitRule =
  | 'noOutline'
  | 'cutsFeature'
  | 'featureNear'
  | 'thinJoint'
  | 'sliver'
  | 'noStock'
  | 'outsideTravel'
  | 'fitsWhole'
  | 'dowelNear'
  | 'dowelFit'

export function splitFinding(
  splitId: string,
  rule: SplitRule,
  severity: 'warning' | 'info',
  message: string,
  params: Record<string, number | string | readonly string[] | readonly number[]> = {},
): DfmWarning {
  return {
    code: SPLIT_CODE as DfmWarning['code'],
    severity,
    message,
    operation: splitId,
    params: { rule, ...params },
  }
}

/** One piece as the mapping makes it (ids and the stock snapshot are given when written). */
export interface PiecePlan {
  readonly n: number
  readonly cell: Cell
  /** Blank sizes (mm): bounds + margin per side in X and Y, the band in Z. */
  readonly blank: { readonly length: number; readonly width: number; readonly thickness: number }
  /** Source part frame + offset = piece frame (mm). */
  readonly offset: readonly [number, number, number]
  readonly name: string
  readonly operations: OperationDTO[]
  readonly shapes: ShapeDTO[]
}

export interface PiecesResult {
  readonly layout: Layout
  readonly pieces: readonly PiecePlan[]
  readonly findings: readonly DfmWarning[]
}

// ── quantities ────────────────────────────────────────────────────────────────────────────

type LengthDTO = QuantityDTO & { kind: 'length' }
type AngleDTO = QuantityDTO & { kind: 'angle' }
const asLength = (q: QuantityDTO) => q as LengthDTO

const round = (mm: number) => Math.round(mm * MICRO) / MICRO

function lengthDTO(mm: number, units: UnitSystem): LengthDTO {
  const n = BigInt(Math.round(mm * MICRO))
  const g = gcd(n < 0n ? -n : n, BigInt(MICRO))
  const num = n / g
  const den = BigInt(MICRO) / g
  const v = Number(num) / Number(den)
  const source = units === 'inch' ? `${+(v / 25.4).toFixed(5)}"` : `${+v.toFixed(4)} mm`
  return {
    kind: 'length',
    source,
    defaultUnit: fieldContext('length', units).defaultUnit,
    exact: { num: num.toString(), den: den.toString() },
  }
}

function angleDTO(deg: number): AngleDTO {
  const n = BigInt(Math.round(deg * MICRO))
  const g = gcd(n < 0n ? -n : n, BigInt(MICRO))
  return {
    kind: 'angle',
    source: `${+deg.toFixed(4)}°`,
    defaultUnit: 'deg',
    exact: { num: (n / g).toString(), den: (BigInt(MICRO) / g).toString() },
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b]
  return a === 0n ? 1n : a
}

const mmOf = (q: QuantityDTO) => Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))

/** `q` moved by `delta` mm, exact (the delta rounded to 1 µm). */
function shifted(q: QuantityDTO, delta: number, units: UnitSystem): LengthDTO {
  const d = BigInt(Math.round(delta * MICRO))
  const num = BigInt(q.exact.num) * BigInt(MICRO) + d * BigInt(q.exact.den)
  const den = BigInt(q.exact.den) * BigInt(MICRO)
  const g = gcd(num < 0n ? -num : num, den)
  const exact = { num: (num / g).toString(), den: (den / g).toString() }
  const v = Number(num / g) / Number(den / g)
  const source = units === 'inch' ? `${+(v / 25.4).toFixed(5)}"` : `${+v.toFixed(4)} mm`
  return { kind: 'length', source, defaultUnit: q.defaultUnit, exact }
}

const isQuantity = (v: unknown): v is QuantityDTO =>
  typeof v === 'object' &&
  v !== null &&
  'exact' in v &&
  'source' in v &&
  'kind' in v &&
  'defaultUnit' in v

/**
 * A deep copy with every formula source replaced by its value (piece operations hold resolved
 * values; the source keeps the expressions, split-parts.md § Mapping).
 */
function literal<T>(value: T, units: UnitSystem): T {
  if (Array.isArray(value)) return value.map((v: unknown) => literal(v, units)) as T
  if (typeof value !== 'object' || value === null) return value
  if (isQuantity(value)) {
    const ok = parseLiteral(value.source, { kind: value.kind, defaultUnit: value.defaultUnit })
    if (ok.isOk()) return { ...value } as T
    const v = mmOf(value)
    const source =
      value.kind === 'length'
        ? lengthDTO(v, units).source
        : value.kind === 'angle'
          ? `${+v.toFixed(4)}°`
          : `${+v.toFixed(6)}`
    return { ...value, source } as T
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = literal(v, units)
  return out as T
}

// ── geometry helpers ──────────────────────────────────────────────────────────────────────

type Dir = '+z' | '-z'

/** The part-frame z range an operation removes (or bevels), and where it starts. */
interface ZRange {
  readonly dir: Dir
  readonly zlo: number
  readonly zhi: number
  readonly through: boolean
}

const overlaps = (a: Rect, b: Bounds2) =>
  a.x0 < b.max[0] - EPS && a.x1 > b.min[0] + EPS && a.y0 < b.max[1] - EPS && a.y1 > b.min[1] + EPS

const inside = (b: Bounds2, r: Rect) =>
  b.min[0] >= r.x0 - EPS &&
  b.max[0] <= r.x1 + EPS &&
  b.min[1] >= r.y0 - EPS &&
  b.max[1] <= r.y1 + EPS

/** Face-frame point (u, v) of a ±z operation → part-frame (x, y). */
const toPart = (dir: Dir, W: number, p: readonly [number, number]): [number, number] =>
  dir === '+z' ? [p[0], p[1]] : [p[0], W - p[1]]

/** Part-frame bounds of face-frame bounds. */
function partBounds(dir: Dir, W: number, b: Bounds2): Bounds2 {
  if (dir === '+z') return b
  return { min: [b.min[0], W - b.max[1]], max: [b.max[0], W - b.min[1]] }
}

/** cos, sin exact at multiples of 90°. */
function cosSin(deg: number): readonly [number, number] {
  const turn = (((deg % 360) + 360) % 360) / 90
  if (Number.isInteger(turn)) return [[1, 0, -1, 0][turn]!, [0, 1, 0, -1][turn]!]
  const r = (deg * Math.PI) / 180
  return [Math.cos(r), Math.sin(r)]
}

/** The inverse of the shape orientation (mirror x, then rotate): rotate back, then mirror. */
function unorient(
  p: readonly [number, number],
  rotation: number,
  mirror: boolean,
): [number, number] {
  const [c, s] = cosSin(rotation)
  const x = c * p[0] + s * p[1]
  const y = -s * p[0] + c * p[1]
  return [mirror ? -x : x, y]
}

const centreOf = (b: Bounds2): [number, number] => [
  (b.min[0] + b.max[0]) / 2,
  (b.min[1] + b.max[1]) / 2,
]

// ── mapping ───────────────────────────────────────────────────────────────────────────────

interface Ctx {
  readonly loaded: LoadedPart
  readonly port: Region2dPort
  readonly geometry: readonly OperationGeometry[]
  readonly table: SurfaceTable
  readonly T: number
  readonly W: number
  readonly split: ReturnType<typeof splitNumbers>
  readonly units: UnitSystem
  readonly footprintBounds: Bounds2
  readonly toolDiameter: (op: Operation) => number
  readonly finding: (op: Operation, key: string, message: string) => void
}

function zRange(c: Ctx, op: Operation, g: OperationGeometry): ZRange | undefined {
  const dir = g.direction ?? '+z'
  if (dir !== '+z' && dir !== '-z') return undefined
  const entry = c.table.get(op.on)
  if (entry.isNone()) return undefined
  const faceZ = entry.unwrap().faceZ.toNumber()
  const zOn = dir === '+z' ? faceZ : -c.T - faceZ
  let depth = 0
  let through = false
  switch (op.kind) {
    case 'facing':
      depth = op.depth.canonical
      break
    case 'pocket':
      depth = op.depth.canonical
      break
    case 'drilling':
      if (op.bottom === 'through') through = true
      else depth = op.depth.mapOr(0, (q) => q.canonical)
      break
    case 'profile':
      if (op.depth.isNone()) through = true
      else depth = op.depth.unwrap().canonical
      break
    case 'chamfer': {
      const half = (op.angle.canonical * Math.PI) / 360
      depth = op.width.canonical / Math.tan(half)
      break
    }
  }
  if (dir === '+z') return { dir, zhi: zOn, zlo: through ? -c.T : zOn - depth, through }
  return { dir, zlo: zOn, zhi: through ? 0 : zOn + depth, through }
}

/** Where an operation starts in a piece and how deep it goes there. */
interface ZPlan {
  /** It starts at or beyond the piece's stock face of its direction (`on` becomes that face). */
  readonly fromFace: boolean
  /** It ends at or beyond the opposite face: a through cut in the piece. */
  readonly capped: boolean
  readonly depth: number
}

function zPlan(r: ZRange, zb: number, zt: number): ZPlan | undefined {
  if (r.zlo >= zt - EPS || r.zhi <= zb + EPS) return undefined
  const depth = Math.min(r.zhi, zt) - Math.max(r.zlo, zb)
  if (r.dir === '+z') return { fromFace: r.zhi >= zt - EPS, capped: r.zlo <= zb + EPS, depth }
  return { fromFace: r.zlo <= zb + EPS, capped: r.zhi >= zt - EPS, depth }
}

/** Surfaces of piece operations whose floor (bottom, tab tops) is where the source has it. */
function surfaceOwner(on: string): { op: string; role: string } | undefined {
  const m = /^([^.]+)\.(.+)$/.exec(on)
  if (m === null || m[1] === 'stock') return undefined
  return { op: m[1]!, role: m[2]! }
}

interface PieceBuild {
  readonly ops: OperationDTO[]
  readonly shapes: ShapeDTO[]
  /** Mapped operation ids → whether their floor surface is intact (not capped). */
  readonly floors: Map<string, boolean>
  /** Mapped operation ids whose `on` is their source `on` (not moved to the stock face). */
  readonly sameOn: Set<string>
  nextShape: number
}

/**
 * The shape of `op` in the piece, clipped to `rect` (part frame) grown by `grow`: a named shape of
 * the piece with the source definition and an `intersect` rectangle; undefined = nothing left.
 */
function clippedShape(
  c: Ctx,
  op: Extract<Operation, { kind: 'pocket' | 'profile' }>,
  g: Extract<OperationGeometry, { kind: 'pocket' | 'profile' }>,
  dir: Dir,
  rect: Rect,
  grow: number,
  delta: readonly [number, number],
  b: PieceBuild,
): AppResult<OperationShapeDTO | undefined> {
  const def = shapeDefinition(op.shape, c.loaded.part.shapes)
  if (def.isErr()) return def
  const o = shapeOrientation(op.shape)
  const oriented = orientedShape(c.port, def.unwrap(), o)
  if (oriented.isErr()) return oriented
  const origin: [number, number] = [
    g.shape.center[0] - centreOf(oriented.unwrap().bounds)[0],
    g.shape.center[1] - centreOf(oriented.unwrap().bounds)[1],
  ]
  // the rectangle in the face frame, then in the shape frame
  const u0 = rect.x0 - grow
  const u1 = rect.x1 + grow
  const v0 = dir === '+z' ? rect.y0 - grow : c.W - rect.y1 - grow
  const v1 = dir === '+z' ? rect.y1 + grow : c.W - rect.y0 + grow
  const cs = unorient([(u0 + u1) / 2 - origin[0], (v0 + v1) / 2 - origin[1]], o.rotation, o.mirror)
  const rot = o.mirror ? o.rotation : -o.rotation
  const cut = {
    kind: 'rectangle' as const,
    op: 'intersect' as const,
    center: [cs[0], cs[1]] as [number, number],
    length: u1 - u0,
    width: v1 - v0,
    cornerRadius: 0,
    ...(Math.abs(rot) > 1e-9 ? { rotation: rot } : {}),
  }
  const def2: ShapeDefinition = [...def.unwrap(), cut]
  const clipped = orientedShape(c.port, def2, o)
  if (clipped.isErr()) return Ok(undefined)
  const bb = clipped.unwrap().bounds
  if (bb.max[0] - bb.min[0] < EPS || bb.max[1] - bb.min[1] < EPS) return Ok(undefined)
  const centre: [number, number] = [
    origin[0] + delta[0] + centreOf(bb)[0],
    origin[1] + delta[1] + centreOf(bb)[1],
  ]
  // the piece's shape record: the source items (or the inline shape as one item) and the cut
  const s = op.shape
  const L = (mm: number) => lengthDTO(mm, c.units)
  let items: ShapeItemDTO[]
  if (s.kind === 'named') {
    const src = c.loaded.dto.shapes?.find((x) => x.id === s.shapeId)
    if (src === undefined) return Ok(undefined)
    items = literal(src.items, c.units)
  } else if (s.kind === 'rectangle')
    items = [
      {
        kind: 'rectangle',
        op: 'add',
        center: [L(0), L(0)],
        length: asLength(s.length.toDTO()),
        width: asLength(s.width.toDTO()),
        cornerRadius: asLength(s.cornerRadius.toDTO()),
      },
    ]
  else
    items = [
      { kind: 'circle', op: 'add', center: [L(0), L(0)], diameter: asLength(s.diameter.toDTO()) },
    ]
  items = literal(items, c.units)
  items.push({
    kind: 'rectangle',
    op: 'intersect',
    center: [L(cs[0]), L(cs[1])],
    length: L(cut.length),
    width: L(cut.width),
    cornerRadius: L(0),
    ...(cut.rotation === undefined ? {} : { rotation: angleDTO(cut.rotation) }),
  })
  const id = `shape${b.nextShape++}`
  b.shapes.push({ id, name: `${op.name} · piece`, items })
  const rotation =
    s.kind !== 'circle' && s.rotation.isSome()
      ? (s.rotation.unwrap().toDTO() as AngleDTO)
      : undefined
  return Ok({
    kind: 'named',
    shapeId: id,
    center: [L(centre[0]), L(centre[1])],
    ...(rotation === undefined ? {} : { rotation: literal(rotation, c.units) }),
    ...(s.kind === 'named' && s.mirror ? { mirror: true as const } : {}),
  })
}

/** The shape shifted by `delta` (face frame), as a record. */
function shiftedShape(
  dto: OperationShapeDTO,
  delta: readonly [number, number],
  units: UnitSystem,
): OperationShapeDTO {
  return {
    ...dto,
    center: [shifted(dto.center[0], delta[0], units), shifted(dto.center[1], delta[1], units)],
  }
}

/** Piece outline: the cell region as a through outside profile on the piece's top. */
function outlineOperation(
  c: Ctx,
  cell: Cell,
  offset: readonly [number, number, number],
  b: PieceBuild,
  outline: Extract<Operation, { kind: 'profile' }> | undefined,
  outlineDto: Extract<OperationDTO, { kind: 'profile' }> | undefined,
  outlineGeometry: Extract<OperationGeometry, { kind: 'profile' }> | undefined,
): AppResult<OperationDTO> {
  const L = (mm: number) => lengthDTO(mm, c.units)
  const id = `${c.split.id}_outline`
  const delta: [number, number] = [offset[0], offset[1]]
  let shape: OperationShapeDTO
  if (outline === undefined || outlineDto === undefined || outlineGeometry === undefined) {
    const bb = cell.bounds
    shape = {
      kind: 'rectangle',
      center: [
        L((bb.min[0] + bb.max[0]) / 2 + delta[0]),
        L((bb.min[1] + bb.max[1]) / 2 + delta[1]),
      ],
      length: L(bb.max[0] - bb.min[0]),
      width: L(bb.max[1] - bb.min[1]),
      cornerRadius: L(0),
    }
  } else {
    const whole = inside(c.footprintBounds, cell.rect)
    if (whole) shape = shiftedShape(literal(outlineDto.shape, c.units), delta, c.units)
    else {
      const clipped = clippedShape(c, outline, outlineGeometry, '+z', cell.rect, 0, delta, b)
      if (clipped.isErr()) return clipped
      if (clipped.unwrap() === undefined)
        return fail('internal.unexpected', `piece ${cell.n} has no outline`, {
          where: 'planPieces',
        })
      shape = clipped.unwrap()!
    }
  }
  const slot = outlineDto?.slotWidth ?? lengthDTO(c.units === 'inch' ? 6.35 : 6, c.units)
  const tabs = outlineDto?.tabs
  return Ok({
    kind: 'profile',
    id,
    name: outline?.name ?? 'Piece outline',
    on: STOCK_FACE['+z'],
    shape,
    side: 'outside',
    slotWidth: literal(slot, c.units),
    tabs: tabs
      ? literal({ count: tabs.count, width: tabs.width, thickness: tabs.thickness }, c.units)
      : {
          count: { kind: 'scalar', source: '4', defaultUnit: '1', exact: { num: '4', den: '1' } },
          width: literal(L(DEFAULTS_MM.tabWidth[c.units]), c.units),
          thickness: literal(L(DEFAULTS_MM.tabThickness[c.units]), c.units),
        },
    ...(outlineDto?.tool === undefined ? {} : { tool: outlineDto.tool }),
    ...(outlineDto?.toolLocked === undefined ? {} : { toolLocked: outlineDto.toolLocked }),
  })
}

/** Tab defaults in mm (design.md: 6 mm / 1/4", 2 mm / 1/16"). */
const DEFAULTS_MM = {
  tabWidth: { mm: 6, inch: 6.35 },
  tabThickness: { mm: 2, inch: 1.5875 },
} as const

/** Maps one source operation into a piece; undefined = not in the piece. */
function mapOperation(
  c: Ctx,
  i: number,
  cell: Cell,
  offset: readonly [number, number, number],
  blankW: number,
  b: PieceBuild,
): AppResult<OperationDTO | undefined> {
  const op = c.loaded.part.operations[i]!
  const g = c.geometry[i]!
  const src = c.loaded.dto.operations[i]!
  const r = zRange(c, op, g)
  if (r === undefined) return Ok(undefined)
  const z = zPlan(r, cell.band.zb, cell.band.zt)
  if (z === undefined) return Ok(undefined)
  const dir = r.dir
  const delta: [number, number] =
    dir === '+z' ? [offset[0], offset[1]] : [offset[0], blankW - c.W - offset[1]]
  // `on`: the piece's stock face when it starts beyond it, else the source surface if intact
  let on: string | undefined = src.on
  if (z.fromFace) on = STOCK_FACE[dir]
  else {
    const owner = surfaceOwner(src.on ?? STOCK_FACE[dir])
    const intact =
      owner !== undefined && !owner.role.startsWith('tab[') && b.floors.get(owner.op) === true
    if (!intact) {
      c.finding(op, `on:${op.id}`, `${op.name} starts on a face the piece does not have`)
      return Ok(undefined)
    }
  }
  const base = literal(src, c.units) as OperationDTO & Record<string, unknown>
  delete base['featureId']
  delete base['featureRole']
  const L = (mm: number) => lengthDTO(mm, c.units)
  const depthChanged = z.fromFace || z.capped
  let out: OperationDTO
  switch (base.kind) {
    case 'facing':
      out = { ...base, on, ...(depthChanged ? { depth: L(z.depth) } : {}) }
      break
    case 'drilling': {
      const centre = toPart(dir, c.W, [
        g.kind === 'drilling' ? g.center[0] : 0,
        g.kind === 'drilling' ? g.center[1] : 0,
      ])
      const { x0, x1, y0, y1 } = cell.rect
      const lastX = Math.abs(x1 - c.loaded.stock.length.canonical) < EPS
      const lastY = Math.abs(y1 - c.W) < EPS
      const inX =
        centre[0] >= x0 - EPS && (centre[0] < x1 - EPS || (lastX && centre[0] <= x1 + EPS))
      const inY =
        centre[1] >= y0 - EPS && (centre[1] < y1 - EPS || (lastY && centre[1] <= y1 + EPS))
      if (!inX || !inY) return Ok(undefined)
      const d: OperationDTO & { kind: 'drilling' } = {
        ...base,
        on: on!,
        center: [
          shifted(base.center[0], delta[0], c.units),
          shifted(base.center[1], delta[1], c.units),
        ],
      }
      if (z.capped) {
        d.bottom = 'through'
        delete d.depth
        delete d.pointAngle
      } else if (z.fromFace) d.depth = L(z.depth)
      out = d
      break
    }
    case 'pocket':
    case 'profile': {
      const gs = g as Extract<OperationGeometry, { kind: 'pocket' | 'profile' }>
      const opS = op as Extract<Operation, { kind: 'pocket' | 'profile' }>
      const region = shapeBounds(gs)
      const bounds = region === undefined ? undefined : partBounds(dir, c.W, region)
      if (bounds !== undefined && !overlaps(cell.rect, bounds)) return Ok(undefined)
      let shape: OperationShapeDTO
      if (bounds !== undefined && inside(bounds, cell.rect))
        shape = shiftedShape(base.shape, delta, c.units)
      else {
        const open = gs.shape.contour.kind === 'path'
        if (open) {
          c.finding(op, `open:${op.id}`, `${op.name} is an open path crossed by a split line`)
          return Ok(undefined)
        }
        const clipped = clippedShape(c, opS, gs, dir, cell.rect, c.toolDiameter(op), delta, b)
        if (clipped.isErr()) return clipped
        if (clipped.unwrap() === undefined) return Ok(undefined)
        shape = clipped.unwrap()!
      }
      if (base.kind === 'pocket' && z.capped) {
        // a pocket through the piece: a pocket must end above the stock bottom, so it becomes a
        // through inside profile; its core is waste held by tabs (one tool Ø slot)
        const fr = mmOf(base.floorRadius)
        if (
          fr > 0 &&
          (r.dir === '+z' ? r.zlo + fr > cell.band.zb + EPS : r.zhi - fr < cell.band.zt - EPS)
        )
          c.finding(op, `fillet:${op.id}`, `${op.name}'s floor fillet is cut by a split level`)
        const { depth: _d, floorRadius: _f, ...rest } = base
        out = {
          ...rest,
          kind: 'profile',
          on: STOCK_FACE[dir],
          shape,
          side: 'inside',
          slotWidth: L(c.toolDiameter(op)),
          tabs: {
            count: { kind: 'scalar', source: '4', defaultUnit: '1', exact: { num: '4', den: '1' } },
            width: L(DEFAULTS_MM.tabWidth[c.units]),
            thickness: L(DEFAULTS_MM.tabThickness[c.units]),
          },
        }
      } else if (base.kind === 'pocket') {
        const p: OperationDTO & { kind: 'pocket' } = { ...base, on: on!, shape }
        if (depthChanged) p.depth = L(z.depth)
        const fr = mmOf(base.floorRadius)
        if (z.capped && fr > 0) {
          p.floorRadius = L(0)
          if (r.dir === '+z' ? r.zlo + fr > cell.band.zb + EPS : r.zhi - fr < cell.band.zt - EPS)
            c.finding(op, `fillet:${op.id}`, `${op.name}'s floor fillet is cut by a split level`)
        } else if (fr > z.depth + EPS) {
          p.floorRadius = L(z.depth)
          c.finding(op, `fillet:${op.id}`, `${op.name}'s floor fillet is cut by a split level`)
        }
        out = p
      } else {
        const p: OperationDTO & { kind: 'profile' } = { ...base, on, shape }
        // through the piece: from its stock face (a through profile starts on one)
        if (z.capped) {
          delete p.depth
          p.on = STOCK_FACE[dir]
        } else if (z.fromFace && p.depth !== undefined) p.depth = L(z.depth)
        if (p.tabs.positions !== undefined && shape !== base.shape) {
          const { positions: _, ...tabs } = p.tabs
          p.tabs = tabs
        }
        out = p
      }
      break
    }
    case 'chamfer': {
      // with its edge, on the same face; a cone cut by a level stays whole in the upper piece
      if (z.fromFace || !b.sameOn.has(base.edgeOf)) return Ok(undefined)
      if (z.capped || (r.dir === '+z' ? r.zlo < cell.band.zb - EPS : r.zhi > cell.band.zt + EPS))
        c.finding(op, `cone:${op.id}`, `${op.name} is cut by a split level`)
      out = { ...base, on: on! }
      break
    }
  }
  b.floors.set(op.id, !z.capped)
  if (!z.fromFace) b.sameOn.add(op.id)
  return Ok(out)
}

function shapeBounds(
  g: Extract<OperationGeometry, { kind: 'pocket' | 'profile' }>,
): Bounds2 | undefined {
  if (g.shape.contour.kind === 'path') {
    const b = chainBounds(g.shape.contour.path.elements)
    const c = g.shape.center
    return b === undefined
      ? undefined
      : { min: [b.min[0] + c[0], b.min[1] + c[1]], max: [b.max[0] + c[0], b.max[1] + c[1]] }
  }
  const r = shapeRegion(g.shape)
  return r === undefined ? undefined : regionBounds(r)
}

/** The default piece name, "<source> · <n>". */
export const pieceName = (source: string, n: number): string => `${source} · ${n}`

/**
 * Every piece of `split` on the loaded source part, mapped; findings of the mapping. `port`
 * clips shapes (required: the layout intersects regions).
 */
export function planPieces(
  loaded: LoadedPart,
  split: SplitDTO,
  port: Region2dPort,
): AppResult<PiecesResult> {
  const where = 'planPieces'
  const input = toGeometryInput(loaded.part, loaded.stock, port)
  if (input.isErr()) return Err(input.unwrapErr().withContext(where))
  const geometry = input.unwrap().operations
  const numbers = splitNumbers(split)
  const stock = {
    length: loaded.stock.length.canonical,
    width: loaded.stock.width.canonical,
    thickness: loaded.stock.thickness.canonical,
  }
  const layout = splitLayout(port, numbers, stock, loaded.part.operations, geometry)
  if (layout.isErr()) return Err(layout.unwrapErr().withContext(where))
  const fb = regionBounds(layout.unwrap().footprint.region) ?? {
    min: [0, 0],
    max: [stock.length, stock.width],
  }
  const tools = operationTools(loaded.part.operations, loaded.snapshots ?? {})
  const findings = new Map<string, DfmWarning>()
  const c: Ctx = {
    loaded,
    port,
    geometry,
    table: SurfaceTable.build(loaded.part.operations, loaded.stock, loaded.part.shapes),
    T: stock.thickness,
    W: stock.width,
    split: numbers,
    units: loaded.units,
    footprintBounds: fb,
    toolDiameter: (op) =>
      tools[op.id]?.tool.diameter ?? (op.kind === 'profile' ? op.slotWidth.canonical : 6),
    finding: (op, key, message) => {
      if (!findings.has(key))
        findings.set(
          key,
          splitFinding(numbers.id, 'cutsFeature', 'warning', message, {
            operationId: op.id,
            reason: key.slice(0, key.indexOf(':')),
          }),
        )
    },
  }
  const L = layout.unwrap()
  const outlineAt = L.footprint.outline
  const outline =
    outlineAt === undefined
      ? undefined
      : (loaded.part.operations[outlineAt] as Extract<Operation, { kind: 'profile' }>)
  const outlineDto =
    outlineAt === undefined
      ? undefined
      : (loaded.dto.operations[outlineAt] as Extract<OperationDTO, { kind: 'profile' }>)
  const outlineGeometry =
    outlineAt === undefined
      ? undefined
      : (geometry[outlineAt] as Extract<OperationGeometry, { kind: 'profile' }>)
  const shapeMax = Math.max(
    0,
    ...(loaded.dto.shapes ?? []).map((s) => Number(s.id.slice('shape'.length))),
  )
  const pieces: PiecePlan[] = []
  for (const cell of L.cells) {
    const m = numbers.margin
    const bx0 = round(cell.bounds.min[0])
    const by0 = round(cell.bounds.min[1])
    const bx1 = round(cell.bounds.max[0])
    const by1 = round(cell.bounds.max[1])
    const blank = {
      length: round(bx1 - bx0 + 2 * m),
      width: round(by1 - by0 + 2 * m),
      thickness: round(cell.band.zt - cell.band.zb),
    }
    const offset = [round(m - bx0), round(m - by0), round(-cell.band.zt)] as const
    const b: PieceBuild = {
      ops: [],
      shapes: literal(loaded.dto.shapes ?? [], loaded.units),
      floors: new Map(),
      sameOn: new Set(),
      nextShape: shapeMax + 1,
    }
    for (let i = 0; i < loaded.part.operations.length; i++) {
      if (i === outlineAt) {
        const o = outlineOperation(c, cell, offset, b, outline, outlineDto, outlineGeometry)
        if (o.isErr()) return Err(o.unwrapErr())
        b.ops.push(o.unwrap())
        continue
      }
      const mapped = mapOperation(c, i, cell, offset, blank.width, b)
      if (mapped.isErr()) return Err(mapped.unwrapErr().withContext(where, { piece: cell.n }))
      if (mapped.unwrap() !== undefined) b.ops.push(mapped.unwrap()!)
    }
    if (outlineAt === undefined) {
      const o = outlineOperation(c, cell, offset, b, undefined, undefined, undefined)
      if (o.isErr()) return Err(o.unwrapErr())
      b.ops.push(o.unwrap())
    }
    // dowel holes (4b): drilled before the piece is cut free
    const dowels = dowelOperations(port, L, split, cell, offset, blank.width, (mm) =>
      lengthDTO(mm, loaded.units),
    )
    if (dowels.length > 0) {
      const at = b.ops.findIndex((o) => o.id === `${numbers.id}_outline`)
      b.ops.splice(at < 0 ? b.ops.length : at, 0, ...dowels)
    }
    pieces.push({
      n: cell.n,
      cell,
      blank,
      offset,
      name: pieceName(loaded.part.name, cell.n),
      operations: b.ops,
      shapes: b.shapes,
    })
  }
  return Ok({ layout: L, pieces, findings: [...findings.values()] })
}

/** The piece part record (without the id and stock, which the writer gives). */
export function pieceRecord(
  plan: PiecePlan,
  source: PartDTO,
  split: SplitDTO,
  units: UnitSystem,
): Omit<PartDTO, 'id' | 'stock'> {
  return {
    name: plan.name,
    ...(source.generalTolerance === undefined ? {} : { generalTolerance: source.generalTolerance }),
    ...(plan.shapes.length === 0 ? {} : { shapes: plan.shapes }),
    operations: plan.operations,
    derivedFrom: { partId: source.id, splitId: split.id, index: plan.n },
    offset: [
      lengthDTO(plan.offset[0], units),
      lengthDTO(plan.offset[1], units),
      lengthDTO(plan.offset[2], units),
    ],
  }
}

export { lengthDTO }
