/**
 * Fit: whether a tool can make an operation, the design's tool requirement (the plan's check
 * table without stepdown and machine). Pure, on the resolved float64 mm of `OperationGeometry`
 * in the operation's face frame; used by the design tool field (auto choice, candidates,
 * `dfm.toolUnfit`) and later by the plan's tool resolution.
 * Doc: docs/modes/design-v0.2.md#fit-when-a-tool-can-make-the-operation
 */
import type { DfmTool } from './dfm'
import { EPSILON, type OperationGeometry, type StockGeometry } from './model'
import { inradius } from './operations'

/** Sizes compare within this (mm), as the DFM tool rules (`TOOL_MATCH_TOLERANCE` in dfm.ts). */
const TOL = 0.01

/** The failed row of the fit table (`params.rule` of `dfm.toolUnfit`). */
export type FitRule = 'type' | 'width' | 'cornerRadius' | 'floorRadius' | 'diameter' | 'reach'

export interface ToolUnfit {
  readonly rule: FitRule
  /** Why, without the tool's name: "cornerRadius 2 mm < tool radius 3 mm". */
  readonly detail: string
  /** What the operation would need (mm): `{ relation, value }` for size rules. */
  readonly need?: { readonly relation: 'atLeast' | 'atMost'; readonly value: number }
}

/** The plan's default `breakthrough` (plan-v0.1.md § Strategy defaults): 0.5 mm / 0.02″. */
export const DEFAULT_BREAKTHROUGH = { metric: 0.5, inch: 0.508 } as const

const mm = (v: number): string => `${Number(v.toFixed(3))} mm`

type Cutting = Exclude<OperationGeometry, { kind: 'facing' }>

/**
 * Depth from the stock's outer face of the operation's direction to its deepest point, and the
 * parameter it is measured at: pocket and flat/point hole to the floor, a through hole and a
 * profile by the stock extent along the normal (`stock` is the local stock).
 */
export function reachDepth(op: Cutting, stock: StockGeometry): [number, string] {
  if (op.kind === 'profile') return [stock.thickness, 'on']
  if (op.kind === 'pocket') return [op.depth - op.onZ, 'depth']
  return op.bottom.kind === 'through'
    ? [stock.thickness, 'on']
    : [op.bottom.depth - op.onZ, 'depth']
}

const endMill = (t: DfmTool) => t.type === 'flatEndMill' || t.type === 'bullNoseEndMill'

/**
 * The first failed fit rule of `tool` for `op`, or undefined when it fits. `reach` is checked
 * only for a tool with one (a specific tool); a generalized tool has no length and passes.
 */
export function toolFit(
  tool: DfmTool,
  op: OperationGeometry,
  stock: StockGeometry,
  unitSystem: 'metric' | 'inch',
): ToolUnfit | undefined {
  const dc = tool.diameter
  const corner = (cornerRadius: number): ToolUnfit | undefined =>
    dc / 2 <= cornerRadius + TOL
      ? undefined
      : {
          rule: 'cornerRadius',
          detail: `cornerRadius ${mm(cornerRadius)} < tool radius ${mm(dc / 2)}`,
          need: { relation: 'atLeast', value: dc / 2 },
        }
  const wider = (size: number, what: string): ToolUnfit | undefined =>
    dc <= size + TOL
      ? undefined
      : {
          rule: 'width',
          detail: `Ø${mm(dc)} is wider than the ${what} (${mm(size)})`,
          need: { relation: 'atLeast', value: dc },
        }
  let unfit: ToolUnfit | undefined
  switch (op.kind) {
    case 'facing':
      return tool.type === 'flatEndMill'
        ? undefined
        : { rule: 'type', detail: 'a facing needs a flat end mill' }
    case 'pocket': {
      if (!endMill(tool))
        return { rule: 'type', detail: 'a pocket needs a flat or bull-nose end mill' }
      const c = op.shape.contour
      unfit =
        wider(2 * inradius(c), 'pocket at its narrowest') ??
        (c.kind === 'rectangle' ? corner(c.cornerRadius) : undefined)
      if (unfit !== undefined) return unfit
      const f = op.floorRadius
      const re = tool.type === 'bullNoseEndMill' ? (tool.cornerRadius ?? 0) : 0
      if (Math.abs(re - f) > TOL)
        return {
          rule: 'floorRadius',
          detail:
            f > EPSILON
              ? `floorRadius ${mm(f)} needs a bull nose with corner radius ${mm(f)}`
              : `its corner radius ${mm(re)} leaves a floor fillet; floorRadius is 0`,
        }
      break
    }
    case 'drilling': {
      const d = op.diameter
      const bottom = op.bottom.kind
      if (tool.type === 'drill') {
        if (bottom === 'flat') return { rule: 'type', detail: 'a drill cannot make a flat bottom' }
        if (Math.abs(dc - d) > TOL)
          return { rule: 'diameter', detail: `drill Ø${mm(dc)} ≠ hole Ø${mm(d)}` }
      } else if (tool.type === 'flatEndMill') {
        if (bottom === 'drillPoint')
          return { rule: 'type', detail: 'an end mill cannot make a drill point' }
        if (!(dc > d / 2 && dc < d - TOL))
          return {
            rule: 'diameter',
            detail: `helical boring of Ø${mm(d)} needs an end mill between Ø${mm(d / 2)} and Ø${mm(d)}`,
          }
      } else return { rule: 'type', detail: 'a hole needs a drill or a flat end mill' }
      break
    }
    case 'profile':
      if (tool.type !== 'flatEndMill')
        return { rule: 'type', detail: 'a profile needs a flat end mill' }
      unfit =
        wider(op.slotWidth, 'slot') ??
        (op.side === 'inside' && op.shape.contour.kind === 'rectangle'
          ? corner(op.shape.contour.cornerRadius)
          : undefined)
      if (unfit !== undefined) return unfit
      break
  }
  if (tool.reach === undefined) return undefined
  const [base] = reachDepth(op, stock)
  const depth = op.kind === 'profile' ? base + DEFAULT_BREAKTHROUGH[unitSystem] : base
  return tool.reach + EPSILON >= depth
    ? undefined
    : { rule: 'reach', detail: `reaches ${mm(tool.reach)}, the operation is ${mm(depth)} deep` }
}
