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
import {
  CHAMFER_ANGLE_TOLERANCE,
  chamferDepth,
  isLoopChamfer,
  loopChamferDepth,
  coneSlant,
  EPSILON,
  type OperationGeometry,
  type StockGeometry,
} from './model'
import { inradius } from './operations'
import { rectangleWallCorner } from './open-sides'
import { FIT_SLACK, smallestWallCorner, type ShapeMeasure } from './shape-measure'

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
  // the flutes do not cut the wall's depth and the shank is not narrower (hardening DF89)
  | 'flutes'
  // a pattern's roughing tool over ROUGHING_SHARE of the widest cell's width (DF108)
  | 'roughingWidth'
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
   * (+ `toolDiameter` for a drill, `boring: true` for an end mill), `reach` + `depth`, `needs`;
   * flutes (DF89): `fluteLength` + `depth` + `margin` (+ `shankDiameter` when known); chamfers (v0.4):
   * `toolAngle` + `angle`, `tipDiameter` + `edgeDiameter`, `cuttingEdge` + `slant`.
   */
  readonly values: Readonly<Record<string, number | string | boolean>>
}

/**
 * The flutes must cut a wall this much deeper than the operation (mm; hardening DF89): the flute
 * run-out at the end of the cutting length cuts poorly, and a library LCF is often rounded.
 */
export const FLUTE_MARGIN = 0.5

/**
 * Whether the tool's shank clears the wall it cuts (DF89, the plan's `shankRub` rule, plan-v0.1.md
 * § Pocket deeper than the flutes): its shank is narrower than its cutting Ø by more than the
 * 0.01 mm fit tolerance (a reduced shank or a neck). An unknown shank does not.
 */
export const shankClears = (tool: DfmTool): boolean =>
  tool.shankDiameter !== undefined && tool.shankDiameter < tool.diameter - TOL

/**
 * The flute rule of a wall-following cut (pocket, profile, hole; hardening DF89): `depth` (mm,
 * from the stock face) ≤ the flute length − `FLUTE_MARGIN`, unless the shank clears the wall
 * (`shankClears`: then the stickout alone limits the depth). A tool without a flute length
 * (a generalized one) passes.
 */
export function flutesFit(tool: DfmTool, depth: number): ToolUnfit | undefined {
  if (tool.fluteLength === undefined || shankClears(tool)) return undefined
  const cuts = tool.fluteLength - FLUTE_MARGIN
  if (cuts + EPSILON >= depth) return undefined
  const shank =
    tool.shankDiameter === undefined
      ? 'shank Ø unknown'
      : `shank Ø${mm(tool.shankDiameter)} not narrower than the cutter`
  return {
    rule: 'flutes',
    detail:
      `flute length ${mm(tool.fluteLength)} (${shank}) cuts walls ${mm(cuts)} deep, ` +
      `the operation is ${mm(depth)} deep`,
    values: {
      fluteLength: tool.fluteLength,
      depth,
      margin: FLUTE_MARGIN,
      ...(tool.shankDiameter !== undefined && { shankDiameter: tool.shankDiameter }),
    },
  }
}

/** The plan's default `breakthrough` (plan-v0.1.md § Strategy defaults): 0.5 mm / 0.02″. */
export const DEFAULT_BREAKTHROUGH = { metric: 0.5, inch: 0.508 } as const

const mm = (v: number): string => `${Number(v.toFixed(3))} mm`

type Cutting = Exclude<OperationGeometry, { kind: 'facing' }>

/**
 * Depth from the stock's outer face of the operation's direction to its deepest point, and the
 * parameter it is measured at: pocket and flat/point hole to the floor, a through hole by the
 * stock extent along the normal (`stock` is the local stock), a through profile or hole by its
 * `throughDepth` (material an earlier setup left, DF50, DF61; a through pocket's too) else that extent, a blind `on`
 * groove (v0.3) by its depth below the stock face it starts from.
 */
export function reachDepth(op: Cutting, stock: StockGeometry): [number, string] {
  if (op.kind === 'profile')
    return op.depth === undefined ? [op.throughDepth ?? stock.thickness, 'on'] : [op.depth, 'depth']
  // a through pocket (patterns P4) as a through profile: its `throughDepth` when set
  if (op.kind === 'pocket') return [op.throughDepth ?? op.depth - op.onZ, 'depth']
  // the cone's bottom (the tool tip when contoured; a plunged tip goes deeper, `toolFit`)
  if (op.kind === 'chamfer')
    return isLoopChamfer(op)
      ? [loopChamferDepth(op) - op.onZ, 'width']
      : [chamferDepth(op) - op.onZ, 'diameter']
  return op.bottom.kind === 'through'
    ? [op.throughDepth ?? stock.thickness, 'on']
    : [op.bottom.depth - op.onZ, 'depth']
}

/**
 * DF108: a pattern's roughing tool is at most this share of the widest cell's narrowest width, so
 * it clears the cells' middles (a Ø 6 mm in a 10 mm hexagon) rather than a centre line.
 * Doc: docs/modes/patterns.md#roughing-df108
 */
export const ROUGHING_SHARE = 0.6

const endMill = (t: DfmTool) => t.type === 'flatEndMill' || t.type === 'bullNoseEndMill'

/**
 * The first failed fit rule of `tool` for `op`, or undefined when it fits. `reach` and `flutes`
 * are checked only for a tool with lengths (a specific tool); a generalized tool has none and
 * passes. `flutes` (DF89) applies to the wall-following cuts: pocket, profile and hole.
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
  // a shape's smallest inside corner of the cut (0: sharp); none (Infinity) fits every tool;
  // corners whose leftover lies beyond the stock do not count (DF53)
  const shapeCorner = (m: ShapeMeasure): ToolUnfit | undefined => {
    if (!('shape' in op)) return undefined
    const r = smallestWallCorner(m, op.shape.center, stock, dc / 2)
    return Number.isFinite(r) ? corner(r) : undefined
  }
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
      // DF108: a roughing pocket's tool fits some cell and is at most ROUGHING_SHARE of the widest
      // cell's narrowest width (a tool that only just fits clears a centre line); no corner rule
      if (op.roughing === true && measure !== undefined)
        unfit = !measure.fits(dc / 2 - FIT_SLACK)
          ? wider(Math.min(measure.narrowest(), dc - 2 * TOL), 'pocket at its narrowest', 'pocket')
          : dc <= ROUGHING_SHARE * measure.narrowest() + TOL
            ? undefined
            : {
                rule: 'roughingWidth',
                detail: `Ø${mm(dc)} is over ${ROUGHING_SHARE} × the widest cell (${mm(measure.narrowest())}): it would clear little`,
                need: { relation: 'atMost', value: ROUGHING_SHARE * measure.narrowest() },
                values: { toolDiameter: dc, size: measure.narrowest(), share: ROUGHING_SHARE },
              }
      // general shapes: the region's width (eroded by the tool radius it is empty) and the
      // smallest inside corner, from the 2D layer
      else
        unfit =
          c.kind === 'rectangle' || c.kind === 'circle'
            ? (wider(2 * inradius(c), 'pocket at its narrowest', 'pocket') ??
              // a corner on or beyond the stock edge is open (DF61 follow-up)
              (c.kind === 'rectangle' && rectangleWallCorner(op.shape.center, c, stock)
                ? corner(c.cornerRadius)
                : undefined))
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
    case 'chamfer': {
      unfit = chamferFit(tool, op)
      if (unfit !== undefined || tool.reach === undefined) return unfit
      // plunged (DC covers the chamfer): the tip ends where the tool cone has the chamfer's Ø
      const tip = tool.tipDiameter ?? 0
      const depth =
        !isLoopChamfer(op) && tool.diameter + TOL >= op.diameter
          ? chamferDepth({ ...op, edgeDiameter: tip }) - op.onZ
          : reachDepth(op, stock)[0]
      return tool.reach + EPSILON >= depth
        ? undefined
        : {
            rule: 'reach',
            detail: `reaches ${mm(tool.reach)}, the operation is ${mm(depth)} deep`,
            values: { reach: tool.reach, depth },
          }
    }
  }
  if (tool.reach === undefined && tool.fluteLength === undefined) return undefined
  const depth = wallDepth(op, stock, unitSystem)
  if (tool.reach !== undefined && tool.reach + EPSILON < depth)
    return {
      rule: 'reach',
      detail: `reaches ${mm(tool.reach)}, the operation is ${mm(depth)} deep`,
      values: { reach: tool.reach, depth },
    }
  return flutesFit(tool, depth)
}

/**
 * The depth a pocket, profile or hole cuts below the stock face of its direction (mm): its
 * `reachDepth`, a through profile with the plan's default breakthrough.
 */
export function wallDepth(
  op: Exclude<Cutting, { kind: 'chamfer' }>,
  stock: StockGeometry,
  unitSystem: 'metric' | 'inch',
): number {
  const [base] = reachDepth(op, stock)
  // a through profile (or a pattern's through pocket, P4) breaks through the far face; a blind
  // groove stops at its depth
  const through =
    (op.kind === 'profile' && op.depth === undefined) ||
    (op.kind === 'pocket' && op.through === true)
  return through ? base + DEFAULT_BREAKTHROUGH[unitSystem] : base
}

/**
 * A chamfer as the fit rule sees it (mm, degrees): a circular one by its edge Ø, chamfer Ø and
 * angle; one along a general edge (edge-chamfers.md E1) by its width and angle.
 */
export type ChamferFitInput =
  | {
      readonly edgeDiameter: number
      readonly diameter: number
      /** Included angle, degrees. */
      readonly angle: number
      /** Stepped (F7): cut in terraces by a flat end mill. */
      readonly stepdown?: number
      readonly width?: never
    }
  | {
      readonly width: number
      readonly angle: number
      readonly edgeDiameter?: never
      readonly stepdown?: never
    }

export { CHAMFER_ANGLE_TOLERANCE, coneSlant }

/**
 * The fit row of a circular chamfer (design-v0.4.md § Chamfer operation, Fit): a `chamferMill`
 * whose angle equals the chamfer's within 0.5°, whose tip is smaller than the edge Ø, and that
 * either covers the chamfer Ø (plunged at the centre) or has a cutting edge (its cone's slant from
 * tip to DC) at least the chamfer's slant height (contoured). First failed rule, or undefined.
 * One ring only: several rings are stepped clearing, not a chamfer pass (design-v0.4.md
 * § Implementation (task C2)). Reach is checked by `toolFit`, which knows the depth below the face.
 */
export function chamferFit(tool: DfmTool, c: ChamferFitInput): ToolUnfit | undefined {
  if (c.edgeDiameter !== undefined && c.stepdown !== undefined) return steppedFit(tool, c)
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
  if (c.edgeDiameter === undefined) {
    // a general edge (edge-chamfers.md § Implementation (E4a)): any cutting edge, DC > dt (a
    // bevel wider than it is cut in levels); no tip rule (the air beside the edge is the
    // finding's business)
    const edge = coneSlant(tip, tool.diameter, tool.angle)
    const slant = coneSlant(0, 2 * c.width, c.angle)
    return tool.diameter - tip > 2 * TOL
      ? undefined
      : {
          rule: 'slant',
          detail: `the tool has no cutting edge (tip Ø${mm(tip)}, DC ${mm(tool.diameter)})`,
          values: { cuttingEdge: edge, slant, toolDiameter: tool.diameter, width: c.width },
        }
  }
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

/**
 * A stepped chamfer (F7, design-v0.4.md § Stepped countersink): a flat end mill smaller than the
 * edge Ø, which goes down inside it (the upper bound of helical boring, so the hole's end mill
 * fits). First failed rule, or undefined; reach as for a contoured chamfer (`toolFit`).
 */
function steppedFit(tool: DfmTool, c: { readonly edgeDiameter: number }): ToolUnfit | undefined {
  if (tool.type !== 'flatEndMill')
    return {
      rule: 'type',
      detail: 'a stepped chamfer needs a flat end mill',
      values: { needs: 'flatEndMill' },
    }
  return tool.diameter < c.edgeDiameter - TOL
    ? undefined
    : {
        rule: 'diameter',
        detail: `Ø${mm(tool.diameter)} is not smaller than the edge Ø${mm(c.edgeDiameter)}`,
        values: { toolDiameter: tool.diameter, edgeDiameter: c.edgeDiameter },
      }
}
