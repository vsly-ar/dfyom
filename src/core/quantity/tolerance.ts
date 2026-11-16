/**
 * Explicit tolerance of a quantity: exact deviations from the nominal, in the canonical unit.
 * Doc: docs/architecture/quantities.md#tolerance
 *
 * Only the explicit tolerance lives here; the effective (general) tolerance of an untoleranced
 * value is resolved by the design model, never by the quantity.
 */
import { construct, invariants } from '../../shared/model'
import type { AppResult } from '../../shared/result'
import type { Rational } from './rational'

/** `symmetric` = `±d` (upper = d, lower = −d); `deviations` = `+u/−l`. Drives display only. */
export type ToleranceNotation = 'symmetric' | 'deviations'

export interface ToleranceProps {
  readonly notation: ToleranceNotation
  readonly upper: Rational
  readonly lower: Rational
}

export class Tolerance {
  private constructor(
    readonly notation: ToleranceNotation,
    readonly upper: Rational,
    readonly lower: Rational,
  ) {
    invariants('Tolerance', (c) => {
      c.check(upper.compare(lower) >= 0, ['lower'], 'order', 'lower deviation exceeds upper', {
        upper: upper.toString(),
        lower: lower.toString(),
      })
      if (notation === 'symmetric') {
        c.check(upper.compare(lower.neg()) === 0, ['lower'], 'symmetric', 'must equal −upper', {
          upper: upper.toString(),
          lower: lower.toString(),
        })
        c.check(upper.num >= 0n, ['upper'], 'nonNegative', '± deviation must be ≥ 0', {
          actual: upper.toString(),
        })
      }
    })
    Object.freeze(this)
  }

  /** Invariants: upper ≥ lower; symmetric ⇒ lower = −upper and upper ≥ 0 (`model.invariant`). */
  static create(p: ToleranceProps): AppResult<Tolerance> {
    return construct('Tolerance', () => new Tolerance(p.notation, p.upper, p.lower))
  }

  /** Exact deviations; notation is display only and not compared. */
  equals(o: Tolerance): boolean {
    return this.upper.equals(o.upper) && this.lower.equals(o.lower)
  }
}
