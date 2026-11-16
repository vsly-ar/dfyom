/**
 * Quantity: an immutable invariant model for every dimensional input.
 * Doc: docs/architecture/quantities.md (Value, Kinds and units, Literal grammar, Tolerance,
 * Persistence). Expressions are task 2.2 and live in src/core/expression/.
 *
 * The exact rational is the single source of truth; `source` is display only and is never
 * re-parsed on load (docs/architecture/quantities.md#value, "Lifecycle").
 */
import { construct, invariants } from '../../shared/model'
import { collect, ctx, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import { MAX_SOURCE_LENGTH, parseLiteral, type ParseContext } from './parse'
import type { QuantityDTO } from './quantity.dto'
import { Rational } from './rational'
import { Tolerance } from './tolerance'
import { UNITS, type QuantityKind, type UnitId } from './units'

export type { ParseContext } from './parse'

export interface QuantityProps {
  readonly kind: QuantityKind
  /** As entered; display only. */
  readonly source: string
  /** Unit a bare number meant at entry; must belong to `kind`. */
  readonly defaultUnit: UnitId
  /** Canonical unit of `kind`. */
  readonly exact: Rational
  /** Explicit tolerance only; None = general tolerance applies (resolved by the design model). */
  readonly tolerance: Option<Tolerance>
}

export class Quantity {
  /** Nearest float64 to `exact` (canonical unit): for geometry and toolpaths, never for equality. */
  readonly canonical: number

  private constructor(
    readonly kind: QuantityKind,
    readonly source: string,
    readonly defaultUnit: UnitId,
    readonly exact: Rational,
    readonly tolerance: Option<Tolerance>,
  ) {
    this.canonical = exact.toNumber()
    invariants('Quantity', (c) => {
      c.check(
        source.length >= 1 && source.length <= MAX_SOURCE_LENGTH,
        ['source'],
        'length',
        `must be 1 to ${MAX_SOURCE_LENGTH} characters`,
        { min: 1, max: MAX_SOURCE_LENGTH, actual: source.length },
      )
      c.check(
        UNITS[defaultUnit].kind === kind,
        ['defaultUnit'],
        'unitKind',
        `"${defaultUnit}" is not a ${kind} unit`,
        { kind, actual: defaultUnit },
      )
      c.check(Number.isFinite(this.canonical), ['exact'], 'finite', 'is out of float64 range', {
        actual: exact.toString(),
      })
    })
    Object.freeze(this)
  }

  static create(p: QuantityProps): AppResult<Quantity> {
    return construct(
      'Quantity',
      () => new Quantity(p.kind, p.source, p.defaultUnit, p.exact, p.tolerance),
    )
  }

  /**
   * Parse what the user typed in a field (docs/architecture/quantities.md#literal-grammar-task-21).
   * Errors: `quantity.syntax`, `quantity.unit`, `model.invariant` (tolerance rules, default unit).
   */
  static parse(source: string, context: ParseContext): AppResult<Quantity> {
    const parsed = parseLiteral(source, context)
    if (parsed.isErr()) return parsed.mapErr(ctx('Quantity.parse', { kind: context.kind }))
    const { exact, tolerance } = parsed.unwrap()
    let tol: Option<Tolerance> = None
    if (tolerance.isSome()) {
      const t = Tolerance.create(tolerance.unwrap())
      if (t.isErr()) return t.mapErr((e) => e.prefixIssues('tolerance'))
      tol = Some(t.unwrap())
    }
    return Quantity.create({
      kind: context.kind,
      source,
      defaultUnit: context.defaultUnit,
      exact,
      tolerance: tol,
    })
  }

  /**
   * Load a shape-checked DTO (`parseWith(QuantityDtoSchema, …)` first). Checks invariants and
   * normalizes rationals; does **not** re-parse `source`, so `exact` wins if they disagree.
   */
  static fromDTO(dto: QuantityDTO): AppResult<Quantity> {
    const exact = Rational.fromDTO(dto.exact).mapErr((e) => e.prefixIssues('exact'))
    const tolerance = toleranceFromDTO(dto.tolerance)
    const all = collect<unknown>([exact, tolerance]) // report issues of both at once
    if (all.isErr()) return all
    if (exact.isErr()) return exact
    if (tolerance.isErr()) return tolerance
    return Quantity.create({
      kind: dto.kind,
      source: dto.source,
      defaultUnit: dto.defaultUnit,
      exact: exact.unwrap(),
      tolerance: tolerance.unwrap(),
    })
  }

  toDTO(): QuantityDTO {
    const base = {
      kind: this.kind,
      source: this.source,
      defaultUnit: this.defaultUnit,
      exact: this.exact.toDTO(),
    }
    if (this.tolerance.isNone()) return base
    const t = this.tolerance.unwrap()
    return {
      ...base,
      tolerance: { notation: t.notation, upper: t.upper.toDTO(), lower: t.lower.toDTO() },
    }
  }

  /**
   * Same kind, equal exact values and equal tolerance deviations (exact). Source, default unit
   * and tolerance notation are display/entry data and not compared (`1"` equals `25.4 mm`).
   */
  equals(o: Quantity): boolean {
    if (this.kind !== o.kind || !this.exact.equals(o.exact)) return false
    if (this.tolerance.isNone() || o.tolerance.isNone())
      return this.tolerance.isNone() && o.tolerance.isNone()
    return this.tolerance.unwrap().equals(o.tolerance.unwrap())
  }
}

function toleranceFromDTO(t: QuantityDTO['tolerance']): AppResult<Option<Tolerance>> {
  if (t === undefined) return Ok(None)
  const upper = Rational.fromDTO(t.upper).mapErr((e) => e.prefixIssues('upper'))
  const lower = Rational.fromDTO(t.lower).mapErr((e) => e.prefixIssues('lower'))
  const both = collect([upper, lower])
  if (both.isErr()) return both.mapErr((e) => e.prefixIssues('tolerance'))
  if (upper.isErr()) return upper
  if (lower.isErr()) return lower
  return Tolerance.create({ notation: t.notation, upper: upper.unwrap(), lower: lower.unwrap() })
    .map((tol) => Some(tol))
    .mapErr((e) => e.prefixIssues('tolerance'))
}
