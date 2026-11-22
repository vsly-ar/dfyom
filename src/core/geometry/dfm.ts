/**
 * Parameter and tool DFM checks: synchronous, pure and total, run by the design commands on
 * every change (the geometry checks run in the evaluation, `checks.ts`).
 * Doc: docs/modes/design.md#dfm-checks (rules per operation in its DFM-warnings columns),
 * docs/architecture/geometry.md#evaluation-checks, docs/modes/design-v0.2.md#dfm-access-checks
 *
 * Inputs are the resolved float64 mm of `PartGeometryInput` plus the tool library reduced to
 * the fields the rules need. With an empty library only the geometric rules run. Each operation
 * is checked in its face frame: the stock face rectangle of its direction and the stock extent
 * along its normal stand in for the stock's length × width and thickness (`localStock`).
 */
import type { ToolType } from '../library/tool.dto'
import { adjacentStockFaces, DIRECTION_LABEL, localStock, type Direction } from './face'
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
  /** How deep it reaches: its default stickout, else its flute length (`dfm.reach`). */
  readonly reach?: number
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
  const perOperation = input.operations.flatMap((op): DfmWarning[] => {
    const stock = localStock(directionOf(op), input.stock)
    switch (op.kind) {
      case 'facing':
        return facing(op, options.unitSystem)
      case 'pocket':
        return [...pocket(op, lib), ...reach(op, stock, lib)]
      case 'drilling':
        return [...drilling(op, stock, lib), ...reach(op, stock, lib)]
      case 'profile':
        return [...profile(op, stock, lib, options.unitSystem), ...reach(op, stock, lib)]
    }
  })
  return [...perOperation, ...setups(input)]
}

const directionOf = (op: OperationGeometry): Direction => op.direction ?? '+z'

/**
 * `dfm.setups` (info): the part uses more than one approach direction. Attached to the first
 * operation of the second direction (the one that adds a setup), parameter `on`.
 */
function setups(input: PartGeometryInput): DfmWarning[] {
  const directions: Direction[] = []
  let first: OperationGeometry | undefined
  for (const op of input.operations) {
    const d = directionOf(op)
    if (directions.includes(d)) continue
    directions.push(d)
    if (directions.length === 2) first = op
  }
  if (first === undefined) return []
  const names = directions.map((d) => DIRECTION_LABEL[d])
  return [
    warning(
      'dfm.setups',
      first,
      'on',
      `the part needs ${directions.length} setups (${names.join(', ')})`,
      { count: directions.length, directions: names },
      { severity: 'info' },
    ),
  ]
}

/** Library tools that could make the operation (type and size; the fit table without reach). */
function candidates(op: Op<'pocket'> | Op<'drilling'> | Op<'profile'>, lib: Library): DfmTool[] {
  const endMill = (t: DfmTool) => t.type === 'flatEndMill' || t.type === 'bullNoseEndMill'
  switch (op.kind) {
    case 'pocket':
      return lib.tools.filter(
        (t) => endMill(t) && t.diameter <= narrowest(op) + TOOL_MATCH_TOLERANCE,
      )
    case 'drilling':
      return lib.tools.filter((t) =>
        t.type === 'drill'
          ? Math.abs(t.diameter - op.diameter) <= TOOL_MATCH_TOLERANCE
          : op.bottom.kind !== 'drillPoint' &&
            t.type === 'flatEndMill' &&
            t.diameter > op.diameter / 2 &&
            t.diameter < op.diameter - TOOL_MATCH_TOLERANCE,
      )
    case 'profile':
      return lib.tools.filter(
        (t) => t.type === 'flatEndMill' && t.diameter <= op.slotWidth + TOOL_MATCH_TOLERANCE,
      )
  }
}

/**
 * `dfm.reach` (warning): the depth from the stock's outer face of the operation's direction to
 * its deepest point exceeds the reach of every library tool that could make it (none with a
 * reach: skipped). Until the operation tool field (task A4) this is the "generalized" reading of
 * design-v0.2.md: the longest of the matching library tools.
 */
function reach(
  op: Op<'pocket'> | Op<'drilling'> | Op<'profile'>,
  stock: StockGeometry,
  lib: Library,
): DfmWarning[] {
  const reaches = candidates(op, lib).flatMap((t) => (t.reach === undefined ? [] : [t.reach]))
  if (reaches.length === 0) return []
  const longest = Math.max(...reaches)
  const [depth, parameter] =
    op.kind === 'profile'
      ? [stock.thickness, 'on']
      : op.kind === 'pocket'
        ? [op.depth - op.onZ, 'depth']
        : op.bottom.kind === 'through'
          ? [stock.thickness, 'on']
          : [op.bottom.depth - op.onZ, 'depth']
  if (depth <= longest + EPSILON) return []
  return [
    warning(
      'dfm.reach',
      op,
      parameter,
      `no tool in the library reaches ${mm(depth)} deep from the stock face (longest reach ` +
        `${mm(longest)})`,
      { depth, reach: longest },
    ),
  ]
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
  // through holes: the material below `on` along the normal
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

/**
 * Stock faces around the face rectangle by surface id, with the profile shape's distance to each
 * (the stock margin), in the face frame (`stock` is the local stock; on the top face the sides
 * front, right, back, left).
 */
function margins(op: Op<'profile'>, stock: StockGeometry): [string, number][] {
  const c = op.shape.contour
  const [hx, hy] = c.kind === 'circle' ? [c.radius, c.radius] : [c.length / 2, c.width / 2]
  const [x, y] = op.shape.center
  const [vMin, uMax, vMax, uMin] = adjacentStockFaces(directionOf(op))
  return [
    [vMin, y - hy],
    [uMax, stock.length - x - hx],
    [vMax, stock.width - y - hy],
    [uMin, x - hx],
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
