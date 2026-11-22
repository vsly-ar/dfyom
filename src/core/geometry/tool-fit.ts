/**
 * Fit: whether a tool can make an operation, the design's tool requirement (the plan's check
 * table without stepdown and machine). Pure, on the resolved float64 mm of `OperationGeometry`
 * in the operation's face frame; used by the design tool field (auto choice, candidates,
 * `dfm.toolUnfit`); the plan's tool resolution uses the plan checks (plan-v0.2.md § E4).
 * General shapes (v0.3 K4) read their width and inside corners from a `ShapeMeasure`
 * (shape-measure.ts); without one their size rules are skipped.
 * Doc: docs/modes/design-v0.2.md#fit-when-a-tool-can-make-the-operation,
 * docs/modes/design-v0.3.md#dfm-checks-for-shapes
 */
import type { DfmTool } from './dfm'
import { EPSILON, type OperationGeometry, type StockGeometry } from './model'
import { inradius } from './operations'
import { FIT_SLACK, type ShapeMeasure } from './shape-measure'

/** Sizes compare within this (mm), as the DFM tool rules (`TOOL_MATCH_TOLERANCE` in dfm.ts). */
const TOL = 0.01

/** The failed row of the fit table (`params.rule` of `dfm.toolUnfit`). */
export type FitRule =
  | 'type'
  | 'width'
  | 'cornerRadius'
  | 'floorRadius'
  | 'diameter'
  | 'reach'
  // chamfer (design-v0.4.md § Chamfer operation, Fit)
  | 'angle'
  | 'tip'
  | 'slant'

export interface ToolUnfit {
  readonly rule: FitRule
  /** Why, without the tool's name: "cornerRadius 2 mm < tool radius 3 mm". */
  readonly detail: string
  /** What the operation would need (mm): `{ relation, value }` for size rules. */
  readonly need?: { readonly relation: 'atLeast' | 'atMost'; readonly value: number }
  /**
   * The rule's values for messages (lengths in mm), merged into `dfm.toolUnfit`'s params so the
   * UI can word them in the project units (F5): `cornerRadius` + `toolRadius`, `toolDiameter` +
   * `size` + `feature` (`pocket` | `slot`), `floorRadius` + `toolCornerRadius`, `holeDiameter`
   * (+ `toolDiameter` for a drill, `boring: true` for an end mill), `reach` + `depth`, `needs`; chamfers (v0.4):
   * `toolAngle` + `angle`, `tipDiameter` + `edgeDiameter`, `cuttingEdge` + `slant`.
   */
  readonly values: Readonly<Record<string, number | string | boolean>>
}

/** The plan's default `breakthrough` (plan-v0.1.md § Strategy defaults): 0.5 mm / 0.02″. */
export const DEFAULT_BREAKTHROUGH = { metric: 0.5, inch: 0.508 } as const

const mm = (v: number): string => `${Number(v.toFixed(3))} mm`

type Cutting = Exclude<OperationGeometry, { kind: 'facing' }>

/**
 * Depth from the stock's outer face of the operation's direction to its deepest point, and the
 * parameter it is measured at: pocket and flat/point hole to the floor, a through hole and a
 * through profile by the stock extent along the normal (`stock` is the local stock), a blind `on`
 * groove (v0.3) by its depth below the stock face it starts from.
 */
export function reachDepth(op: Cutting, stock: StockGeometry): [number, string] {
  if (op.kind === 'profile')
    return op.depth === undefined ? [stock.thickness, 'on'] : [op.depth, 'depth']
  if (op.kind === 'pocket') return [op.depth - op.onZ, 'depth']
  return op.bottom.kind === 'through'
    ? [stock.thickness, 'on']
    : [op.bottom.depth - op.onZ, 'depth']
}

const endMill = (t: DfmTool) => t.type === 'flatEndMill' || t.type === 'bullNoseEndMill'

/**
 * The first failed fit rule of `tool` for `op`, or undefined when it fits. `reach` is checked
 * only for a tool with one (a specific tool); a generalized tool has no length and passes.
 * `measure` holds a general shape's width and inside corners (`shapeMeasure`).
 */
export function toolFit(
  tool: DfmTool,
  op: OperationGeometry,
  stock: StockGeometry,
  unitSystem: 'metric' | 'inch',
  measure?: ShapeMeasure,
): ToolUnfit | undefined {
  const dc = tool.diameter
  const corner = (cornerRadius: number): ToolUnfit | undefined =>
    dc / 2 <= cornerRadius + TOL
      ? undefined
      : {
          rule: 'cornerRadius',
          detail: `cornerRadius ${mm(cornerRadius)} < tool radius ${mm(dc / 2)}`,
          need: { relation: 'atLeast', value: dc / 2 },
          values: { cornerRadius, toolRadius: dc / 2 },
        }
  const wider = (size: number, what: string, feature: string): ToolUnfit | undefined =>
    dc <= size + TOL
      ? undefined
      : {
          rule: 'width',
          detail: `Ø${mm(dc)} is wider than the ${what} (${mm(size)})`,
          need: { relation: 'atLeast', value: dc },
          values: { toolDiameter: dc, size, feature },
        }
  // a shape's smallest inside corner of the cut (0: sharp); none (Infinity) fits every tool
  const shapeCorner = (m: ShapeMeasure): ToolUnfit | undefined =>
    Number.isFinite(m.smallestCornerRadius) ? corner(m.smallestCornerRadius) : undefined
  let unfit: ToolUnfit | undefined
  switch (op.kind) {
    case 'facing':
      return tool.type === 'flatEndMill'
        ? undefined
        : {
            rule: 'type',
            detail: 'a facing needs a flat end mill',
            values: { needs: 'flatEndMill' },
          }
    case 'pocket': {
      if (!endMill(tool))
        return {
          rule: 'type',
          detail: 'a pocket needs a flat or bull-nose end mill',
          values: { needs: 'endMill' },
        }
      const c = op.shape.contour
      // general shapes: the region's width (eroded by the tool radius it is empty) and the
      // smallest inside corner, from the 2D layer
      unfit =
        c.kind === 'rectangle' || c.kind === 'circle'
          ? (wider(2 * inradius(c), 'pocket at its narrowest', 'pocket') ??
            (c.kind === 'rectangle' ? corner(c.cornerRadius) : undefined))
          : measure === undefined
            ? undefined
            : measure.fits(dc / 2 - FIT_SLACK)
              ? shapeCorner(measure)
              : wider(
                  Math.min(measure.narrowest(), dc - 2 * TOL),
                  'pocket at its narrowest',
                  'pocket',
                )
      if (unfit !== undefined) return unfit
      const f = op.floorRadius
      const re = tool.type === 'bullNoseEndMill' ? (tool.cornerRadius ?? 0) : 0
      if (Math.abs(re - f) > TOL)
        return {
          rule: 'floorRadius',
          values: { floorRadius: f, toolCornerRadius: re },
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
        if (bottom === 'flat')
          return {
            rule: 'type',
            detail: 'a drill cannot make a flat bottom',
            values: { needs: 'notDrill' },
          }
        if (Math.abs(dc - d) > TOL)
          return {
            rule: 'diameter',
            detail: `drill Ø${mm(dc)} ≠ hole Ø${mm(d)}`,
            values: { holeDiameter: d, toolDiameter: dc },
          }
      } else if (tool.type === 'flatEndMill') {
        if (bottom === 'drillPoint')
          return {
            rule: 'type',
            detail: 'an end mill cannot make a drill point',
            values: { needs: 'drill' },
          }
        if (!(dc > d / 2 && dc < d - TOL))
          return {
            rule: 'diameter',
            values: { holeDiameter: d, toolDiameter: dc, boring: true },
            detail: `helical boring of Ø${mm(d)} needs an end mill between Ø${mm(d / 2)} and Ø${mm(d)}`,
          }
      } else
        return {
          rule: 'type',
          detail: 'a hole needs a drill or a flat end mill',
          values: { needs: 'drillOrFlat' },
        }
      break
    }
    case 'profile':
      if (tool.type !== 'flatEndMill')
        return {
          rule: 'type',
          detail: 'a profile needs a flat end mill',
          values: { needs: 'flatEndMill' },
        }
      unfit =
        wider(op.slotWidth, 'slot', 'slot') ??
        (measure !== undefined
          ? shapeCorner(measure)
          : op.side === 'inside' && op.shape.contour.kind === 'rectangle'
            ? corner(op.shape.contour.cornerRadius)
            : undefined)
      if (unfit !== undefined) return unfit
      break
  }
  if (tool.reach === undefined) return undefined
  const [base] = reachDepth(op, stock)
  // a through profile breaks through the far face; a blind groove stops at its depth
  const through = op.kind === 'profile' && op.depth === undefined
  const depth = through ? base + DEFAULT_BREAKTHROUGH[unitSystem] : base
  return tool.reach + EPSILON >= depth
    ? undefined
    : {
        rule: 'reach',
        detail: `reaches ${mm(tool.reach)}, the operation is ${mm(depth)} deep`,
        values: { reach: tool.reach, depth },
      }
}

/** A circular chamfer as the fit rule sees it (mm, degrees): its edge Ø, chamfer Ø and angle. */
export interface ChamferFitInput {
  readonly edgeDiameter: number
  readonly diameter: number
  /** Included angle, degrees. */
  readonly angle: number
}

/** Chamfer mill angles match within this (degrees), design-v0.4.md § Chamfer operation. */
export const CHAMFER_ANGLE_TOLERANCE = 0.5

/** Slant length of a cone between two diameters at included angle `angle` (degrees). */
export const coneSlant = (inner: number, outer: number, angle: number): number =>
  (outer - inner) / 2 / Math.sin(((angle / 2) * Math.PI) / 180)

/**
 * The fit row of a circular chamfer (design-v0.4.md § Chamfer operation, Fit): a `chamferMill`
 * whose angle equals the chamfer's within 0.5°, whose tip is smaller than the edge Ø, and that
 * either covers the chamfer Ø (plunged at the centre) or has a cutting edge (its cone's slant from
 * tip to DC) at least the chamfer's slant height (contoured). First failed rule, or undefined.
 * Reach is checked by the chamfer operation (task C2), which knows the depth below the face.
 */
export function chamferFit(tool: DfmTool, c: ChamferFitInput): ToolUnfit | undefined {
  if (tool.type !== 'chamferMill' || tool.angle === undefined)
    return {
      rule: 'type',
      detail: 'a chamfer needs a chamfer mill',
      values: { needs: 'chamferMill' },
    }
  if (Math.abs(tool.angle - c.angle) > CHAMFER_ANGLE_TOLERANCE)
    return {
      rule: 'angle',
      detail: `tool angle ${tool.angle}° ≠ chamfer angle ${c.angle}°`,
      values: { toolAngle: tool.angle, angle: c.angle },
    }
  const tip = tool.tipDiameter ?? 0
  if (tip >= c.edgeDiameter - TOL)
    return {
      rule: 'tip',
      detail: `tip Ø${mm(tip)} is not smaller than the edge Ø${mm(c.edgeDiameter)}`,
      need: { relation: 'atLeast', value: tip },
      values: { tipDiameter: tip, edgeDiameter: c.edgeDiameter },
    }
  if (tool.diameter + TOL >= c.diameter) return undefined
  const edge = coneSlant(tip, tool.diameter, tool.angle)
  const slant = coneSlant(c.edgeDiameter, c.diameter, c.angle)
  return edge + TOL >= slant
    ? undefined
    : {
        rule: 'slant',
        detail: `cutting edge ${mm(edge)} is shorter than the chamfer's slant ${mm(slant)}`,
        values: { cuttingEdge: edge, slant, toolDiameter: tool.diameter, diameter: c.diameter },
      }
}
