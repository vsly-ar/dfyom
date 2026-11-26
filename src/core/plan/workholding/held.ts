/**
 * Held pieces and screws in the part (v0.4-llm-first W5): `plan.workholding.partLoose` (warning)
 * for a through profile that cuts a piece free in a setup whose items do not hold it, and
 * `plan.workholding.inPart` (warning) for a screw whose head meets the finished part. Static: no
 * toolpath needed. A setup without items keeps today's behaviour (`plan.workholding.none` only).
 * Doc: docs/modes/workholding.md#held-pieces-and-screws-in-the-part-w5
 *
 * Pure. Positions: the items are in the setup frame, the profiles' loops in the face frame of
 * their direction; the setup's turn (never its moved work zero) maps one onto the other.
 */
import { toGeometryInput } from '../../design/geometry-input'
import { localStock } from '../../geometry/face'
import { chainBounds, reverseLoop, signedArea, type Bounds2 } from '../../geometry/2d/model'
import { regionContains } from '../../geometry/2d/measure'
import type { Region2dPort } from '../../geometry/2d/port'
import type { OperationGeometry, PartGeometryInput, Vec2 } from '../../geometry/model'
import { profileChain, tabCentres } from '../../geometry/outline'
import { isThroughGeometry } from '../../geometry/through-depth'
import { faceWaste } from '../../geometry/waste'
import { fromWcs, toWcs, type SetupWcs } from '../../toolpath/wcs'
import type { PlanWarning } from '../checks'
import { planOpLabel } from '../labels'
import type { LoadedPlan } from '../plan'
import type { SetupDTO } from '../plan.dto'
import { setupDirection, setupRotation } from '../setups'
import type { ResolvedItem } from './items'
import { setupWorkholding, type SetupWorkholding } from './setup'

type Profile = Extract<OperationGeometry, { kind: 'profile' }>

/** Slack for "the loop reaches the stock edge" (mm). */
const EDGE = 1e-6

const memo = new WeakMap<LoadedPlan, Map<Region2dPort | undefined, PartGeometryInput | null>>()

/** The plan's part as geometry input (memoised per plan and port; null when it does not map). */
function geometry(plan: LoadedPlan, port: Region2dPort | undefined): PartGeometryInput | null {
  let byPort = memo.get(plan)
  if (byPort === undefined) memo.set(plan, (byPort = new Map()))
  if (!byPort.has(port))
    byPort.set(
      port,
      toGeometryInput(plan.part, plan.stock, port).mapOr(null, (g) => g),
    )
  return byPort.get(port) ?? null
}

/** The setup's turn of its face frame (no zero: items are entered in the setup frame). */
function turnOf(setup: SetupDTO, input: PartGeometryInput): SetupWcs {
  const face = localStock(setupDirection(setup), {
    length: input.stock.length,
    width: input.stock.width,
    thickness: input.stock.thickness,
  })
  return { rotation: setupRotation(setup), size: [face.length, face.width] }
}

/** A profile holds nothing by tabs: no tab centres, or tabs without thickness. */
const noTabs = (p: Profile): boolean =>
  !(p.tabs.thickness > 0) ||
  tabCentres(1, {
    count: p.tabs.count,
    ...(p.tabs.positions === undefined ? {} : { positions: p.tabs.positions }),
  }).length === 0

/** Face-frame bounds in the setup frame (the turn maps boxes to boxes). */
function turnedBounds(b: Bounds2, wcs: SetupWcs): Bounds2 {
  const a = toWcs(b.min, wcs)
  const c = toWcs(b.max, wcs)
  return {
    min: [Math.min(a[0], c[0]), Math.min(a[1], c[1])],
    max: [Math.max(a[0], c[0]), Math.max(a[1], c[1])],
  }
}

/** The spans overlap with positive length. */
const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean =>
  Math.min(a1, b1) - Math.max(a0, b0) > EDGE

/**
 * Whether an item holds a piece cut free along `loop` (face frame; `box` its bounds in the setup
 * frame): a screw whose centre is inside the piece; a toe clamp whose grip lies on the piece where
 * the loop runs off the clamped edge; a vise whose jaws both touch the piece (the loop runs off
 * both gripped sides). Blocks, the base and a surface are not counted here (a surface holds every
 * piece and is checked first).
 */
function holds(
  item: ResolvedItem,
  piece: { readonly region: Parameters<typeof regionContains>[0]; readonly box: Bounds2 },
  h: SetupWorkholding,
  wcs: SetupWcs,
): boolean {
  const { min, max } = piece.box
  const { length: L, width: W } = h.stock
  switch (item.kind) {
    case 'screw':
      return regionContains(piece.region, fromWcs([item.center[0], item.center[1]], wcs))
    case 'toeClamp': {
      const a = item.at - item.width / 2
      const b = item.at + item.width / 2
      switch (item.edge) {
        case 'vMin':
          return min[1] <= EDGE && overlaps(a, b, min[0], max[0])
        case 'vMax':
          return max[1] >= W - EDGE && overlaps(a, b, min[0], max[0])
        case 'uMin':
          return min[0] <= EDGE && overlaps(a, b, min[1], max[1])
        case 'uMax':
          return max[0] >= L - EDGE && overlaps(a, b, min[1], max[1])
      }
      return false
    }
    case 'vise': {
      const half = item.jawLength / 2
      if (item.axis === 'u')
        return (
          min[0] <= EDGE &&
          max[0] >= L - EDGE &&
          overlaps(W / 2 - half, W / 2 + half, min[1], max[1])
        )
      return (
        min[1] <= EDGE && max[1] >= W - EDGE && overlaps(L / 2 - half, L / 2 + half, min[0], max[0])
      )
    }
    default:
      return false
  }
}

const PIECE_WORD = { outside: 'the part', inside: 'the slug', on: 'the piece inside it' } as const

/**
 * `plan.workholding.partLoose`: per setup with items but no `surface` hold, every through profile
 * of a closed loop without tabs whose piece (the part inside an outside profile, the slug inside
 * an inside one, the inside of a closed `on` cut) no screw, toe clamp or vise holds.
 */
function partLoose(
  plan: LoadedPlan,
  setup: SetupDTO,
  h: SetupWorkholding,
  input: PartGeometryInput,
): PlanWarning[] {
  if (h.items.some((i) => i.kind === 'surface')) return []
  const out: PlanWarning[] = []
  const byId = new Map(input.operations.map((o) => [o.id, o]))
  const wcs = turnOf(setup, input)
  for (const op of setup.operations)
    for (const id of op.designOperationIds) {
      const g = byId.get(id)
      if (g === undefined || !isThroughGeometry(g) || !noTabs(g)) continue
      if ((g.direction ?? '+z') !== setupDirection(setup)) continue
      const { chain, closed } = profileChain(g)
      const bounds = chainBounds(chain.elements)
      if (!closed || bounds === undefined) continue
      const piece = {
        // counter-clockwise, as an outer loop (`faceWaste` does the same)
        region: {
          pieces: [{ outer: signedArea(chain) < 0 ? reverseLoop(chain) : chain, holes: [] }],
        },
        box: turnedBounds(bounds, wcs),
      }
      if (h.items.some((i) => holds(i, piece, h, wcs))) continue
      const name = planOpLabel(plan.dto.design.part, op)
      const what = PIECE_WORD[g.side]
      out.push({
        code: 'plan.workholding.partLoose',
        severity: 'warning',
        message: `${name} cuts ${what} free in ${setup.name} without tabs and nothing in the workholding holds it: add tabs, a screw inside it, or a tape, vacuum or glue hold`,
        planOperationId: op.id,
        rule: 'partLoose',
        params: { setupId: setup.id, profile: id, side: g.side },
      })
    }
  return out
}

/**
 * `plan.workholding.inPart`: a screw whose head (its circle in the setup frame) is not wholly in
 * the waste of the setup's face (`faceWaste`: outside every outside through profile, inside an
 * inside one's slug) and not wholly off the stock: it would leave a hole in the part.
 */
function inPart(setup: SetupDTO, h: SetupWorkholding, input: PartGeometryInput): PlanWarning[] {
  const screws = h.items.filter((i) => i.kind === 'screw')
  if (screws.length === 0) return []
  const wcs = turnOf(setup, input)
  const waste = faceWaste(input.operations, setupDirection(setup), input.stock)
  const [L, W] = wcs.size
  const out: PlanWarning[] = []
  for (const s of screws) {
    const r = s.headDiameter / 2
    const c: Vec2 = fromWcs([s.center[0], s.center[1]], wcs)
    const offStock = c[0] + r <= 0 || c[1] + r <= 0 || c[0] - r >= L || c[1] - r >= W
    if (offStock || (waste !== undefined && waste.covers(c, r))) continue
    out.push({
      code: 'plan.workholding.inPart',
      severity: 'warning',
      message: `${s.name} in ${setup.name} goes through the part: it would leave a hole in it; move it into the waste`,
      rule: 'inPart',
      params: { setupId: setup.id, itemId: s.id },
    })
  }
  return out
}

/**
 * The held-piece findings of the plan (or one setup): `inPart` and `partLoose`. Without the 2D
 * port, a part with general shapes may not map; it then has none.
 */
export function heldFindings(
  plan: LoadedPlan,
  setupId?: string,
  port?: Region2dPort,
): PlanWarning[] {
  const setups = plan.setups.filter(
    (s) => (setupId === undefined || s.id === setupId) && (s.workholding ?? []).length > 0,
  )
  if (setups.length === 0) return []
  const input = geometry(plan, port)
  if (input === null) return []
  return setups.flatMap((s) => {
    const h = setupWorkholding(s, plan.stock)
    return [...inPart(s, h, input), ...partLoose(plan, s, h, input)]
  })
}
