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
/** Smallest tab thickness and width (mm): 1 mm / 1/32″. */
const TAB_MIN = { metric: 1, inch: 25.4 / 32 } as const

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
        return profile(op, input.stock, lib, options.unitSystem)
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
  if (min !== undefined && c.cornerRadius < min - TOOL_MATCH_TOLERANCE)
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
  if (lib.minEndMill !== undefined && size < lib.minEndMill - TOOL_MATCH_TOLERANCE)
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
    // helical boring with a smaller end mill makes through holes (any end mill) and flat
    // bottoms (a flat end mill only), never a drill point
    const boring = (t: DfmTool): boolean =>
      t.diameter < op.diameter - TOOL_MATCH_TOLERANCE &&
      (op.bottom.kind === 'through' ? t.type !== 'drill' : t.type === 'flatEndMill')
    const bore = op.bottom.kind !== 'drillPoint' && lib.tools.some(boring)
    const borer = { through: ' and no end mill', flat: ' and no flat end mill', drillPoint: '' }
    if (!drill && !bore)
      out.push(
        warning(
          'dfm.holeNoTool',
          op,
          'diameter',
          `no drill of Ø${mm(op.diameter)}` +
            (op.bottom.kind === 'drillPoint' ? '' : `${borer[op.bottom.kind]} smaller than it`) +
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

/** Stock sides by surface id, with the profile shape's distance to each (the stock margin). */
function margins(op: Op<'profile'>, stock: StockGeometry): [string, number][] {
  const c = op.shape.contour
  const [hx, hy] = c.kind === 'circle' ? [c.radius, c.radius] : [c.length / 2, c.width / 2]
  const [x, y] = op.shape.center
  return [
    ['stock.side[0]', y - hy], // front, y = 0
    ['stock.side[1]', stock.length - x - hx], // right
    ['stock.side[2]', stock.width - y - hy], // back
    ['stock.side[3]', x - hx], // left, x = 0
  ]
}

function profile(
  op: Op<'profile'>,
  stock: StockGeometry,
  lib: Library,
  unitSystem: 'metric' | 'inch',
): DfmWarning[] {
  const out: DfmWarning[] = []
  const covers = slotCoversOpening(op)
  if (op.side === 'outside') {
    const all = margins(op, stock)
    const short = all.filter(([, m]) => m < op.slotWidth - EPSILON)
    const margin = Math.min(...all.map(([, m]) => m))
    const sides = short.map(([s]) => s)
    if (short.length === all.length)
      // the frame falls apart: nothing is left for the tabs to hold on to
      out.push(
        warning(
          'dfm.slotLeavesStock',
          op,
          'shape',
          `the slot leaves the stock on every side (stock margin ${mm(margin)} < slot width ` +
            `${mm(op.slotWidth)}), so the tabs hold nothing`,
          { margin, slotWidth: op.slotWidth, sides },
        ),
      )
    else if (short.length > 0)
      out.push(
        warning(
          'dfm.slotOpensStock',
          op,
          'shape',
          `the slot runs out of the stock at ${sides.join(', ')} (stock margin ${mm(margin)} < ` +
            `slot width ${mm(op.slotWidth)}); the frame still holds the tabs on the other sides`,
          { margin, slotWidth: op.slotWidth, sides },
          { severity: 'info' },
        ),
      )
  } else out.push(...corners(op, lib))
  if (lib.minEndMill !== undefined && op.slotWidth < lib.minEndMill - TOOL_MATCH_TOLERANCE)
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
  if (!covers && op.tabs.count > 0) {
    // connectivity is topological: a hair-thin tab still "holds" in the evaluation
    const limit = TAB_MIN[unitSystem]
    for (const [parameter, value] of [
      ['tabs.thickness', op.tabs.thickness],
      ['tabs.width', op.tabs.width],
    ] as const)
      if (value < limit - EPSILON)
        out.push(
          warning(
            'dfm.tabsThin',
            op,
            parameter,
            `${parameter} ${mm(value)} is too small to hold the piece – use at least ${mm(limit)}`,
            { [parameter.slice(5)]: value, limit },
            { suggestion: atLeast(limit) },
          ),
        )
  }
  return out
}
