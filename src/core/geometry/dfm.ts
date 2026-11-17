/**
 * Parameter and tool DFM checks: synchronous, pure and total, run by the design commands on
 * every change (the geometry checks run in the evaluation, `checks.ts`).
 * Doc: docs/modes/design.md#dfm-checks (rules per operation in its DFM-warnings columns),
 * docs/architecture/geometry.md#evaluation-checks
 *
 * Inputs are the resolved float64 mm of `PartGeometryInput` plus the tool library reduced to
 * the fields the rules need. With an empty library only the geometric rules run.
 */
import type { ToolType } from '../library/tool.dto'
import {
  EPSILON,
  type DfmSuggestion,
  type DfmWarning,
  type DfmWarningCode,
  type OperationGeometry,
  type PartGeometryInput,
  type StockGeometry,
} from './model'
import { inradius, slotCoversOpening } from './operations'

/** A library tool as the DFM rules see it (mm). */
export interface DfmTool {
  readonly type: ToolType
  readonly diameter: number
  /** Bull-nose corner radius (RE); flat = 0 and ball = diameter / 2 are derived. */
  readonly cornerRadius?: number
}

export interface ParameterCheckOptions {
  /** The whole tool library, not a chosen machine. */
  readonly tools: readonly DfmTool[]
  /** Picks the thresholds that differ per unit system (facing: 3 mm / 1/8″). */
  readonly unitSystem: 'metric' | 'inch'
}

/** A tool matches a nominal size within this (mm): a drill's diameter, a bull-nose radius. */
export const TOOL_MATCH_TOLERANCE = 0.01

const FACING_DEEP = { metric: 3, inch: 25.4 / 8 } as const
const POCKET_DEPTH_RATIO = 4
const HOLE_DEPTH_RATIO = 5

type Op<K extends OperationGeometry['kind']> = Extract<OperationGeometry, { kind: K }>

/** Formats mm for messages (≤ 3 decimals, no trailing zeros). */
const mm = (v: number): string => `${Number(v.toFixed(3))} mm`
const atLeast = (value: number): DfmSuggestion => ({ relation: 'atLeast', value })
const atMost = (value: number): DfmSuggestion => ({ relation: 'atMost', value })

function warning(
  code: DfmWarningCode,
  op: OperationGeometry,
  parameter: string,
  message: string,
  params: DfmWarning['params'],
  extra: { severity?: DfmWarning['severity']; suggestion?: DfmSuggestion } = {},
): DfmWarning {
  return {
    code,
    severity: extra.severity ?? 'warning',
    message: `${op.id}: ${message}`,
    operation: op.id,
    parameter,
    params,
    ...(extra.suggestion !== undefined && { suggestion: extra.suggestion }),
  }
}

/** Library facts the rules need. */
interface Library {
  readonly empty: boolean
  /** Smallest end-mill diameter (flat, bull-nose, ball); undefined without end mills. */
  readonly minEndMill: number | undefined
  readonly tools: readonly DfmTool[]
}

function library(tools: readonly DfmTool[]): Library {
  const endMills = tools.filter((t) => t.type !== 'drill').map((t) => t.diameter)
  return {
    empty: tools.length === 0,
    minEndMill: endMills.length === 0 ? undefined : Math.min(...endMills),
    tools,
  }
}

/** Every parameter and tool warning of the part, in operation order. */
export function parameterChecks(
  input: PartGeometryInput,
  options: ParameterCheckOptions,
): DfmWarning[] {
  const lib = library(options.tools)
  return input.operations.flatMap((op): DfmWarning[] => {
    switch (op.kind) {
      case 'facing':
        return facing(op, options.unitSystem)
      case 'pocket':
        return pocket(op, lib)
      case 'drilling':
        return drilling(op, input.stock, lib)
      case 'profile':
        return profile(op, input.stock, lib)
    }
  })
}

function facing(op: Op<'facing'>, unitSystem: 'metric' | 'inch'): DfmWarning[] {
  const limit = FACING_DEEP[unitSystem]
  if (op.depth <= limit + EPSILON) return []
  return [
    warning(
      'dfm.facingDeep',
      op,
      'depth',
      `facing depth ${mm(op.depth)} removes a lot of material – check the stock thickness`,
      { depth: op.depth, limit },
      { severity: 'info', suggestion: atMost(limit) },
    ),
  ]
}

/** Narrowest size of a contour: the circle's diameter, the rectangle's shorter side. */
const narrowest = (op: Op<'pocket'> | Op<'profile'>): number => 2 * inradius(op.shape.contour)

/** Inside corners (pocket, inside profile): r = 0 always warns; r below the smallest tool radius. */
function corners(op: Op<'pocket'> | Op<'profile'>, lib: Library): DfmWarning[] {
  const c = op.shape.contour
  if (c.kind !== 'rectangle') return []
  const min = lib.minEndMill === undefined ? undefined : lib.minEndMill / 2
  const suggestion = min === undefined ? undefined : atLeast(min)
  if (c.cornerRadius <= EPSILON)
    return [
      warning(
        'dfm.cornerSharp',
        op,
        'shape.cornerRadius',
        'a sharp inside corner cannot be cut by a round tool' +
          (min === undefined ? '' : ` – use cornerRadius ≥ ${mm(min)}`),
        { cornerRadius: c.cornerRadius },
        suggestion === undefined ? {} : { suggestion },
      ),
    ]
  if (min !== undefined && c.cornerRadius < min - EPSILON)
    return [
      warning(
        'dfm.cornerTooSmall',
        op,
        'shape.cornerRadius',
        `no tool can make this corner: the smallest end mill has radius ${mm(min)} – ` +
          `use cornerRadius ≥ ${mm(min)}`,
        { cornerRadius: c.cornerRadius, toolRadius: min },
        { suggestion: atLeast(min) },
      ),
    ]
  return []
}

function pocket(op: Op<'pocket'>, lib: Library): DfmWarning[] {
  const out: DfmWarning[] = []
  const size = narrowest(op)
  if (lib.minEndMill !== undefined && size < lib.minEndMill - EPSILON)
    out.push(
      warning(
        'dfm.pocketNoToolFits',
        op,
        'shape',
        `no tool fits: the pocket is ${mm(size)} at its narrowest, the smallest end mill ` +
          `${mm(lib.minEndMill)}`,
        { narrowest: size, toolDiameter: lib.minEndMill },
        { suggestion: atLeast(lib.minEndMill) },
      ),
    )
  const deepest = POCKET_DEPTH_RATIO * size
  if (op.depth > deepest + EPSILON)
    out.push(
      warning(
        'dfm.pocketDeepNarrow',
        op,
        'depth',
        `deep, narrow pocket (depth ${mm(op.depth)} > ${POCKET_DEPTH_RATIO} × ${mm(size)}) – ` +
          'needs a long tool',
        { depth: op.depth, narrowest: size },
        { suggestion: atMost(deepest) },
      ),
    )
  out.push(...corners(op, lib))
  const f = op.floorRadius
  if (f > EPSILON && !lib.empty) {
    const bullNose = lib.tools.some(
      (t) =>
        t.type === 'bullNoseEndMill' &&
        t.cornerRadius !== undefined &&
        Math.abs(t.cornerRadius - f) <= TOOL_MATCH_TOLERANCE,
    )
    const balls = lib.tools.filter((t) => t.type === 'ballEndMill').map((t) => t.diameter / 2)
    const ball = balls.some((r) => r <= f + TOOL_MATCH_TOLERANCE)
    if (!bullNose && !ball) {
      const smallestBall = balls.length === 0 ? undefined : Math.min(...balls)
      out.push(
        warning(
          'dfm.floorRadiusNoTool',
          op,
          'floorRadius',
          `no bull-nose end mill with corner radius ${mm(f)} and no ball end mill with radius ≤ ` +
            `${mm(f)} in the library` +
            (smallestBall === undefined ? '' : ` – use floorRadius ≥ ${mm(smallestBall)}`),
          { floorRadius: f },
          smallestBall === undefined ? {} : { suggestion: atLeast(smallestBall) },
        ),
      )
    }
  }
  return out
}

function drilling(op: Op<'drilling'>, stock: StockGeometry, lib: Library): DfmWarning[] {
  const out: DfmWarning[] = []
  const r = op.diameter / 2
  const [x, y] = op.center
  if (
    x - r < -EPSILON ||
    y - r < -EPSILON ||
    x + r > stock.length + EPSILON ||
    y + r > stock.width + EPSILON
  )
    out.push(
      warning('dfm.holeOutsideStock', op, 'center', `the hole lies (partly) outside the stock`, {
        x,
        y,
        diameter: op.diameter,
      }),
    )
  if (!lib.empty) {
    const drill = lib.tools.some(
      (t) => t.type === 'drill' && Math.abs(t.diameter - op.diameter) <= TOOL_MATCH_TOLERANCE,
    )
    // helical boring with a smaller end mill makes flat and through holes, not a drill point
    const bore =
      op.bottom.kind !== 'drillPoint' &&
      lib.minEndMill !== undefined &&
      lib.minEndMill < op.diameter - EPSILON
    if (!drill && !bore)
      out.push(
        warning(
          'dfm.holeNoTool',
          op,
          'diameter',
          `no drill of Ø${mm(op.diameter)}` +
            (op.bottom.kind === 'drillPoint' ? '' : ' and no end mill smaller than it') +
            ' in the library',
          { diameter: op.diameter },
        ),
      )
  }
  // through holes: the material below `on`
  const depth = op.bottom.kind === 'through' ? op.onZ + stock.thickness : op.bottom.depth
  const deepest = HOLE_DEPTH_RATIO * op.diameter
  if (depth > deepest + EPSILON)
    out.push(
      warning(
        'dfm.holeDeep',
        op,
        'depth',
        `hole depth ${mm(depth)} > ${HOLE_DEPTH_RATIO} × Ø${mm(op.diameter)} – needs pecking or ` +
          'a long drill',
        { depth, diameter: op.diameter },
        { severity: 'info', suggestion: atMost(deepest) },
      ),
    )
  return out
}

function profile(op: Op<'profile'>, stock: StockGeometry, lib: Library): DfmWarning[] {
  const out: DfmWarning[] = []
  const c = op.shape.contour
  const covers = slotCoversOpening(op)
  if (op.side === 'outside') {
    const half = c.kind === 'circle' ? [c.radius, c.radius] : [c.length / 2, c.width / 2]
    const [x, y] = op.shape.center
    const margin = Math.min(
      x - half[0]!,
      stock.length - x - half[0]!,
      y - half[1]!,
      stock.width - y - half[1]!,
    )
    if (margin < op.slotWidth - EPSILON)
      out.push(
        warning(
          'dfm.slotLeavesStock',
          op,
          'shape',
          `the slot leaves the stock: stock margin ${mm(margin)} < slot width ` +
            `${mm(op.slotWidth)}, so the tabs hold nothing`,
          { margin, slotWidth: op.slotWidth },
        ),
      )
  } else out.push(...corners(op, lib))
  if (lib.minEndMill !== undefined && op.slotWidth < lib.minEndMill - EPSILON)
    out.push(
      warning(
        'dfm.slotNoTool',
        op,
        'slotWidth',
        `slot width ${mm(op.slotWidth)} is smaller than the smallest end mill ` +
          `(${mm(lib.minEndMill)})`,
        { slotWidth: op.slotWidth, toolDiameter: lib.minEndMill },
        { suggestion: atLeast(lib.minEndMill) },
      ),
    )
  if (covers && op.tabs.count > 0)
    out.push(
      warning(
        'dfm.tabsUnused',
        op,
        'tabs.count',
        `the slot covers the whole opening, so it is cut out completely and the ` +
          `${op.tabs.count} tabs are not built`,
        { slotWidth: op.slotWidth, narrowest: narrowest(op) },
        { severity: 'info', suggestion: atMost(0) },
      ),
    )
  if (!covers && op.tabs.count === 0)
    out.push(
      warning(
        'dfm.tabsNone',
        op,
        'tabs.count',
        'no tabs: the piece comes loose at the last pass',
        { count: 0 },
        { suggestion: atLeast(1) },
      ),
    )
  return out
}
