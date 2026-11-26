/**
 * Importer output → shape items (task I1): each loop or open path of an `SvgShape` becomes one
 * `path` item of `line` and `arc` segments, quantities written as literal mm sources rounded to
 * 1 nm (exact rationals, so the shape stores what the source says).
 * Doc: docs/modes/design-v0.3.md#svg-import, docs/architecture/shapes.md#implementation-i1-command
 *
 * The importer chains elements exactly and keeps arcs ≤ 180°, none shorter than
 * `MIN_ELEMENT_LENGTH`; rounding every point the same way keeps the chain closed, and an arc's
 * radius is never rounded below half its rounded chord (`arcRadius`).
 */
import { collect, Err, fail, Ok, type AppResult } from '../../shared/result'
import { arcSweep, type Element } from '../geometry/2d/model'
import type { Vec2 } from '../geometry/model'
import type { SvgShape } from '../import/svg'
import type { UnitSystem } from '../project/document'
import { Quantity } from '../quantity/quantity'
import { fieldContext } from './operation'
import { mapItem } from './shape'
import { SHAPE_ITEMS_MAX, type ShapeItem, type ShapePoint, type ShapeSegment } from './shape.dto'

/** Decimals of the mm sources (1 nm, far below `POSITION_EPSILON`). */
const DECIMALS = 6
const SCALE = 10 ** DECIMALS

const round = (v: number): number => {
  const r = Math.round(v * SCALE) / SCALE
  return r === 0 ? 0 : r
}

function mmSource(v: number, units: UnitSystem): string {
  const fixed = v.toFixed(DECIMALS)
  const t = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
  const s = t === '-0' ? '0' : t
  return units === 'mm' ? s : `${s} mm`
}

/** Builds quantities from mm values, one parse per distinct source. */
function quantities(units: UnitSystem) {
  const cache = new Map<string, AppResult<Quantity>>()
  const context = fieldContext('length', units)
  return (mm: number): AppResult<Quantity> => {
    const src = mmSource(mm, units)
    let q = cache.get(src)
    if (q === undefined) {
      q = Quantity.parse(src, context)
      cache.set(src, q)
    }
    return q
  }
}

/** One importer item → one `path` item (quantities in mm). */
function pathItem(
  elements: readonly Element[],
  op: 'add' | 'subtract',
  closed: boolean,
): ShapeItem<number> {
  const pt = (p: Vec2): ShapePoint<number> => [round(p[0]), round(p[1])]
  const segments: ShapeSegment<number>[] = elements.map((e) => {
    const to = pt(e.b)
    if (e.kind === 'line') return { kind: 'line', to }
    const a = pt(e.a)
    const half = Math.hypot(to[0] - a[0], to[1] - a[1]) / 2
    const r = round(Math.hypot(e.a[0] - e.centre[0], e.a[1] - e.centre[1]))
    // never below half the rounded chord: up to 1 nm larger for a half circle
    const radius = r >= half ? r : Math.ceil(half * SCALE) / SCALE
    const large = Math.abs(arcSweep(e)) > Math.PI
    return { kind: 'arc', to, radius, cw: !e.ccw, ...(large ? { large } : {}) }
  })
  return { kind: 'path', op, start: pt(elements[0]!.a), segments, closed }
}

function toQuantities(
  item: ShapeItem<number>,
  q: (mm: number) => AppResult<Quantity>,
): AppResult<ShapeItem<Quantity>> {
  let bad: AppResult<never> | undefined
  const out = mapItem(item, (mm) => {
    const r = q(mm)
    if (r.isErr()) bad ??= Err(r.unwrapErr())
    return r.unwrapOr(undefined as unknown as Quantity)
  })
  return bad ?? Ok(out)
}

/**
 * The items of an imported shape, in the importer's order (loops by decreasing area, so the
 * first one adds). More than `SHAPE_ITEMS_MAX` loops in one shape is `input.malformed`
 * (`svgLimit`): import with `split: 'loop'` instead.
 */
export function svgShapeItems(s: SvgShape, units: UnitSystem): AppResult<ShapeItem<Quantity>[]> {
  if (s.items.length > SHAPE_ITEMS_MAX)
    return fail('input.malformed', `${s.name}: more than ${SHAPE_ITEMS_MAX} loops in one shape`, {
      issues: [
        {
          path: ['split'],
          rule: 'svgLimit',
          message: `a shape holds at most ${SHAPE_ITEMS_MAX} items; try split: loop`,
          params: { limit: SHAPE_ITEMS_MAX, actual: s.items.length },
        },
      ],
    })
  const q = quantities(units)
  // E2: the importer's levels are kept on the items (level 1, the default, is left out)
  const withLevels = (
    item: ShapeItem<number>,
    levels: number | readonly number[] | undefined,
  ): ShapeItem<number> =>
    item.kind !== 'path' || levels === undefined || levels === 1
      ? item
      : { ...item, levels: typeof levels === 'number' ? levels : [...levels] }
  const items = s.items.map((it) =>
    it.kind === 'loop'
      ? toQuantities(withLevels(pathItem(it.loop.elements, it.op, true), it.level), q)
      : toQuantities(withLevels(pathItem(it.path.elements, 'add', false), it.levels), q),
  )
  const all = collect(items)
  return all.isErr() ? Err(all.unwrapErr().withContext('svgShapeItems', { shape: s.name })) : all
}

/**
 * The items of a shape made from a reference section (DF60 `design.shape.import { from }`): a
 * fitted circle becomes a `circle` item, any other loop a closed `path`; `op` as given, in order.
 */
export function sectionShapeItems(
  loops: readonly {
    readonly loop: { readonly elements: readonly Element[] }
    readonly op: 'add' | 'subtract'
    readonly circle?: { readonly centre: Vec2; readonly diameter: number }
  }[],
  units: UnitSystem,
): AppResult<ShapeItem<Quantity>[]> {
  if (loops.length > SHAPE_ITEMS_MAX)
    return fail('input.malformed', `more than ${SHAPE_ITEMS_MAX} loops in one shape`, {
      issues: [
        {
          path: ['split'],
          rule: 'sectionLimit',
          message: `a shape holds at most ${SHAPE_ITEMS_MAX} items; try split: loop`,
          params: { limit: SHAPE_ITEMS_MAX, actual: loops.length },
        },
      ],
    })
  const q = quantities(units)
  return collect(
    loops.map((l) =>
      l.circle !== undefined
        ? toQuantities(
            {
              kind: 'circle',
              op: l.op,
              center: [round(l.circle.centre[0]), round(l.circle.centre[1])],
              diameter: round(l.circle.diameter),
            },
            q,
          )
        : toQuantities(pathItem(l.loop.elements, l.op, true), q),
    ),
  )
}
