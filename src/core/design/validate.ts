/**
 * Operation constraints (design.md "Constraints" columns): pure parameter checks, run
 * synchronously in every design command. Violations are `model.invariant` issues with parameter
 * paths. DFM warnings (tool library, geometry) are task 2.8.
 * Doc: docs/modes/design.md#operations-v01, docs/modes/design.md#implementation-task-25,
 * docs/modes/design-v0.2.md#dfm-access-checks (limits along the face normal),
 * docs/modes/design-v0.3.md#operations-that-take-a-shape (named shapes, `on`, tab positions)
 */
import { type Issue, issueSummary } from '../../shared/errors/app-error'
import { fail, Ok, type AppResult, type Option } from '../../shared/result'
import type { Direction } from '../geometry/face'
import type { Stock } from '../library/stock'
import type { Quantity } from '../quantity/quantity'
import { Rational } from '../quantity/rational'
import {
  bottomEdgeFace,
  chamferEdgeKind,
  isInlinePath,
  type Point,
  type Operation,
  type Part,
  type RoughingMargins,
  type Shape,
} from './operation'
import { roundRadiusHolds } from './round'
import { circleThrough, INLINE_MIN_LENGTH } from './line-inline'
import type { Vec2 } from '../geometry/model'
import { slotCoversOpening, SurfaceTable, type SurfaceEntry } from './surfaces'

const ZERO = Rational.ZERO
const HALF = Rational.create(1n, 2n).unwrap()
const MIN_POINT_ANGLE = Rational.int(60n)
const MAX_POINT_ANGLE = Rational.int(180n)
/** Chamfer included angle (design-v0.4.md § Chamfer operation). */
const MIN_CHAMFER_ANGLE = Rational.int(60n)
const MAX_CHAMFER_ANGLE = Rational.int(120n)
/** Smallest terrace height of a stepped chamfer, mm (design-v0.4.md § Stepped countersink). */
const MIN_CHAMFER_STEPDOWN = Rational.create(1n, 10n).unwrap()

class Checker {
  readonly issues: Issue[] = []
  check(ok: boolean, path: string, rule: string, message: string, params?: object): void {
    if (!ok)
      this.issues.push({
        path: path.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s)),
        rule,
        message,
        ...(params === undefined ? {} : { params: params as Record<string, unknown> }),
      })
  }
  positive(q: Quantity, path: string): boolean {
    const ok = q.exact.compare(ZERO) > 0
    this.check(ok, path, 'positive', 'must be greater than 0', { actual: q.canonical })
    return ok
  }
}

/**
 * What validation needs of an operation's named shape (placement.ts `shapeFacts`): whether it is
 * an open path (from the definition), and with the 2D port its loop count (pieces + holes) and the
 * length of its loop or path (mm). Without the port only `open` is known; the checks that need the
 * rest are skipped (a plan command re-checking a part has no port).
 */
export interface ShapeFacts {
  readonly open: boolean
  readonly loops?: number
  readonly length?: number
}

/** Facts of the named shapes by operation id. */
export type ShapeFactsTable = ReadonlyMap<string, ShapeFacts>

/** Facts of any shape: v0.1 shapes (rotated too) are one closed loop of a known perimeter. */
function factsOf(op: { id: string; shape: Shape }, table?: ShapeFactsTable): ShapeFacts {
  if (op.shape.kind !== 'named') return { open: false, loops: 1, length: shapePerimeter(op.shape) }
  return table?.get(op.id) ?? { open: false }
}

/**
 * Shape size > 0 and 0 ≤ cornerRadius ≤ min(length, width)/2 (= with Round, `roundRadius`);
 * returns whether it is valid. A named
 * shape's own values are checked by the shape commands (shapes.md).
 */
function checkShape(c: Checker, s: Shape): boolean {
  if (s.kind === 'named') return true
  if (s.kind === 'circle') return c.positive(s.diameter, 'shape.diameter')
  const l = c.positive(s.length, 'shape.length')
  const w = c.positive(s.width, 'shape.width')
  if (!l || !w) return false
  const max = (s.length.exact.compare(s.width.exact) < 0 ? s.length : s.width).exact.mul(HALF)
  const r = s.cornerRadius.exact
  const ok = r.compare(ZERO) >= 0 && r.compare(max) <= 0
  c.check(
    ok,
    'shape.cornerRadius',
    'cornerRadiusRange',
    'must be between 0 and half the narrowest size',
    { min: 0, max: max.toNumber(), actual: s.cornerRadius.canonical },
  )
  // DF120: the commands keep a Round radius derived; this guards hand-edited records
  if (ok && s.round === true) {
    const held = roundRadiusHolds(s.length, s.width, s.cornerRadius)
    c.check(held, 'shape.cornerRadius', 'roundRadius', 'must be half the narrowest size (Round)', {
      expected: max.toNumber(),
      actual: s.cornerRadius.canonical,
    })
    return held
  }
  return ok
}

/**
 * `on.level − depth` must stay above the opposite stock face along the normal (`stock.bottom` on
 * the top face): depth < on's face z + the stock extent along `n`.
 */
function checkAboveBottom(
  c: Checker,
  path: string,
  on: SurfaceEntry,
  depth: Quantity,
  extent: Rational,
) {
  const maxDepth = on.faceZ.add(extent)
  c.check(
    depth.exact.compare(maxDepth) < 0,
    path,
    'aboveStockBottom',
    on.direction === '+z'
      ? 'must end above the stock bottom'
      : 'must end before the opposite stock face',
    { max: maxDepth.toNumber(), actual: depth.canonical },
  )
}

/** "stock thickness" on ±z, else the stock size along the normal (messages). */
const extentName = (d: Direction): string =>
  d === '+z' || d === '-z' ? 'the stock thickness' : 'the stock size along the face normal'

/** Perimeter of a v0.1 shape, rotated or not (float64 mm). */
export function shapePerimeter(s: Exclude<Shape, { kind: 'named' }>): number {
  if (s.kind === 'circle') return Math.PI * s.diameter.canonical
  const r = s.cornerRadius.canonical
  return 2 * (s.length.canonical + s.width.canonical) - 8 * r + 2 * Math.PI * r
}

/**
 * `tabs.positions` (design-v0.3.md#tabs-on-shapes): none on an open path or a blind groove
 * (`tabsNotAllowed`); each within the loop (`tabOutside`, 0 ≤ s < length); no two closer than the
 * tab width around the loop (`tabsOverlap`). Positions need the loop length: skipped without it.
 */
function checkTabPositions(
  c: Checker,
  tabs: { readonly positions: Option<readonly Quantity[]> },
  facts: ShapeFacts,
  blind: boolean,
  width: number,
): void {
  if (tabs.positions.isNone()) return
  const positions = tabs.positions.unwrap()
  if (facts.open || blind) {
    c.check(
      false,
      'tabs.positions',
      'tabsNotAllowed',
      'tabs hold a through cut of a closed loop only',
    )
    return
  }
  const L = facts.length
  if (L === undefined) return
  let inside = true
  positions.forEach((p, i) => {
    const ok = p.canonical >= 0 && p.canonical < L
    inside &&= ok
    c.check(ok, `tabs.positions.${i}`, 'tabOutside', 'must be between 0 and the loop length', {
      min: 0,
      max: L,
      actual: p.canonical,
    })
  })
  if (!inside || positions.length < 2) return
  const sorted = positions.map((p) => p.canonical).sort((a, b) => a - b)
  const gaps = sorted.map((s, i) => (i + 1 < sorted.length ? sorted[i + 1]! : sorted[0]! + L) - s)
  const min = Math.min(...gaps)
  c.check(min >= width, 'tabs.positions', 'tabsOverlap', 'tabs must not overlap along the loop', {
    min: width,
    actual: min,
  })
}

/**
 * DF122: a roughing pass's stock to leave: the wall ≥ 0, the floor ≥ 0 (> 0 for a through
 * profile's skin, `skin`) and under `depth` (none for a through pocket).
 * Doc: docs/modes/roughing.md#stock-to-leave-wall-and-floor
 */
function checkRoughingPass(
  c: Checker,
  pass: RoughingMargins | undefined,
  depth: { readonly exact: Quantity['exact']; readonly canonical: number } | undefined,
  skin = false,
): void {
  if (pass?.wall !== undefined)
    c.check(pass.wall.canonical >= 0, 'roughing.wall', 'nonNegative', 'must be 0 or more', {
      min: 0,
      actual: pass.wall.canonical,
    })
  if (pass?.floor !== undefined)
    c.check(
      (skin ? pass.floor.canonical > 0 : pass.floor.canonical >= 0) &&
        (depth === undefined || pass.floor.exact.compare(depth.exact) < 0),
      'roughing.floor',
      'floorRange',
      skin
        ? 'must be more than 0 (the skin holds the part) and less than the thickness'
        : 'must be 0 or more and less than the depth',
      {
        min: 0,
        ...(depth === undefined ? {} : { max: depth.canonical }),
        actual: pass.floor.canonical,
      },
    )
}

/**
 * Constraint issues of the operation at `index` (its `on` must be a valid target of the stock or
 * an earlier operation).
 */
export function operationIssues(
  ops: readonly Operation[],
  index: number,
  stock: Stock,
  table: SurfaceTable = SurfaceTable.build(ops, stock),
  shapeFacts?: ShapeFactsTable,
): Issue[] {
  const c = new Checker()
  const op = ops[index]!
  // a facing or profile starts from a stock face (design-v0.2.md decision 10)
  const stockOnly = op.kind === 'facing' || op.kind === 'profile'
  const targets = table.before(index).filter((e) => e.onTarget && (!stockOnly || e.owner < 0))
  const on = targets.find((e) => e.id === op.on)
  // DF138 F4: a facing or profile on an earlier floor gets the next step (its stock face and the
  // floor's depth to add)
  const floor = on === undefined ? table.before(index).find((e) => e.id === op.on) : undefined
  const face = floor && targets.find((e) => e.owner < 0 && e.direction === floor.direction)
  const below = floor === undefined ? 0 : Math.round(-floor.faceZ.toNumber() * 1000) / 1000
  c.check(
    on !== undefined,
    'on',
    'onSurface',
    stockOnly
      ? face !== undefined
        ? `must be a stock face (${targets.map((e) => e.id).join(', ')}): a ${op.kind} starts from the stock; use on ${face.id} and add ${op.on}'s depth below it (${below} mm) to depth`
        : `must be a stock face (${targets.map((e) => e.id).join(', ')})`
      : 'must be a stock face or a floor or tab top of an earlier operation',
    { allowed: targets.map((e) => e.id), actual: op.on },
  )
  const direction = on?.direction ?? '+z'
  /** Stock extent along the normal of `on` (the thickness on the top face). */
  const T = { exact: table.extent(direction), canonical: table.extent(direction).toNumber() }
  switch (op.kind) {
    case 'facing':
      if (c.positive(op.depth, 'depth'))
        c.check(
          op.depth.exact.compare(T.exact) < 0,
          'depth',
          'lessThanStockThickness',
          `must be less than ${extentName(direction)}`,
          { max: T.canonical, actual: op.depth.canonical },
        )
      break
    case 'pocket': {
      checkShape(c, op.shape)
      c.check(
        !factsOf(op, shapeFacts).open,
        'shape',
        'openNeedsOn',
        'an open path needs a profile on',
      )
      const depthOk = c.positive(op.depth, 'depth')
      // a through pocket (patterns P4) goes through the opposite face by definition
      if (depthOk && on !== undefined && op.through !== true)
        checkAboveBottom(c, 'depth', on, op.depth, T.exact)
      // DF122: a roughing pass's stock to leave: ≥ 0, the floor's under the depth (roughing.md)
      checkRoughingPass(c, op.roughingPass, op.through === true ? undefined : op.depth)
      const f = op.floorRadius.exact
      if (op.shape.kind === 'named') {
        // a named shape's corners are its own: the floor fillet waits for G1 (design-v0.3.md)
        c.check(
          f.compare(ZERO) === 0,
          'floorRadius',
          'floorRadiusShape',
          'must be 0 for a named shape',
          {
            max: 0,
            actual: op.floorRadius.canonical,
          },
        )
        break
      }
      const limits = [op.depth.exact]
      limits.push(
        op.shape.kind === 'circle'
          ? op.shape.diameter.exact.mul(HALF)
          : op.shape.cornerRadius.exact,
      )
      const max = limits.reduce((a, b) => (a.compare(b) < 0 ? a : b))
      c.check(
        f.compare(ZERO) >= 0 && f.compare(max) <= 0,
        'floorRadius',
        'floorRadiusRange',
        op.shape.kind === 'circle'
          ? 'must be between 0 and the smaller of depth and diameter/2'
          : 'must be between 0 and the smaller of depth and cornerRadius',
        { min: 0, max: max.toNumber(), actual: op.floorRadius.canonical },
      )
      break
    }
    case 'drilling': {
      c.positive(op.diameter, 'diameter')
      const usesDepth = op.bottom !== 'through'
      c.check(
        usesDepth === op.depth.isSome(),
        'depth',
        usesDepth ? 'required' : 'notForBottom',
        usesDepth ? `is required for a ${op.bottom} bottom` : 'is not used for a through hole',
      )
      if (usesDepth && op.depth.isSome()) {
        const depth = op.depth.unwrap()
        if (c.positive(depth, 'depth') && on !== undefined)
          checkAboveBottom(c, 'depth', on, depth, T.exact)
      }
      const point = op.bottom === 'drillPoint'
      c.check(
        point === op.pointAngle.isSome(),
        'pointAngle',
        point ? 'required' : 'notForBottom',
        point ? 'is required for a drillPoint bottom' : 'is only used for a drillPoint bottom',
      )
      if (point && op.pointAngle.isSome()) {
        const a = op.pointAngle.unwrap()
        c.check(
          a.exact.compare(MIN_POINT_ANGLE) >= 0 && a.exact.compare(MAX_POINT_ANGLE) <= 0,
          'pointAngle',
          'range',
          'must be between 60° and 180°',
          { min: 60, max: 180, actual: a.canonical },
        )
      }
      break
    }
    case 'profile': {
      const shapeOk = checkShape(c, op.shape)
      const facts = factsOf(op, shapeFacts)
      c.positive(op.slotWidth, 'slotWidth')
      const on = op.side === 'on'
      c.check(on || !facts.open, 'side', 'openNeedsOn', 'an open path is cut on its line', {
        allowed: ['on'],
      })
      c.check(
        facts.loops === undefined || facts.loops === 1,
        'shape',
        'profileOneLoop',
        'a profile cuts one loop: use a pocket for a shape with holes or several pieces',
        { actual: facts.loops },
      )
      const blind = op.depth.isSome()
      if (blind) {
        // any side may stop at a depth: a blind groove (`on`) or a step (DF53,
        // docs/modes/design-v0.3.md#steps-blind-side-profiles-df53)
        const depth = op.depth.unwrap()
        if (c.positive(depth, 'depth'))
          c.check(
            depth.exact.compare(T.exact) < 0,
            'depth',
            'lessThanStockThickness',
            `must be less than ${extentName(direction)}`,
            { max: T.canonical, actual: depth.canonical },
          )
      }
      checkTabPositions(c, op.tabs, facts, blind, op.tabs.width.canonical)
      // DF122 R4: roughing for inside/outside profiles (a groove is the tool's width); a through
      // profile's floor margin (its skin) under the stock extent
      if (op.roughingPass !== undefined) {
        c.check(!on, 'roughing', 'notForGroove', 'roughing is for inside and outside profiles', {
          allowed: ['inside', 'outside'],
        })
        checkRoughingPass(
          c,
          op.roughingPass,
          op.depth.isSome() ? op.depth.unwrap() : T,
          op.depth.isNone(),
        )
      }
      const count = op.tabs.count
      const integer = count.exact.den === 1n
      c.check(integer, 'tabs.count', 'integer', 'must be a whole number', {
        actual: count.canonical,
      })
      c.check(count.exact.compare(ZERO) >= 0, 'tabs.count', 'nonNegative', 'must be 0 or more', {
        actual: count.canonical,
      })
      // no tabs are built when an inside slot covers the opening, so their width cannot conflict
      if (
        c.positive(op.tabs.width, 'tabs.width') &&
        shapeOk &&
        integer &&
        count.canonical > 0 &&
        op.tabs.positions.isNone() &&
        !blind &&
        !facts.open &&
        facts.length !== undefined &&
        !slotCoversOpening(op)
      ) {
        const perimeter = facts.length
        c.check(
          count.canonical * op.tabs.width.canonical < perimeter,
          'tabs.width',
          'tabsFit',
          'all tabs must fit on the perimeter',
          { max: perimeter / count.canonical, actual: op.tabs.width.canonical },
        )
      }
      if (c.positive(op.tabs.thickness, 'tabs.thickness'))
        c.check(
          op.tabs.thickness.exact.compare(T.exact) < 0,
          'tabs.thickness',
          'lessThanStockThickness',
          `must be less than ${extentName(direction)}`,
          { max: T.canonical, actual: op.tabs.thickness.canonical },
        )
      break
    }
    case 'line': {
      // every depth > 0 and above the stock's far face (engraved-patterns.md § Line operation)
      const depths: [string, Quantity][] =
        op.depth.kind === 'through'
          ? []
          : op.depth.kind === 'constant'
            ? [['depth', op.depth.depth]]
            : op.depth.kind === 'ramp'
              ? [
                  ['depth.start', op.depth.start],
                  ['depth.end', op.depth.end],
                ]
              : [
                  ['depth.min', op.depth.min],
                  ['depth.max', op.depth.max],
                ]
      for (const [path, q] of depths)
        if (c.positive(q, path) && on !== undefined) checkAboveBottom(c, path, on, q, T.exact)
      // E2: level 0 is `min`, level 1 `max`; a blend is a length ≥ 0
      if (op.depth.kind === 'levels')
        c.check(
          op.depth.min.exact.compare(op.depth.max.exact) <= 0,
          'depth.min',
          'minAboveMax',
          'must not be deeper than max',
          { min: op.depth.min.canonical, max: op.depth.max.canonical },
        )
      if (op.blend.isSome())
        c.check(
          op.blend.unwrap().exact.compare(ZERO) >= 0,
          'blend',
          'nonNegative',
          'must be 0 or more',
          {
            actual: op.blend.unwrap().canonical,
          },
        )
      // DF147 SL3: a through Line is one open Straight / Arc (a closed or many-line cut-out is a
      // Profile with tabs, engraved-patterns.md § Cutting the part out along a line)
      if (op.depth.kind === 'through')
        c.check(
          op.paths.length === 1 && isInlinePath(op.paths[0]!),
          'depth',
          'lineThroughPath',
          'a through Line is one straight line or arc; cut a shape out with a Profile',
        )
      for (const [i, p] of op.paths.entries()) {
        if (isInlinePath(p)) {
          // DF147 SL2: an inline Straight / Arc is the Line's only path, not a point, not a line
          c.check(
            op.paths.length === 1,
            `paths.${i}`,
            'inlineAlone',
            'a straight line or arc is the only path of its Line',
          )
          const pt = (q: Point): Vec2 => [q[0].canonical, q[1].canonical]
          const s = pt(p.start)
          const e = pt(p.end)
          const long = Math.hypot(e[0] - s[0], e[1] - s[1]) >= INLINE_MIN_LENGTH
          c.check(
            long,
            `paths.${i}.${p.kind}.end`,
            'lineTooShort',
            `must be at least ${INLINE_MIN_LENGTH} mm from the start`,
          )
          if (long && p.kind === 'arc')
            c.check(
              circleThrough(s, pt(p.through), e) !== undefined,
              `paths.${i}.arc.through`,
              'arcCollinear',
              'must lie off the straight line from start to end',
            )
          continue
        }
        if (p.scale !== undefined)
          c.check(p.scale > 0, `paths.${i}.scale`, 'positive', 'must be greater than 0', {
            actual: p.scale,
          })
      }
      break
    }
    case 'chamfer': {
      const edge = ops.slice(0, index).find((o) => o.id === op.edgeOf)
      const edgeKind = chamferEdgeKind(edge)
      c.check(
        edgeKind !== undefined,
        'edgeOf',
        'chamferEdge',
        `must be an earlier drilling, pocket, outside/inside profile or through Line${chamferEdgeWhyNot(edge)}`,
        { actual: op.edgeOf },
      )
      // DF147 SL4: a through Line's chamfer bevels the wall on the side that stays only
      if (edgeKind === 'wall') {
        c.check(
          op.edgeSide.isSome(),
          'edgeSide',
          'chamferSide',
          'pick the side that stays (left or right of the line, from its start to its end)',
        )
        c.check(op.loops.isNone(), 'loops', 'chamferLoops', 'a line has no loops')
        c.check(!op.cornerLift, 'cornerLift', 'chamferLift', 'a line has no corners')
      } else
        c.check(
          op.edgeSide.isNone(),
          'edgeSide',
          'chamferSide',
          'only a through Line has a side that stays',
        )
      // F7 terraces stay circular (edge-chamfers.md § Model)
      if (edgeKind === 'loop' || edgeKind === 'wall')
        c.check(
          op.stepdown.isNone(),
          'stepdown',
          'chamferStepped',
          'a stepped chamfer needs a circular edge',
        )
      // E4a: chosen loops and the corner lift are for a general edge only
      if (edgeKind === 'circle') {
        c.check(op.loops.isNone(), 'loops', 'chamferLoops', 'a circular edge has one loop')
        c.check(!op.cornerLift, 'cornerLift', 'chamferLift', 'a circular edge has no corners')
      }
      if (
        edgeKind === 'loop' &&
        op.loops.isSome() &&
        (edge?.kind === 'pocket' || edge?.kind === 'profile')
      ) {
        const count =
          edge.kind === 'profile' && edge.side === 'outside' ? 1 : factsOf(edge, shapeFacts).loops
        const loops = op.loops.unwrap()
        if (count !== undefined)
          c.check(
            loops.every((i) => i < count),
            'loops',
            'chamferLoops',
            `must be loop indices 0 to ${count - 1} of ${edge.name}`,
            { max: count - 1, actual: Math.max(...loops) },
          )
      }
      if (edge !== undefined) {
        // E4b: a through profile's bottom edge from the opposite stock face (a flipped setup)
        const bottom = bottomEdgeFace(edge)
        c.check(
          edge.on === op.on || op.on === bottom,
          'on',
          'chamferOn',
          bottom === undefined
            ? `must be the face of ${edge.name}`
            : `must be the face of ${edge.name} or, for its bottom edge, ${bottom}`,
          {
            allowed: bottom === undefined ? [edge.on] : [edge.on, bottom],
            actual: op.on,
            edgeOf: edge.id,
          },
        )
      }
      c.positive(op.width, 'width')
      c.check(
        op.angle.exact.compare(MIN_CHAMFER_ANGLE) >= 0 &&
          op.angle.exact.compare(MAX_CHAMFER_ANGLE) <= 0,
        'angle',
        'range',
        'must be between 60° and 120°',
        { min: 60, max: 120, actual: op.angle.canonical },
      )
      if (op.stepdown.isSome())
        c.check(
          op.stepdown.unwrap().exact.compare(MIN_CHAMFER_STEPDOWN) >= 0,
          'stepdown',
          'range',
          'must be at least 0.1 mm',
          { min: 0.1, actual: op.stepdown.unwrap().canonical },
        )
      break
    }
  }
  return c.issues
}

/**
 * Constraints of every operation. Issues of `edited` keep their parameter paths (the form being
 * edited); the others are prefixed `operations.<id>`, so a dependant broken by a recalculation is
 * named. Own issues come first.
 */
export function checkOperations(
  ops: readonly Operation[],
  stock: Stock,
  edited?: string,
  shapeFacts?: ShapeFactsTable,
  shapes?: Part['shapes'],
): AppResult<void> {
  const table = SurfaceTable.build(ops, stock, shapes)
  const own: Issue[] = []
  const others: Issue[] = []
  ops.forEach((op, i) => {
    const issues = operationIssues(ops, i, stock, table, shapeFacts)
    if (op.id === edited) own.push(...issues)
    else others.push(...issues.map((is) => ({ ...is, path: ['operations', op.id, ...is.path] })))
  })
  const issues = [...own, ...others]
  if (issues.length === 0) return Ok(undefined)
  return fail('model.invariant', issueSummary(issues), {
    issues,
    where: 'checkOperations',
  })
}

/**
 * Why `edge` cannot take a chamfer, as a suffix of the `chamferEdge` message
 * (edge-chamfers.md § Agent API): empty when it is missing or not earlier.
 */
function chamferEdgeWhyNot(edge: Operation | undefined): string {
  if (edge?.kind === 'facing') return ' (a facing has no edge)'
  if (edge?.kind === 'chamfer') return ' (not another chamfer)'
  if (edge?.kind === 'profile' && edge.side === 'on')
    return ' (an "on" profile cuts a groove with two edges: not yet)'
  if (edge?.kind === 'line') return ' (a Line with depth Through only)'
  return ''
}
