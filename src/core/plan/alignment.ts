/**
 * Alignment phase 1 (hardening DF78), plan side: a setup's work zero (anywhere, negative X/Y
 * valid) and its alignment points – their expected positions in the setup frame and the WCS,
 * default names, the `plan.alignment` findings and the zero's words. Derived on every call
 * (memoized per loaded plan), never stored. Pure, headless.
 * Doc: docs/modes/alignment.md (Setup work zero, Alignment points, Validity, Implementation
 * (slice 1) S1–S7)
 */
import { holeCentres } from '../design/measure'
import { toGeometryInput } from '../design/geometry-input'
import { DIRECTION_LABEL, faceFrame, localStock, type StockSize } from '../geometry/face'
import type { Region2dPort } from '../geometry/2d/port'
import type { Loop } from '../geometry/2d/model'
import {
  applyPlacement,
  unapplyPlacement,
  type OperationGeometry,
  type PartGeometryInput,
  type Vec2,
  type Vec3,
} from '../geometry/model'
import { shapeOutline } from '../geometry/outline'
import { setupFrame } from '../toolpath/wcs'
import type { AlignmentPointDTO, AlignmentSourceDTO, SetupZeroDTO } from './alignment.dto'
import type { PlanWarning } from './checks'
import { planOperationLabel } from './labels'
import type { LoadedPlan } from './plan'
import type { SetupDTO } from './plan.dto'
import { setupCorner } from './setup-header'
import { setupDirection, setupRotation } from './setups'

/** Within this (mm) a point is on the up face or on the stock outline. */
const ON_EPS = 1e-6

export type AlignmentKind = 'point' | 'hole' | 'edge'

/** One alignment point as the plan sees it now. */
export interface AlignmentPosition {
  readonly id: string
  readonly name: string
  readonly kind: AlignmentKind
  readonly source: AlignmentSourceDTO
  /** Expected position in the setup frame (mm; Z 0 on the up face); absent = source missing. */
  readonly frame?: Vec3
  /** Expected X, Y in the setup's WCS (mm): `frame − zero`; absent = source missing. */
  readonly wcs?: Vec2
  /** The source operation runs in this setup or a later one (rule `notYetCut`). */
  readonly notYetCut: boolean
  /** The pointer cannot sight it from above (rule `notReachable`). */
  readonly reachable: boolean
}

/** A setup's zero and points. */
export interface SetupAlignment {
  readonly setupId: string
  /** The work zero in the setup frame (mm from the front-left corner of the up face). */
  readonly zero: Vec2
  /** The point the zero is on (`{ point }`), if any. */
  readonly zeroPoint?: string
  readonly points: readonly AlignmentPosition[]
}

const stockSize = (plan: Pick<LoadedPlan, 'stock'>): StockSize => ({
  length: plan.stock.length.canonical,
  width: plan.stock.width.canonical,
  thickness: plan.stock.thickness.canonical,
})

/** The setup frame without the zero (the front-left corner of the up face, as v0.2). */
const cornerFrame = (setup: SetupDTO, stock: StockSize) =>
  setupFrame(setupDirection(setup), setupRotation(setup), stock)

/** A stock corner or edge's words → its part-frame coordinate per axis (`undefined` = free). */
function stockCoords(words: readonly string[], s: StockSize): (number | undefined)[] {
  const out: (number | undefined)[] = [undefined, undefined, undefined]
  for (const w of words)
    if (w === 'left') out[0] = 0
    else if (w === 'right') out[0] = s.length
    else if (w === 'front') out[1] = 0
    else if (w === 'back') out[1] = s.width
    else if (w === 'top') out[2] = 0
    else if (w === 'bottom') out[2] = -s.thickness
  return out
}

const AXIS_RANGE = (s: StockSize): readonly (readonly [number, number])[] => [
  [0, s.length],
  [0, s.width],
  [-s.thickness, 0],
]

/** Outline end points of a loop or path in order, each once (a closed loop's start not twice). */
function loopVertices(loop: Loop, closed: boolean): Vec2[] {
  const out: Vec2[] = []
  for (const e of loop.elements) out.push([e.a[0], e.a[1]])
  const last = loop.elements.at(-1)
  if (!closed && last !== undefined) out.push([last.b[0], last.b[1]])
  return out.filter(
    (p, i) =>
      out.findIndex((q) => Math.abs(q[0] - p[0]) < 1e-9 && Math.abs(q[1] - p[1]) < 1e-9) === i,
  )
}

/** The vertices of a pocket's or profile's outline in its face frame, with their face Z. */
function operationVertices(g: OperationGeometry): { at: Vec2; z: number }[] {
  if (g.kind !== 'pocket' && g.kind !== 'profile') return []
  const o = shapeOutline(g.shape)
  const z = g.kind === 'pocket' ? g.onZ : 0
  const loops: { loop: Loop; closed: boolean }[] =
    o.kind === 'path'
      ? [{ loop: o.path, closed: false }]
      : o.region.pieces.flatMap((p) =>
          [p.outer, ...p.holes].map((loop) => ({ loop, closed: true })),
        )
  return loops.flatMap(({ loop, closed }) => loopVertices(loop, closed).map((at) => ({ at, z })))
}

/** Whether a hole of `g` goes through the stock along its axis. */
function holeThrough(g: OperationGeometry, input: PartGeometryInput): boolean {
  const t = localStock(g.direction ?? '+z', input.stock).thickness
  if (g.kind === 'drilling') return g.bottom.kind === 'through'
  if (g.kind === 'profile') return g.depth === undefined
  if (g.kind === 'pocket') return g.onZ - g.depth <= -t + ON_EPS
  return false
}

interface Located {
  readonly part?: Vec3
  /** A hole's axis (part frame) when it goes through; seen from either side. */
  readonly throughAxis?: Vec3
  readonly operationIndex?: number
}

const CAP = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)

/** The point's default name from its source (S1): "Top front-left corner", "Hole 2 of Drilling 3". */
export function defaultPointName(
  plan: Pick<LoadedPlan, 'dto'>,
  source: AlignmentSourceDTO,
): string {
  if ('corner' in source) {
    const [z, y, x] = source.corner.split(' ')
    return `${CAP(z!)} ${y}-${x} corner`
  }
  if ('edge' in source) return `${CAP(source.edge)} edge`
  const op = plan.dto.setups.flatMap((s) => s.operations).find((o) => o.id === source.operation)
  const label =
    op === undefined
      ? 'a removed operation'
      : planOperationLabel(plan.dto.design.part, op.designOperationIds)
  return 'hole' in source
    ? `Hole ${source.hole + 1} of ${label}`
    : `Corner ${source.vertex + 1} of ${label}`
}

const kindOf = (source: AlignmentSourceDTO): AlignmentKind =>
  'hole' in source ? 'hole' : 'edge' in source ? 'edge' : 'point'

const geometryMemo = new WeakMap<LoadedPlan, PartGeometryInput | null>()

function geometry(plan: LoadedPlan, port?: Region2dPort): PartGeometryInput | undefined {
  const hit = geometryMemo.get(plan)
  if (hit !== undefined) return hit ?? undefined
  const g = toGeometryInput(plan.part, plan.stock, port)
  const value = g.isOk() ? g.unwrap() : null
  geometryMemo.set(plan, value)
  return value ?? undefined
}

/** Where the source is in the part frame, or nothing when it is missing. */
function locate(plan: LoadedPlan, source: AlignmentSourceDTO, port?: Region2dPort): Located {
  const s = stockSize(plan)
  if ('corner' in source) {
    const c = stockCoords(source.corner.split(' '), s)
    return { part: [c[0]!, c[1]!, c[2]!] }
  }
  if ('edge' in source) {
    const c = stockCoords(source.edge.split(' '), s)
    const free = c.findIndex((v) => v === undefined)
    const [lo, hi] = AXIS_RANGE(s)[free]!
    c[free] = lo + (source.t ?? 0.5) * (hi - lo)
    return { part: [c[0]!, c[1]!, c[2]!] }
  }
  const operationIndex = plan.operations.findIndex((o) => o.id === source.operation)
  const op = plan.operations[operationIndex]
  if (op === undefined) return {}
  const input = geometry(plan, port)
  if (input === undefined) return { operationIndex }
  const ids = new Set(op.designOperationIds)
  const own = op.designOperationIds.flatMap((id) => input.operations.filter((g) => g.id === id))
  if ('hole' in source) {
    const holes = holeCentres({ ...input, operations: own })
    const hit = holes[source.hole]
    if (hit === undefined) return { operationIndex }
    const g = own.find((o) => o.id === hit.ref)
    const through = g !== undefined && ids.has(g.id) && holeThrough(g, input)
    return {
      part: hit.at,
      operationIndex,
      ...(through ? { throughAxis: frameOf(input, g).n } : {}),
    }
  }
  const vertices = own.flatMap((g) =>
    operationVertices(g).map((v) => applyPlacement(frameOf(input, g), [v.at[0], v.at[1], v.z])),
  )
  const v = vertices[source.vertex]
  return v === undefined ? { operationIndex } : { part: v, operationIndex }
}

/** The face frame an operation's positions are read in. */
const frameOf = (input: PartGeometryInput, g: OperationGeometry) =>
  faceFrame(g.direction ?? '+z', input.stock)

const memo = new WeakMap<LoadedPlan, Map<string, SetupAlignment>>()

/**
 * The setup's zero and its points' expected positions (setup frame and WCS), with the
 * `notYetCut` and reachability verdicts. A `{ point }` zero follows the point (S4); a missing one
 * leaves the zero at the corner.
 */
export function setupAlignment(
  plan: LoadedPlan,
  setup: SetupDTO,
  port?: Region2dPort,
): SetupAlignment {
  let bySetup = memo.get(plan)
  if (bySetup === undefined) memo.set(plan, (bySetup = new Map()))
  const hit = bySetup.get(setup.id)
  if (hit !== undefined) return hit
  const stock = stockSize(plan)
  const frame = cornerFrame(setup, stock)
  const local = localStock(setupDirection(setup), stock)
  const turned = setupRotation(setup) % 180 !== 0
  const [L, W] = turned ? [local.width, local.length] : [local.length, local.width]
  const first = plan.operations.findIndex((o) => setup.operations.some((x) => x.id === o.id))
  const firstIndex = first < 0 ? plan.operations.length : first
  const raw = (setup.alignment ?? []).map((p: AlignmentPointDTO) => {
    const at = locate(plan, p.source, port)
    let point = at.part === undefined ? undefined : unapplyPlacement(frame, at.part)
    // a hole seen through from the other side: its centre on the up face
    const along =
      at.throughAxis === undefined
        ? 0
        : Math.abs(
            at.throughAxis[0] * frame.n[0] +
              at.throughAxis[1] * frame.n[1] +
              at.throughAxis[2] * frame.n[2],
          )
    if (point !== undefined && along > 1 - 1e-9) point = [point[0], point[1], 0]
    const clean = (c: number) => (Math.abs(c) < 1e-9 ? 0 : c)
    if (point !== undefined) point = [clean(point[0]), clean(point[1]), clean(point[2])]
    const onTop = point !== undefined && Math.abs(point[2]) <= ON_EPS
    const onOutline =
      point !== undefined &&
      (Math.abs(point[0]) <= ON_EPS ||
        Math.abs(point[0] - L) <= ON_EPS ||
        Math.abs(point[1]) <= ON_EPS ||
        Math.abs(point[1] - W) <= ON_EPS)
    return {
      id: p.id,
      name: p.name ?? defaultPointName(plan, p.source),
      kind: kindOf(p.source),
      source: p.source,
      ...(point === undefined ? {} : { frame: point }),
      notYetCut: at.operationIndex !== undefined && at.operationIndex >= firstIndex,
      reachable: point === undefined || onTop || onOutline,
    }
  })
  const z: SetupZeroDTO | undefined = setup.zero
  let zero: Vec2 = [0, 0]
  let zeroPoint: string | undefined
  if (z !== undefined && 'at' in z) zero = [z.at[0], z.at[1]]
  else if (z !== undefined) {
    zeroPoint = z.point
    const p = raw.find((x) => x.id === z.point)?.frame
    if (p !== undefined) zero = [p[0], p[1]]
  }
  const points: AlignmentPosition[] = raw.map((p) =>
    p.frame === undefined
      ? p
      : { ...p, wcs: [p.frame[0] - zero[0] || 0, p.frame[1] - zero[1] || 0] as Vec2 },
  )
  const out: SetupAlignment = {
    setupId: setup.id,
    zero,
    ...(zeroPoint === undefined ? {} : { zeroPoint }),
    points,
  }
  bySetup.set(setup.id, out)
  return out
}

/** The setup's work zero in the setup frame (mm), `[0, 0]` = the front-left corner of the top. */
export const setupZero = (plan: LoadedPlan, setup: SetupDTO, port?: Region2dPort): Vec2 =>
  setup.zero === undefined ? [0, 0] : setupAlignment(plan, setup, port).zero

const fmt = (mm: number): string => String(Math.round(mm * 100) / 100 || 0)

/**
 * The `plan.alignment` findings of every setup (docs/modes/alignment.md#validity-already-cut-and-reachable):
 * errors `notYetCut`, `missingSource`, `notReachable`; warning `outsideTravel` (S6); info `none`
 * (S7). Always with `params.setupId`, per point `params.alignmentPointId`.
 */
export function alignmentFindings(plan: LoadedPlan, port?: Region2dPort): PlanWarning[] {
  const out: PlanWarning[] = []
  const first = plan.setups[0]!
  for (const [i, setup] of plan.setups.entries()) {
    const a = setupAlignment(plan, setup, port)
    const base = { code: 'plan.alignment' as const, field: 'alignment' }
    for (const p of a.points) {
      const params = { setupId: setup.id, alignmentPointId: p.id }
      if (p.frame === undefined)
        out.push({
          ...base,
          severity: 'error',
          rule: 'missingSource',
          message: `${p.name} in ${setup.name}: its source is gone (the operation was removed, or it has no such hole or corner); pick it again`,
          params,
        })
      else if (p.notYetCut)
        out.push({
          ...base,
          severity: 'error',
          rule: 'notYetCut',
          message: `${p.name} is not cut yet when ${setup.name} starts: cut it in an earlier setup or pick another point`,
          params,
        })
      else if (!p.reachable)
        out.push({
          ...base,
          severity: 'error',
          rule: 'notReachable',
          message: `${p.name} cannot be seen from above in ${setup.name}: pick a point on the up face, the stock's outline or a through hole`,
          params,
        })
    }
    const machine = plan.machine.isSome() ? plan.machine.unwrap() : undefined
    const placed = a.points.flatMap((p) => (p.wcs === undefined ? [] : [p.wcs]))
    if (machine !== undefined && placed.length > 0) {
      const xs = [0, ...placed.map((p) => p[0])]
      const ys = [0, ...placed.map((p) => p[1])]
      const dx = Math.max(...xs) - Math.min(...xs)
      const dy = Math.max(...ys) - Math.min(...ys)
      if (dx > machine.travel.x.canonical + ON_EPS || dy > machine.travel.y.canonical + ON_EPS)
        out.push({
          ...base,
          severity: 'warning',
          rule: 'outsideTravel',
          message: `The zero and alignment points of ${setup.name} span X ${fmt(dx)} × Y ${fmt(dy)} mm, more than the machine travel`,
          params: { setupId: setup.id, spanX: dx, spanY: dy },
        })
    }
    const sameOrientation =
      setupDirection(setup) === setupDirection(first) &&
      setupRotation(setup) === setupRotation(first)
    if (i > 0 && a.points.length === 0 && !sameOrientation)
      out.push({
        ...base,
        severity: 'info',
        rule: 'none',
        message: `${setup.name} is zeroed on ${setup.zero === undefined ? 'the stock corner' : 'its work zero'} only; add alignment points to check it against what ${first.name} cut.`,
        params: { setupId: setup.id },
      })
  }
  return out
}

/** The setup's own error findings (they block its export and `run.job.start`). */
export const setupAlignmentErrors = (
  plan: LoadedPlan,
  setupId: string,
  port?: Region2dPort,
): PlanWarning[] =>
  alignmentFindings(plan, port).filter(
    (f) => f.severity === 'error' && f.params['setupId'] === setupId,
  )

/**
 * The zero in words for the inspector and prompt (alignment.md § Setup work zero, Text): the
 * corner by its part faces, or the offset from it, or the point it is on. `fmtLen` formats mm in
 * the user's units.
 */
export function zeroWords(
  plan: LoadedPlan,
  setup: SetupDTO,
  fmtLen: (mm: number) => string = (mm) => `${fmt(mm)} mm`,
  port?: Region2dPort,
): string {
  const corner = setupCorner(setup, stockSize(plan))
  const face = `${DIRECTION_LABEL[setupDirection(setup)]} face`
  const a = setupAlignment(plan, setup, port)
  if (a.zeroPoint !== undefined) {
    const p = a.points.find((x) => x.id === a.zeroPoint)
    if (p !== undefined) return `on ${p.name}`
  }
  if (a.zero[0] === 0 && a.zero[1] === 0) return `${corner} corner of the ${face}`
  return `X ${fmtLen(a.zero[0])} Y ${fmtLen(a.zero[1])} from the ${corner} corner of the ${face}`
}
