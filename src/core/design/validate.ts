/**
 * Operation constraints (design.md "Constraints" columns): pure parameter checks, run
 * synchronously in every design command. Violations are `model.invariant` issues with parameter
 * paths. DFM warnings (tool library, geometry) are task 2.8.
 * Doc: docs/modes/design.md#operations-v01, docs/modes/design.md#implementation-task-25,
 * docs/modes/design-v0.2.md#dfm-access-checks (limits along the face normal)
 */
import type { Issue } from '../../shared/errors/app-error'
import { fail, Ok, type AppResult } from '../../shared/result'
import type { Direction } from '../geometry/face'
import type { Stock } from '../library/stock'
import type { Quantity } from '../quantity/quantity'
import { Rational } from '../quantity/rational'
import type { Operation, Shape } from './operation'
import { slotCoversOpening, SurfaceTable, type SurfaceEntry } from './surfaces'

const ZERO = Rational.ZERO
const HALF = Rational.create(1n, 2n).unwrap()
const MIN_POINT_ANGLE = Rational.int(60n)
const MAX_POINT_ANGLE = Rational.int(180n)

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

/** Shape size > 0 and 0 ≤ cornerRadius ≤ min(length, width)/2; returns whether it is valid. */
function checkShape(c: Checker, s: Shape): boolean {
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

/** Perimeter of a v0.1 shape (float64 mm). */
export function shapePerimeter(s: Shape): number {
  if (s.kind === 'circle') return Math.PI * s.diameter.canonical
  const r = s.cornerRadius.canonical
  return 2 * (s.length.canonical + s.width.canonical) - 8 * r + 2 * Math.PI * r
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
): Issue[] {
  const c = new Checker()
  const op = ops[index]!
  // a facing or profile starts from a stock face (design-v0.2.md decision 10)
  const stockOnly = op.kind === 'facing' || op.kind === 'profile'
  const targets = table.before(index).filter((e) => e.onTarget && (!stockOnly || e.owner < 0))
  const on = targets.find((e) => e.id === op.on)
  c.check(
    on !== undefined,
    'on',
    'onSurface',
    stockOnly
      ? 'must be a stock face'
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
      const depthOk = c.positive(op.depth, 'depth')
      if (depthOk && on !== undefined) checkAboveBottom(c, 'depth', on, op.depth, T.exact)
      const f = op.floorRadius.exact
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
      c.positive(op.slotWidth, 'slotWidth')
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
        !slotCoversOpening(op)
      ) {
        const perimeter = shapePerimeter(op.shape)
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
): AppResult<void> {
  const table = SurfaceTable.build(ops, stock)
  const own: Issue[] = []
  const others: Issue[] = []
  ops.forEach((op, i) => {
    const issues = operationIssues(ops, i, stock, table)
    if (op.id === edited) own.push(...issues)
    else others.push(...issues.map((is) => ({ ...is, path: ['operations', op.id, ...is.path] })))
  })
  const issues = [...own, ...others]
  if (issues.length === 0) return Ok(undefined)
  return fail('model.invariant', `${issues.length} invalid value(s)`, {
    issues,
    where: 'checkOperations',
  })
}
