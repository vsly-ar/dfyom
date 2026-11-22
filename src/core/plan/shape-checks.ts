/**
 * Tool checks of general shapes (v0.3 T3): the width rules of the v0.1 table ("wider than the
 * pocket / opening") use the region's width – the region offset inward by the tool radius is not
 * empty – and the smallest inside corner is a warning (the corner keeps the tool radius). The
 * helix check uses the region's narrowest width. They need the 2D port, so they run where the plan
 * has one (`planFindings`, `planOperationInputs`, tool suggestion and resolution in commands).
 * Doc: docs/modes/plan-v0.3.md#plan-side, docs/architecture/shapes.md#implementation-k4
 */
import { isGeneralShape, type Operation, type Part } from '../design/operation'
import { placeShape } from '../design/placement'
import type { Region2dPort } from '../geometry/2d/port'
import type { OperationGeometry } from '../geometry/model'
import { FIT_SLACK, shapeMeasure, type ShapeMeasure } from '../geometry/shape-measure'
import type { Tool } from '../library/tool'
import type { PlanWarning } from './checks'
import type { ResolvedStrategy } from './strategy'

/** Corner radii compare as the v0.2 tool rules: a corner fits when r ≥ R − 0.01 mm. */
const CORNER_TOLERANCE = 0.01
const EPS = 1e-9

/** Rounded for messages (params keep the exact value). */
const mm = (v: number): string => String(Math.round(v * 1000) / 1000)

export type ShapeFinding = Omit<PlanWarning, 'code' | 'planOperationId'>

/**
 * The measures of a pocket or an `inside` / `outside` profile of a general shape (named, or a
 * rotated rectangle), or undefined (v0.1 shapes, `on` grooves, a shape that does not place: the
 * part checks report that). Measured in the shape's frame, so the placement does not matter.
 */
export function generalShapeMeasure(
  op: Operation,
  part: Part,
  port: Region2dPort,
): ShapeMeasure | undefined {
  if (op.kind !== 'pocket' && op.kind !== 'profile') return undefined
  if (!isGeneralShape(op.shape)) return undefined
  if (op.kind === 'profile' && op.side === 'on') return undefined
  const placed = placeShape(port, op.shape, part.shapes)
  if (placed.isErr()) return undefined
  const { outline, centre } = placed.unwrap()
  const shape = {
    center: centre,
    contour:
      outline.kind === 'region'
        ? ({ kind: 'region', region: outline.region } as const)
        : ({ kind: 'path', path: outline.path } as const),
  }
  // only the fields the measure reads (kind, side, shape)
  const geometry: OperationGeometry =
    op.kind === 'pocket'
      ? { kind: 'pocket', id: op.id, onZ: 0, shape, depth: 0, floorRadius: 0 }
      : {
          kind: 'profile',
          id: op.id,
          shape,
          side: op.side,
          slotWidth: op.slotWidth.canonical,
          tabs: { count: 0, width: 0, thickness: 0 },
        }
  return shapeMeasure(port, geometry)
}

export interface ShapeCheckInput {
  readonly ops: readonly Operation[]
  readonly part: Part
  readonly tool: Tool
  readonly strategy: ResolvedStrategy
  /** The plan operation sets `helixDiameter` itself (the v0.1 helix check runs only then). */
  readonly helixSet: boolean
}

/**
 * The width, corner and helix checks of general shapes for one plan operation. Width and helix
 * findings are `plan.check` errors (generation would fail with `toolTooLarge` anyway); a corner
 * below the tool radius is a `plan.check` warning that never blocks.
 */
export function shapeToolFindings(i: ShapeCheckInput, port: Region2dPort): ShapeFinding[] {
  const out: ShapeFinding[] = []
  const D = i.tool.diameter.canonical
  const R = D / 2
  for (const op of i.ops) {
    const m = generalShapeMeasure(op, i.part, port)
    if (m === undefined) continue
    const opening = m.side === 'inside'
    if (m.side !== 'outside' && !m.fits(R - FIT_SLACK)) {
      const width = m.narrowest()
      out.push({
        severity: 'error',
        field: 'tool',
        rule: opening ? 'openingSize' : 'pocketSize',
        message: `tool diameter must fit the ${opening ? 'opening' : 'pocket'} of ${op.id} (${mm(width)} mm at its widest)`,
        params: { operation: op.id, diameter: D, [opening ? 'opening' : 'pocket']: width },
      })
      continue
    }
    // rotated rectangles keep the v0.1 corner rule (an error); named shapes warn
    if (
      'shape' in op &&
      op.shape.kind === 'named' &&
      m.smallestCornerRadius < R - CORNER_TOLERANCE
    ) {
      const corner = m.smallestCornerRadius
      out.push({
        severity: 'warning',
        field: 'tool',
        rule: 'cornerRadius',
        message: `tool radius ${mm(R)} mm is above the smallest inside corner of ${op.id} (${corner === 0 ? 'sharp' : `${mm(corner)} mm`}): that corner keeps the tool radius`,
        params: { operation: op.id, radius: R, cornerRadius: corner },
      })
    }
    if (
      op.kind === 'pocket' &&
      i.helixSet &&
      i.strategy.kind === 'pocket' &&
      i.strategy.entry === 'helix'
    ) {
      const narrowest = m.narrowest()
      if (i.strategy.helixDiameter + D > narrowest + EPS)
        out.push({
          severity: 'error',
          field: 'strategy.helixDiameter',
          rule: 'fits',
          message: 'helix diameter + D must fit the narrowest pocket size',
          params: { max: narrowest - D },
        })
    }
  }
  return out
}
