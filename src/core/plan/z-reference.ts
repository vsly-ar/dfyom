/**
 * Z reference surface and touch-off spot per tool run (hardening DF69): for every tool run of
 * every setup the eligible surfaces (flat, facing up, existing when the tool starts, with a flat
 * patch for a spot), the default rule (the up face, else the last facing floor, else the largest
 * patch with a warning, else an error), a stored choice (`zRef` on the run's first operation) and
 * the `plan.zRef` findings. Derived on every call (memoized per loaded plan), never stored.
 * Doc: docs/modes/z-reference.md
 */
import { STOCK_FACE, type Direction } from '../geometry/face'
import type { Region2dPort } from '../geometry/2d/port'
import { regionArea } from '../geometry/2d/model'
import {
  erodedPatch,
  FlatPatches,
  patchPolygons,
  spotFits,
  touchOffSpot,
  type FlatSurface,
  type PatchPolygon,
  type SpotFrame,
} from '../geometry/flat-patch'
import type { OperationGeometry, Vec2 } from '../geometry/model'
import { toGeometryInput } from '../design/geometry-input'
import { DIRECTION_LABEL } from '../geometry/face'
import { setupWcs, toWcs, fromWcs } from '../toolpath/wcs'
import { setupZero } from './alignment'
import type { PlanWarning } from './checks'
import { planOperationLabel } from './labels'
import type { LoadedPlan } from './plan'
import type { PlanOperationDTO } from './plan.dto'
import { setupDirection, setupRotation } from './setups'
import { toolRuns } from './tool-runs'
import { asCutRemovals } from './as-cut'
import { cutTest } from './cut'

/** Touch-off clearance past the tool or plate (mm). */
export const SPOT_MARGIN = 1
/** Spot grid: 1 mm, or 0.05 in for inch programs (mm). */
const GRID_MM = 1
const GRID_IN = 1.27

/** One eligible surface of a tool run, with its default spot. */
export interface ZRefCandidate {
  /** Surface id: the setup's stock face or `<design operation id>.floor`. */
  readonly surface: string
  /** "Top face", "Facing 1 floor". */
  readonly label: string
  /** z in the setup frame (mm, ≤ 0): the program shifts the run's Z by −level. */
  readonly level: number
  /** Default touch-off spot, setup WCS (mm). */
  readonly at: Vec2
  /** Flat patch area (mm²). */
  readonly area: number
  /** The patch fits the tool but not the touch plate (`probePlateSize`). */
  readonly small: boolean
  /** The setup's up face (stock face of its direction). */
  readonly top: boolean
}

/** How the run's reference was found. */
export type ZRefRule = 'top' | 'facing' | 'largest' | 'chosen'

export interface ZRef extends ZRefCandidate {
  /** Stored by the user (surface or spot). */
  readonly chosen: boolean
  readonly rule: ZRefRule
}

export interface ToolRunZRef {
  readonly setupId: string
  /** The run's first plan operation (where a choice is stored). */
  readonly planOperationId: string
  /** Index of the run in its setup. */
  readonly run: number
  /** Tool number in the setup's program (by first use), 0 without a tool. */
  readonly toolNumber: number
  /** The reference; undefined when none applies (an error finding says why). */
  readonly zRef: ZRef | undefined
  /** Every eligible surface, the up face first, then in machining order. */
  readonly candidates: readonly ZRefCandidate[]
  readonly findings: readonly PlanWarning[]
  /** The reference drawn in the viewport (undefined without a reference). */
  readonly outline?: ZRefOutline | undefined
}

/**
 * The run's reference for the viewport (DF69): its flat patch and the area the touch-off spot may
 * lie in (the patch eroded by the clearance radius), in the setup WCS.
 * Doc: docs/modes/z-reference.md#implementation-notes-df69
 */
export interface ZRefOutline {
  readonly patch: readonly PatchPolygon[]
  readonly spotArea: readonly PatchPolygon[]
  /** Clearance radius around the spot (mm): room for the tool or the plate. */
  readonly clearance: number
  /** The spot grid (mm): 1, or 1.27 on inch machines. */
  readonly grid: number
}

const memo = new WeakMap<LoadedPlan, Map<Region2dPort, readonly ToolRunZRef[]>>()

/**
 * The Z reference of every tool run of the plan, in machining order. Needs the 2D port (flat
 * patches are region booleans): without it, or when the part's geometry does not evaluate, none.
 */
export function planZReferences(plan: LoadedPlan, port?: Region2dPort): readonly ToolRunZRef[] {
  if (port === undefined) return []
  let byPort = memo.get(plan)
  if (byPort === undefined) memo.set(plan, (byPort = new Map()))
  let out = byPort.get(port)
  if (out === undefined) {
    out = compute(plan, port)
    byPort.set(port, out)
  }
  return out
}

/** The `plan.zRef` findings of every tool run, plus `inert` for stored choices off a run start. */
export function zRefFindings(plan: LoadedPlan, port?: Region2dPort): PlanWarning[] {
  return planZReferences(plan, port).flatMap((r) => r.findings)
}

/** The Z references of one setup's tool runs, by the run's first plan operation id. */
export function setupZReferences(
  plan: LoadedPlan,
  setupId: string,
  port?: Region2dPort,
): ReadonlyMap<string, ToolRunZRef> {
  return new Map(
    planZReferences(plan, port)
      .filter((r) => r.setupId === setupId)
      .map((r) => [r.planOperationId, r]),
  )
}

/** Whether `surface` names a surface the part could have (stock face or an operation's floor). */
export function knownSurfaceId(plan: LoadedPlan, surface: string): boolean {
  if (Object.values(STOCK_FACE).includes(surface)) return true
  const m = /^(.+)\.floor$/.exec(surface)
  return m !== null && plan.part.operations.some((o) => o.id === m[1])
}

function compute(plan: LoadedPlan, port: Region2dPort): ToolRunZRef[] {
  const input = toGeometryInput(plan.part, plan.stock, port)
  if (input.isErr()) return []
  const { operations, stock } = input.unwrap()
  const byId = new Map<string, OperationGeometry>(operations.map((g) => [g.id, g]))
  const patches = new FlatPatches(
    stock,
    port,
    plan.setups.map((s) => setupDirection(s)),
  )
  const grid = plan.machine.mapOr(GRID_MM, (m) => (m.programUnits === 'in' ? GRID_IN : GRID_MM))
  const plate = plan.machine.mapOr(0, (m) => m.probePlateSize.mapOr(0, (q) => q.canonical))
  // the plan operation that cut each floor, and its machining index
  const cutBy = new Map<string, { op: PlanOperationDTO; index: number; flat: boolean }>()
  let index = 0
  // DF135: a cut operation has run before (docs/modes/cut-state.md#setups-and-work-zero)
  let afterCut = false
  const isCut = cutTest(plan.dto.design.part)
  // DF135 C4: a recut unit's as-cut removal is gone before its first plan operation; its floor is
  // no touch-off surface (the tool that cut it is not known here)
  // (docs/modes/cut-state.md#cutting-only-the-difference-c4)
  const removals = asCutRemovals(plan, port)
  const out: ToolRunZRef[] = []
  for (const setup of plan.setups) {
    const direction = setupDirection(setup)
    const wcs = setupWcs(direction, setupRotation(setup), stock, setupZero(plan, setup, port))
    const frame: SpotFrame =
      wcs === undefined
        ? { toWcs: (p) => p, fromWcs: (p) => p }
        : { toWcs: (p) => toWcs(p, wcs), fromWcs: (p) => fromWcs(p, wcs) }
    const numbers = new Map<string, number>()
    const runs = toolRuns(setup.operations, isCut)
    const starts = new Map(runs.map((r, i) => [r.start, i]))
    setup.operations.forEach((op, i) => {
      for (const r of removals)
        if (r.index === index) {
          patches.apply(r.geometry, false)
          afterCut = true
        }
      const run = starts.get(i)
      if (run !== undefined) {
        const tool = op.tool === undefined ? undefined : plan.tools.get(op.tool)
        let toolNumber = 0
        if (op.tool !== undefined) {
          toolNumber = numbers.get(op.tool) ?? numbers.size + 1
          numbers.set(op.tool, toolNumber)
        }
        out.push(
          runReference({
            plan,
            port,
            setupId: setup.id,
            direction,
            op,
            run,
            toolNumber,
            toolRadius: tool === undefined ? 0 : tool.diameter.canonical / 2,
            plate,
            grid,
            frame,
            surfaces: patches.of(direction),
            cutBy,
            index,
            byId,
            afterCut,
          }),
        )
      } else if (op.zRef !== undefined)
        out.push({
          setupId: setup.id,
          planOperationId: op.id,
          run: -1,
          toolNumber: 0,
          zRef: undefined,
          candidates: [],
          findings: [
            {
              code: 'plan.zRef',
              severity: 'info',
              message:
                'the stored Z reference is ignored: this operation no longer starts a tool run',
              planOperationId: op.id,
              field: 'zRef',
              rule: 'inert',
              params: { setupId: setup.id },
            },
          ],
        })
      const tool = op.tool === undefined ? undefined : plan.tools.get(op.tool)
      const flatTool = tool?.type === 'flatEndMill'
      for (const id of op.designOperationIds) {
        const g = byId.get(id)
        if (g === undefined) continue
        const flat = flatTool && (g.kind !== 'profile' || g.depth !== undefined)
        patches.apply(g, flat)
        cutBy.set(id, { op, index, flat })
      }
      if (isCut(op)) afterCut = true
      index++
    })
  }
  return out
}

interface RunInput {
  readonly plan: LoadedPlan
  readonly port: Region2dPort
  readonly setupId: string
  readonly direction: Direction
  readonly op: PlanOperationDTO
  readonly run: number
  readonly toolNumber: number
  readonly toolRadius: number
  readonly plate: number
  readonly grid: number
  readonly frame: SpotFrame
  readonly surfaces: readonly FlatSurface[]
  readonly cutBy: ReadonlyMap<string, { op: PlanOperationDTO; index: number; flat: boolean }>
  readonly index: number
  readonly byId: ReadonlyMap<string, OperationGeometry>
  /** An already-cut operation comes before the run (DF135). */
  readonly afterCut: boolean
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function surfaceLabel(plan: LoadedPlan, s: { owner: string | undefined; direction: Direction }) {
  return s.owner === undefined
    ? `${capital(DIRECTION_LABEL[s.direction])} face`
    : `${planOperationLabel(plan.dto.design.part, [s.owner])} floor`
}

/** "the top face" / "Facing 1 floor": a label as program and messages write it. */
export function zRefText(z: Pick<ZRefCandidate, 'label' | 'top'>): string {
  return z.top ? `the ${z.label.toLowerCase()}` : z.label
}

function runReference(r: RunInput): ToolRunZRef {
  const { plan, port, frame } = r
  const full = Math.max(r.toolRadius, r.plate / 2) + SPOT_MARGIN
  const bare = r.toolRadius + SPOT_MARGIN
  const top = STOCK_FACE[r.direction]
  const candidates: ZRefCandidate[] = []
  const patchOf = new Map<string, FlatSurface>()
  for (const s of r.surfaces) {
    let spot = touchOffSpot(port, s.patch, full, r.grid, frame)
    let small = false
    if (spot === undefined && full > bare) {
      spot = touchOffSpot(port, s.patch, bare, r.grid, frame)
      small = spot !== undefined
    }
    if (spot === undefined) continue
    patchOf.set(s.id, s)
    candidates.push({
      surface: s.id,
      label: surfaceLabel(plan, s),
      level: s.level,
      at: spot.at,
      area: regionArea(s.patch),
      small,
      top: s.id === top,
    })
  }
  const findings: PlanWarning[] = []
  const base = {
    code: 'plan.zRef' as const,
    planOperationId: r.op.id,
    field: 'zRef',
  }
  const toolName = r.toolNumber > 0 ? `tool ${r.toolNumber}` : 'the tool'
  const candidateParams = (): Record<string, string> => {
    const list = candidates
      .slice(0, 5)
      .map((c) => `${c.surface} ${c.at[0]},${c.at[1]}`)
      .join('; ')
    return list === '' ? {} : { candidates: list }
  }
  const finding = (
    severity: PlanWarning['severity'],
    rule: string,
    message: string,
    params: Record<string, string | number> = {},
    fix?: ZRefCandidate,
    code?: PlanWarning['code'],
  ) =>
    findings.push({
      ...base,
      ...(code === undefined ? {} : { code }),
      severity,
      rule,
      message,
      params: {
        setupId: r.setupId,
        ...params,
        ...(fix === undefined
          ? {}
          : { fixSurface: fix.surface, fixAt: `${fix.at[0]},${fix.at[1]}` }),
        ...candidateParams(),
      },
    })

  // the default rule (docs/modes/z-reference.md#default-rule)
  let byDefault: ZRef | undefined
  const up = candidates.find((c) => c.top)
  if (up !== undefined) byDefault = { ...up, chosen: false, rule: 'top' }
  else {
    let facing: ZRefCandidate | undefined
    let latest = -1
    for (const c of candidates) {
      const owner = patchOf.get(c.surface)?.owner
      const g = owner === undefined ? undefined : r.byId.get(owner)
      const at = owner === undefined ? undefined : r.cutBy.get(owner)
      if (g?.kind === 'facing' && at !== undefined && at.index > latest) {
        latest = at.index
        facing = c
      }
    }
    if (facing !== undefined) byDefault = { ...facing, chosen: false, rule: 'facing' }
    else {
      const largest = [...candidates].sort((a, b) => b.area - a.area)[0]
      if (largest !== undefined) byDefault = { ...largest, chosen: false, rule: 'largest' }
    }
  }

  const stored = r.op.zRef
  let zRef: ZRef | undefined = byDefault
  if (stored?.surface !== undefined) {
    const c = candidates.find((x) => x.surface === stored.surface)
    if (c !== undefined) zRef = { ...c, chosen: true, rule: 'chosen' }
    else {
      zRef = undefined
      const why = unavailable(r, stored.surface)
      // DF135: the surface was there when the plan was cut but cut operations removed it
      // (`plan.zRefGone`, docs/modes/cut-state.md#setups-and-work-zero)
      const gone = why.rule === 'cutAway' && r.afterCut
      finding(
        'error',
        gone ? 'zRefGone' : why.rule,
        gone
          ? `${why.message}: the operations already cut removed it; touch off on a surface that still exists`
          : why.message,
        { surface: stored.surface },
        byDefault,
        gone ? 'plan.zRefGone' : undefined,
      )
    }
  }
  if (zRef !== undefined && stored?.at !== undefined) {
    const s = patchOf.get(zRef.surface)
    const fits =
      s !== undefined &&
      (spotFits(port, s.patch, zRef.small ? bare : full, stored.at, frame) ||
        (!zRef.small && spotFits(port, s.patch, bare, stored.at, frame)))
    zRef = { ...zRef, at: [stored.at[0], stored.at[1]], chosen: true, rule: 'chosen' }
    if (!fits)
      finding(
        'error',
        'spotNotFlat',
        `the touch-off spot X${stored.at[0]} Y${stored.at[1]} is not on a flat part of ${zRefText(zRef)} with room for ${toolName}`,
        { surface: zRef.surface },
        byDefault,
      )
  }
  if (zRef === undefined && stored?.surface === undefined)
    finding(
      'error',
      'none',
      `no flat, upward surface is left for ${toolName} to touch off Z on: choose one`,
    )
  if (zRef !== undefined && !zRef.chosen && zRef.rule === 'largest')
    finding(
      'warning',
      'chosen',
      `${capital(toolName)} touches off on ${zRefText(zRef)}; check it`,
      { surface: zRef.surface },
    )
  if (zRef?.small === true)
    finding(
      'info',
      'small',
      `${zRefText(zRef)} has room for ${toolName} but not for the touch plate: touch off by hand (paper or feeler), or choose another surface`,
      { surface: zRef.surface },
    )
  let outline: ZRefOutline | undefined
  const drawn = zRef === undefined ? undefined : patchOf.get(zRef.surface)
  if (zRef !== undefined && drawn !== undefined) {
    const clearance = zRef.small ? bare : full
    const area = erodedPatch(port, drawn.patch, clearance)
    outline = {
      patch: patchPolygons(drawn.patch, frame),
      spotArea: area === undefined ? [] : patchPolygons(area, frame),
      clearance,
      grid: r.grid,
    }
  }
  return {
    setupId: r.setupId,
    planOperationId: r.op.id,
    run: r.run,
    toolNumber: r.toolNumber,
    zRef,
    candidates,
    findings,
    outline,
  }
}

/** Why a stored surface is not eligible for the run: `missing`, `notFlat`, `notYetCut`, `cutAway`. */
function unavailable(r: RunInput, surface: string): { rule: string; message: string } {
  const stockFace = Object.entries(STOCK_FACE).find(([, id]) => id === surface)
  if (stockFace !== undefined) {
    if (stockFace[0] !== r.direction)
      return { rule: 'notFlat', message: `${surface} does not face up in this setup` }
    return {
      rule: 'cutAway',
      message: `${surface} is cut away before this tool starts (no flat patch left for a touch-off spot)`,
    }
  }
  const m = /^(.+)\.floor$/.exec(surface)
  const owner = m?.[1]
  const g = owner === undefined ? undefined : r.byId.get(owner)
  if (owner === undefined || g === undefined)
    return { rule: 'missing', message: `the Z reference surface ${surface} no longer exists` }
  const label = `${planOperationLabel(r.plan.dto.design.part, [owner])} floor`
  const kindOk =
    g.kind === 'facing' || g.kind === 'pocket' || (g.kind === 'profile' && g.depth !== undefined)
  if (!kindOk || (g.direction ?? '+z') !== r.direction)
    return { rule: 'notFlat', message: `${label} is not a flat surface facing up in this setup` }
  const cut = r.cutBy.get(owner)
  if (cut === undefined)
    return {
      rule: 'notYetCut',
      message: `${label} is cut after this tool starts: it does not exist yet`,
    }
  if (!cut.flat) return { rule: 'notFlat', message: `${label} is not cut flat (no flat end mill)` }
  return {
    rule: 'cutAway',
    message: `${label} is cut away before this tool starts (no flat patch left for a touch-off spot)`,
  }
}
