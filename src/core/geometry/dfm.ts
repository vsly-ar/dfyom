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
 *
 * v0.3 shapes (K4, docs/modes/design-v0.3.md#dfm-checks-for-shapes): general shapes (named,
 * rotated, `on`) read their resolved loops through `ShapeMeasure` (shape-measure.ts, the 2D port
 * in `region2d`); without a port their region rules are skipped.
 */
import type { ToolType } from '../library/tool.dto'
import type { Region2dPort } from './2d/port'
import type { Bounds2 } from './2d/model'
import { adjacentStockFaces, DIRECTION_LABEL, localStock, type Direction } from './face'
import {
  CHORD_TOLERANCE,
  EPSILON,
  type DfmSuggestion,
  type DfmWarning,
  type DfmWarningCode,
  type OperationGeometry,
  type PartGeometryInput,
  type StockGeometry,
  isAnalyticOperation,
  type AnalyticOperation,
} from './model'
import { inradius, slotCoversOpening } from './operations'
import { profileChain } from './outline'
import { SHAPE_CHORD_BUDGET, shapeChords } from './shape-solids'
import { FIT_SLACK, shapeMeasure, type ShapeMeasure } from './shape-measure'
import { reachDepth, toolFit } from './tool-fit'

/** A library tool as the DFM rules see it (mm). */
export interface DfmTool {
  readonly type: ToolType
  readonly diameter: number
  /** Bull-nose corner radius (RE); flat = 0 and ball = diameter / 2 are derived. */
  readonly cornerRadius?: number
  /** How deep it reaches: its default stickout, else its flute length (`dfm.reach`). */
  readonly reach?: number
}

/** The operation's own tool (its design tool field, docs/modes/design-v0.2.md#dfm-with-the-tool). */
export interface OperationTool {
  /** A generalized tool has no `reach` (no lengths). */
  readonly tool: DfmTool
  readonly generalized: boolean
  readonly locked: boolean
  /** "6 mm flat end mill" or the library tool's name, for messages. */
  readonly label: string
}

export interface ParameterCheckOptions {
  /** The whole tool library, not a chosen machine. */
  readonly tools: readonly DfmTool[]
  /** Picks the thresholds that differ per unit system (facing: 3 mm / 1/8″). */
  readonly unitSystem: 'metric' | 'inch'
  /** Each operation's tool by operation id; absent = none chosen yet (no own-tool rules). */
  readonly operationTools?: Readonly<Record<string, OperationTool>>
  /** The 2D port for general shapes (v0.3); absent = their region rules are skipped. */
  readonly region2d?: Region2dPort
}

/** A tool matches a nominal size within this (mm): a drill's diameter, a bull-nose radius. */
export const TOOL_MATCH_TOLERANCE = 0.01

const FACING_DEEP = { metric: 3, inch: 25.4 / 8 } as const
const POCKET_DEPTH_RATIO = 4
const HOLE_DEPTH_RATIO = 5
/** Smallest tab thickness and width (mm): 1 mm / 1/32″. */
const TAB_MIN = { metric: 1, inch: 25.4 / 32 } as const
/** Fit rules after which rest material is not reported (the tool cannot make the cut at all). */
const NO_REST_RULES: ReadonlySet<string> = new Set(['type', 'width'])
/** Inside corners of a shape reported one by one; the rest go into one count warning. */
const CORNERS_LISTED = 10

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
  const notInLibrary = new Set<string>()
  const tools = options.operationTools ?? {}
  const perOperation = input.operations.flatMap((op): DfmWarning[] => {
    const stock = localStock(directionOf(op), input.stock)
    const own = Object.hasOwn(tools, op.id) ? tools[op.id] : undefined
    // general shapes only: v0.1 contours keep their analytic rules
    const measure =
      options.region2d !== undefined && (op.kind === 'pocket' || op.kind === 'profile')
        ? isAnalyticOperation(op)
          ? undefined
          : shapeMeasure(options.region2d, op)
        : undefined
    const tool =
      own === undefined ? [] : ownTool(op, own, stock, lib, options, notInLibrary, measure)
    // `dfm.shapeHeavy`: a general shape's chords over the evaluation budget (G1, D29)
    const heavy =
      (op.kind === 'pocket' || op.kind === 'profile') && !isAnalyticOperation(op)
        ? shapeHeavy(op)
        : []
    switch (op.kind) {
      case 'facing':
        return [...facing(op, options.unitSystem), ...tool]
      case 'pocket':
        return [
          ...(isAnalyticOperation(op) ? pocket(op, lib) : shapePocket(op, stock, lib, measure)),
          ...reach(op, stock, lib, own, measure),
          ...heavy,
          ...tool,
        ]
      case 'drilling':
        return [...drilling(op, stock, lib), ...reach(op, stock, lib, own), ...tool]
      case 'profile':
        return [
          ...(isAnalyticOperation(op)
            ? profile(op, stock, lib, options.unitSystem)
            : options.region2d === undefined
              ? []
              : shapeProfile(op, stock, lib, options.unitSystem, measure)),
          ...reach(op, stock, lib, own),
          ...heavy,
          ...tool,
        ]
    }
  })
  return [...perOperation, ...setups(input)]
}

/**
 * `dfm.shapeHeavy` (info): the shape's chords at the chord tolerance exceed what one evaluation
 * builds within its budget (≈ 3 000 chords per 50 ms), so the part updates more slowly
 * (docs/architecture/shapes.md#implementation-g1, #decisions-d29).
 */
function shapeHeavy(op: Op<'pocket'> | Op<'profile'>): DfmWarning[] {
  const chords = shapeChords(op)
  if (chords <= SHAPE_CHORD_BUDGET) return []
  return [
    warning(
      'dfm.shapeHeavy',
      op,
      'shape',
      `the shape has ${chords} segments after flattening, so the part updates more slowly`,
      { chords, budget: SHAPE_CHORD_BUDGET },
      { severity: 'info' },
    ),
  ]
}

/** The library tools of a generalized tool's type and size (RE for a bull nose) within 0.01 mm. */
function matching(t: DfmTool, lib: Library): DfmTool[] {
  const near = (a: number | undefined, b: number | undefined) =>
    Math.abs((a ?? 0) - (b ?? 0)) <= TOOL_MATCH_TOLERANCE
  return lib.tools.filter(
    (l) =>
      l.type === t.type &&
      near(l.diameter, t.diameter) &&
      (t.type !== 'bullNoseEndMill' || near(l.cornerRadius, t.cornerRadius)),
  )
}

/**
 * Rules against the operation's own tool: `dfm.toolUnfit` (the failed fit rule) and, for a
 * generalized tool, `dfm.toolNotInLibrary` (with an empty library once per distinct tool).
 */
function ownTool(
  op: OperationGeometry,
  own: OperationTool,
  stock: StockGeometry,
  lib: Library,
  options: ParameterCheckOptions,
  notInLibrary: Set<string>,
  measure: ShapeMeasure | undefined,
): DfmWarning[] {
  const out: DfmWarning[] = []
  const unfit = toolFit(own.tool, op, stock, options.unitSystem, measure)
  if (unfit !== undefined)
    out.push(
      warning(
        'dfm.toolUnfit',
        op,
        'tool',
        `the ${own.label} does not fit: ${unfit.detail}` +
          (own.locked ? ' – unlock or pick another tool' : ''),
        { ...unfit.values, rule: unfit.rule, locked: own.locked, tool: own.label },
        unfit.need === undefined ? {} : { suggestion: unfit.need },
      ),
    )
  // rest material needs a tool of the right type that enters the region (corners are their rule's)
  if (measure !== undefined && (unfit === undefined || !NO_REST_RULES.has(unfit.rule)))
    out.push(...restMaterial(op, own, measure))
  if (own.generalized && matching(own.tool, lib).length === 0) {
    const t = own.tool
    const key = `${t.type}:${t.diameter}:${t.cornerRadius ?? ''}`
    if (!lib.empty || !notInLibrary.has(key)) {
      notInLibrary.add(key)
      out.push(
        warning(
          'dfm.toolNotInLibrary',
          op,
          'tool',
          `Plan needs a ${own.label}; add one to the library`,
          { tool: own.label, type: t.type, diameter: t.diameter },
          { severity: 'info' },
        ),
      )
    }
  }
  return out
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
function candidates(
  op: Op<'pocket'> | Op<'drilling'> | Op<'profile'>,
  lib: Library,
  measure?: ShapeMeasure,
): DfmTool[] {
  const endMill = (t: DfmTool) => t.type === 'flatEndMill' || t.type === 'bullNoseEndMill'
  switch (op.kind) {
    case 'pocket':
      return lib.tools.filter(
        (t) =>
          endMill(t) &&
          (measure === undefined
            ? t.diameter <= narrowest(op) + TOOL_MATCH_TOLERANCE
            : measure.fits(t.diameter / 2 - FIT_SLACK)),
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
 * its deepest point exceeds the reach of the operation's tool: a specific tool's own reach
 * (`stickout`, else `fluteLength`), for a generalized one the longest of the matching library
 * tools (none: skipped). Without a tool yet (before the first Apply) the longest reach of the
 * library tools that could make it.
 */
function reach(
  op: Op<'pocket'> | Op<'drilling'> | Op<'profile'>,
  stock: StockGeometry,
  lib: Library,
  own: OperationTool | undefined,
  measure?: ShapeMeasure,
): DfmWarning[] {
  const pool =
    own === undefined
      ? candidates(op, lib, measure)
      : own.generalized
        ? matching(own.tool, lib)
        : [own.tool]
  const reaches = pool.flatMap((t) => (t.reach === undefined ? [] : [t.reach]))
  if (reaches.length === 0) return []
  const longest = Math.max(...reaches)
  const [depth, parameter] = reachDepth(op, stock)
  if (depth <= longest + EPSILON) return []
  const specific = own !== undefined && !own.generalized
  const what =
    own === undefined
      ? 'no tool in the library reaches'
      : specific
        ? `the ${own.label} does not reach`
        : `no ${own.label} in the library reaches`
  return [
    warning(
      'dfm.reach',
      op,
      parameter,
      `${what} ${mm(depth)} deep from the stock face (${specific ? '' : 'longest '}reach ` +
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

/**
 * Narrowest size of a v0.1 contour (twice its inradius: the circle's diameter, the rectangle's
 * shorter side); a general shape (named, rotated, `on`) has no analytic width: Infinity here, its
 * width comes from `ShapeMeasure`.
 */
const narrowest = (op: Op<'pocket'> | Op<'profile'>): number =>
  isAnalyticOperation(op) ? 2 * inradius(op.shape.contour) : Infinity

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

function pocket(op: AnalyticOperation<'pocket'>, lib: Library): DfmWarning[] {
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
  out.push(...corners(op, lib), ...floorRadiusRule(op, lib))
  return out
}

/** `dfm.floorRadiusNoTool`: no bull nose with RE = `floorRadius` and no ball small enough. */
function floorRadiusRule(op: Op<'pocket'>, lib: Library): DfmWarning[] {
  const out: DfmWarning[] = []
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
function margins(op: AnalyticOperation<'profile'>, stock: StockGeometry): [string, number][] {
  const c = op.shape.contour
  const [hx, hy] = c.kind === 'circle' ? [c.radius, c.radius] : [c.length / 2, c.width / 2]
  const [x, y] = op.shape.center
  return boxMargins(op, { min: [x - hx, y - hy], max: [x + hx, y + hy] }, stock)
}

/**
 * The stock margin on each side of a box in the face frame: [surface id of the adjacent stock
 * face, distance from the box to the face rectangle's edge] (negative: the box crosses it).
 */
function boxMargins(op: OperationGeometry, b: Bounds2, stock: StockGeometry): [string, number][] {
  const [vMin, uMax, vMax, uMin] = adjacentStockFaces(directionOf(op))
  return [
    [vMin, b.min[1]],
    [uMax, stock.length - b.max[0]],
    [vMax, stock.width - b.max[1]],
    [uMin, b.min[0]],
  ]
}

/** A box of the shape's frame moved to the face frame by the shape's centre. */
const placed = (b: Bounds2, center: readonly [number, number]): Bounds2 => ({
  min: [b.min[0] + center[0], b.min[1] + center[1]],
  max: [b.max[0] + center[0], b.max[1] + center[1]],
})

function profile(
  op: AnalyticOperation<'profile'>,
  stock: StockGeometry,
  lib: Library,
  unitSystem: 'metric' | 'inch',
): DfmWarning[] {
  const out: DfmWarning[] = []
  const covers = slotCoversOpening(op)
  if (op.side === 'outside') out.push(...slotStock(op, margins(op, stock)))
  else out.push(...corners(op, lib))
  out.push(...slotTool(op, lib))
  out.push(...tabRules(op, op.tabs.count, covers, () => narrowest(op), unitSystem))
  return out
}

/** `dfm.slotLeavesStock` / `dfm.slotOpensStock` of an outside profile from its stock margins. */
function slotStock(op: Op<'profile'>, all: readonly [string, number][]): DfmWarning[] {
  const out: DfmWarning[] = []
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
  return out
}

/** `dfm.slotNoTool`: the slot is narrower than the smallest end mill. */
function slotTool(op: Op<'profile'>, lib: Library): DfmWarning[] {
  const out: DfmWarning[] = []
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
  return out
}

/**
 * Tab rules of a through cut of a closed loop with `count` tabs (`tabs.positions` count as
 * theirs): `dfm.tabsUnused` when the slot covers the whole opening, `dfm.tabsNone`, `dfm.tabsThin`.
 */
function tabRules(
  op: Op<'profile'>,
  count: number,
  covers: boolean,
  width: () => number,
  unitSystem: 'metric' | 'inch',
): DfmWarning[] {
  const out: DfmWarning[] = []
  if (covers && count > 0)
    out.push(
      warning(
        'dfm.tabsUnused',
        op,
        'tabs.count',
        `the slot covers the whole opening, so it is cut out completely and the ` +
          `${count} tabs are not built`,
        { slotWidth: op.slotWidth, narrowest: width() },
        { severity: 'info', suggestion: atMost(0) },
      ),
    )
  if (!covers && count === 0)
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
  if (!covers && count > 0) {
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

// ── v0.3 shapes (K4): docs/modes/design-v0.3.md#dfm-checks-for-shapes ──────────────────────

/** `[u, v]` in the face frame of a point of the shape's frame. */
const atFace = (p: readonly [number, number], center: readonly [number, number]): number[] => [
  p[0] + center[0],
  p[1] + center[1],
]
const point = (p: readonly number[]): string => `(${mm(p[0]!)}, ${mm(p[1]!)})`

/**
 * `dfm.shapeOutsideFace`: a general pocket's placed shape reaches outside the face rectangle of
 * its direction (v0.1 rectangles and circles keep v0.2's behaviour: an open-sided pocket is a
 * way to cut a rebate), from the placed loops' exact bounds.
 */
function outsideFace(op: Op<'pocket'>, stock: StockGeometry, bounds: Bounds2): DfmWarning[] {
  const all = boxMargins(op, placed(bounds, op.shape.center), stock)
  const sides = all.filter(([, m]) => m < -EPSILON).map(([s]) => s)
  if (sides.length === 0) return []
  const by = -Math.min(...all.map(([, m]) => m))
  return [
    warning(
      'dfm.shapeOutsideFace',
      op,
      'center',
      `the shape reaches ${mm(by)} outside the stock face at ${sides.join(', ')}`,
      { sides, by },
    ),
  ]
}

/**
 * `dfm.cornerSharp` / `dfm.cornerTooSmall` for every inside corner of the cut (a sharp vertex, or
 * an arc of the cut's sense below the smallest end mill's radius), one per corner up to
 * `CORNERS_LISTED`, then one count warning holding the other markers (`points`, flat u, v pairs).
 */
function shapeCorners(
  op: Op<'pocket'> | Op<'profile'>,
  m: ShapeMeasure,
  lib: Library,
): DfmWarning[] {
  const min = lib.minEndMill === undefined ? undefined : lib.minEndMill / 2
  const bad = m.corners.filter(
    (c) => c.radius <= EPSILON || (min !== undefined && c.radius < min - TOOL_MATCH_TOLERANCE),
  )
  const suggestion = min === undefined ? {} : { suggestion: atLeast(min) }
  const round = min === undefined ? '' : ` – round it to ≥ ${mm(min)}`
  const out = bad.slice(0, CORNERS_LISTED).map((c) => {
    const at = atFace(c.at, op.shape.center)
    return c.radius <= EPSILON
      ? warning(
          'dfm.cornerSharp',
          op,
          'shape',
          `a sharp inside corner at ${point(at)} cannot be cut by a round tool${round}`,
          { cornerRadius: 0, at },
          suggestion,
        )
      : warning(
          'dfm.cornerTooSmall',
          op,
          'shape',
          `no tool can make the ${mm(c.radius)} corner at ${point(at)}: the smallest end mill ` +
            `has radius ${mm(min!)}${round}`,
          { cornerRadius: c.radius, toolRadius: min!, at },
          suggestion,
        )
  })
  const more = bad.slice(CORNERS_LISTED)
  if (more.length > 0) {
    const sharp = more.some((c) => c.radius <= EPSILON)
    out.push(
      warning(
        sharp ? 'dfm.cornerSharp' : 'dfm.cornerTooSmall',
        op,
        'shape',
        `${more.length} more inside corners are too sharp for the smallest tool${round}`,
        {
          more: more.length,
          cornerRadius: Math.min(...more.map((c) => c.radius)),
          ...(min !== undefined && { toolRadius: min }),
          at: atFace(more[0]!.at, op.shape.center),
          points: more.flatMap((c) => atFace(c.at, op.shape.center)),
        },
        suggestion,
      ),
    )
  }
  return out
}

/**
 * Region rules of a general pocket (`m` from the 2D port): `dfm.shapeOutsideFace`,
 * `dfm.pocketNoToolFits` and `dfm.pocketDeepNarrow` from the region's width, the inside corners
 * and `dfm.floorRadiusNoTool`.
 */
function shapePocket(
  op: Op<'pocket'>,
  stock: StockGeometry,
  lib: Library,
  m: ShapeMeasure | undefined,
): DfmWarning[] {
  if (m === undefined) return []
  const out = outsideFace(op, stock, m.bounds)
  if (lib.minEndMill !== undefined && !m.fits(lib.minEndMill / 2 - FIT_SLACK)) {
    const size = m.narrowest()
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
  }
  // narrowest < depth / ratio ⇔ the region eroded by depth / (2 ratio) is empty
  if (op.depth > EPSILON && !m.fits((op.depth - EPSILON) / (2 * POCKET_DEPTH_RATIO))) {
    const size = m.narrowest()
    out.push(
      warning(
        'dfm.pocketDeepNarrow',
        op,
        'depth',
        `deep, narrow pocket (depth ${mm(op.depth)} > ${POCKET_DEPTH_RATIO} × ${mm(size)}) – ` +
          'needs a long tool',
        { depth: op.depth, narrowest: size },
        { suggestion: atMost(POCKET_DEPTH_RATIO * size) },
      ),
    )
  }
  out.push(...shapeCorners(op, m, lib), ...floorRadiusRule(op, lib))
  return out
}

/**
 * Rules of a general profile (a named or rotated loop, an `on` groove): stock margins of an
 * outside slot from the loop's exact bounds (its offset by `slotWidth` reaches exactly
 * `slotWidth` beyond them on each side), inside corners (`inside`: the loop's corners,
 * `outside`: its concave notches; `on` has none), `dfm.slotNoTool` and the tab rules of a
 * through cut of a closed loop.
 */
function shapeProfile(
  op: Op<'profile'>,
  stock: StockGeometry,
  lib: Library,
  unitSystem: 'metric' | 'inch',
  m: ShapeMeasure | undefined,
): DfmWarning[] {
  const out: DfmWarning[] = []
  if (m !== undefined) {
    if (op.side === 'outside')
      out.push(...slotStock(op, boxMargins(op, placed(m.bounds, op.shape.center), stock)))
    out.push(...shapeCorners(op, m, lib))
  }
  out.push(...slotTool(op, lib))
  const { closed } = profileChain(op)
  if (closed && op.depth === undefined) {
    // the slot covers the opening when the loop's interior eroded by the slot is empty
    const covers =
      m !== undefined && op.side === 'inside' && !m.fits(op.slotWidth + CHORD_TOLERANCE)
    const count = op.tabs.positions?.length ?? op.tabs.count
    out.push(...tabRules(op, count, covers, () => m?.narrowest() ?? Infinity, unitSystem))
  }
  return out
}

/**
 * `dfm.restMaterial`: the operation's own tool leaves material away from the corners (necks
 * narrower than the tool between two parts of the region, narrow notches of an outside loop).
 * One warning per operation: the total area, the largest piece's marker at `at`, every marker in
 * `points` (flat u, v pairs).
 */
function restMaterial(op: OperationGeometry, own: OperationTool, m: ShapeMeasure): DfmWarning[] {
  if (op.kind !== 'pocket' && op.kind !== 'profile') return []
  const pieces = m.rest(own.tool.diameter / 2 - FIT_SLACK)
  if (pieces.length === 0) return []
  const area = pieces.reduce((s, p) => s + p.area, 0)
  const at = atFace(pieces[0]!.at, op.shape.center)
  return [
    warning(
      'dfm.restMaterial',
      op,
      'tool',
      `the ${own.label} leaves ${Number(area.toFixed(1))} mm² uncut near ${point(at)} ` +
        `(${pieces.length === 1 ? 'a neck' : `${pieces.length} places`} narrower than the tool)`,
      {
        area,
        at,
        pieces: pieces.length,
        points: pieces.flatMap((p) => atFace(p.at, op.shape.center)),
        tool: own.label,
      },
    ),
  ]
}
