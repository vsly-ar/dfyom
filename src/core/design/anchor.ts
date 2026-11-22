/**
 * Placement anchors: which of the nine points of a shape's bounding rectangle (face frame) its
 * `center` gives, the geometric centre that follows, and re-anchoring without moving the feature.
 * Doc: docs/modes/design-v0.2.md#placement-anchors, docs/modes/design-v0.2.md#implementation-task-a2
 *
 * Size edits keep the anchor point fixed for free: `center` is stored as the anchor point and the
 * geometric centre is derived from it and the current size (`shapeCentre`).
 */
import type { Issue } from '../../shared/errors/app-error'
import { fail, Ok, type AppResult } from '../../shared/result'
import { parseLiteral, type ParseContext } from '../quantity/parse'
import { Quantity } from '../quantity/quantity'
import { Rational } from '../quantity/rational'
import { UNITS } from '../quantity/units'
import type { Anchor, Point, Shape } from './operation'
import type { AnchorPoint } from './part.dto'

const HALF = Rational.create(1n, 2n).unwrap()
/** Most decimals written into a shifted literal's source (the exact value stays exact). */
const MAX_DIGITS = 6

/** Size of a bounding rectangle along `u` and `v` (exact, canonical mm). */
export type Extents = readonly [Rational, Rational]

/**
 * Size of the bounding rectangle along `u` and `v` (a circle: its bounding square). A general
 * shape (a named or rotated one, `isGeneralShape`) has no exact size: its placed box comes from
 * the 2D layer (`placeShape`, `exactExtents`) and is passed in as `extents`.
 */
function size(s: Shape, extents?: Extents): Extents {
  if (extents !== undefined) return extents
  if (s.kind === 'circle') return [s.diameter.exact, s.diameter.exact]
  if (s.kind === 'rectangle') return [s.length.exact, s.width.exact]
  // unreachable for callers that follow the rule above; a zero box keeps the point as is
  return [Rational.ZERO, Rational.ZERO]
}

function axisOffset(p: AnchorPoint, extent: Rational): Rational {
  const half = extent.mul(HALF)
  return p === 'min' ? half.neg() : p === 'max' ? half : Rational.ZERO
}

/** Offset of the anchor point from the geometric centre, `[u, v]` (exact, canonical mm). */
export function anchorOffset(
  s: Shape,
  anchor: Anchor = s.anchor,
  extents?: Extents,
): readonly [Rational, Rational] {
  const [su, sv] = size(s, extents)
  return [axisOffset(anchor.u, su), axisOffset(anchor.v, sv)]
}

/**
 * Geometric centre `[u, v]` of an axis-aligned shape (float64 mm): the anchor point minus its
 * offset. General shapes take theirs from `placeShape`.
 */
export function shapeCentre(s: Shape): readonly [number, number] {
  const [du, dv] = anchorOffset(s)
  return [s.center[0].exact.sub(du).toNumber(), s.center[1].exact.sub(dv).toNumber()]
}

export const sameAnchor = (a: Anchor, b: Anchor): boolean => a.u === b.u && a.v === b.v

const contextOf = (q: Quantity): ParseContext => ({ kind: q.kind, defaultUnit: q.defaultUnit })

/** True if the quantity was entered as a formula (not a literal). */
export function isExpression(q: Quantity): boolean {
  return parseLiteral(q.source, contextOf(q)).isErr()
}

/**
 * A literal moved by `delta` (canonical): the number in the source is replaced in the unit it is
 * written in, so unit and tolerance stay as typed (as the field's steppers do).
 */
function shiftLiteral(q: Quantity, delta: Rational): AppResult<Quantity> {
  const literal = parseLiteral(q.source, contextOf(q))
  if (literal.isErr()) return literal
  const { start, end, value, unit } = literal.unwrap().nominal
  const inUnit = delta.div(UNITS[unit.unwrapOr(q.defaultUnit)].factor)
  if (inUnit.isErr()) return inUnit
  const next = value.add(inUnit.unwrap())
  const written = q.source.slice(start, end)
  const point = written.indexOf('.')
  const writtenDigits = point < 0 ? 0 : written.length - point - 1
  const digits = Math.max(writtenDigits, next.decimalDigits(MAX_DIGITS).unwrapOr(MAX_DIGITS))
  return Quantity.create({
    kind: q.kind,
    source: q.source.slice(0, start) + next.toFixed(digits) + q.source.slice(end),
    defaultUnit: q.defaultUnit,
    exact: q.exact.add(delta),
    tolerance: q.tolerance,
  })
}

/**
 * The shape with anchor `to` and its `center` moved so the feature stays where it is
 * (design-v0.2.md: changing the anchor keeps the geometry). A coordinate that has to move but is
 * a formula fails with `model.invariant`, rule `anchorExpression` (path `anchor`); one that does
 * not move may stay a formula.
 */
export function reanchor(s: Shape, to: Anchor, extents?: Extents): AppResult<Shape> {
  if (sameAnchor(s.anchor, to)) return Ok(s)
  const from = anchorOffset(s, s.anchor, extents)
  const next = anchorOffset(s, to, extents)
  const issues: Issue[] = []
  const coords: Quantity[] = []
  for (const i of [0, 1] as const) {
    const c = s.center[i]
    const delta = next[i].sub(from[i])
    if (delta.equals(Rational.ZERO)) {
      coords.push(c)
      continue
    }
    const parameter = `shape.center.${i}`
    if (isExpression(c)) {
      issues.push({
        path: ['anchor'],
        rule: 'anchorExpression',
        message: `${parameter} is a formula: remove it to change the anchor`,
        params: { parameter },
      })
      continue
    }
    const shifted = shiftLiteral(c, delta)
    if (shifted.isErr()) return shifted.mapErr((e) => e.prefixIssues('shape', 'center', i))
    coords.push(shifted.unwrap())
  }
  if (issues.length > 0)
    return fail('model.invariant', 'the position is a formula', { issues, where: 'reanchor' })
  const center: Point = [coords[0]!, coords[1]!]
  return Ok({ ...s, center, anchor: to })
}
