/**
 * Exact bigint rational: the single source of truth of a quantity's value.
 * Doc: docs/architecture/quantities.md#value
 *
 * Always normalized (gcd(num, den) = 1, den > 0), immutable. Equality is exact; `toNumber()`
 * gives the nearest float64 (round half to even) for geometry and toolpaths.
 */
import { construct, invariants } from '../../shared/model'
import type { AppResult } from '../../shared/result'

/** Persisted form: bigint as decimal strings (docs/architecture/quantities.md#persistence-dto). */
export interface RationalDTO {
  readonly num: string
  readonly den: string
}

export class Rational {
  static readonly ZERO = Rational.int(0n)
  static readonly ONE = Rational.int(1n)

  readonly num: bigint
  readonly den: bigint

  private constructor(num: bigint, den: bigint) {
    invariants('Rational', (c) => {
      c.check(den !== 0n, ['den'], 'denominatorNonZero', 'denominator must not be 0', {
        actual: den.toString(),
      })
    })
    const sign = den < 0n ? -1n : 1n
    const g = gcd(num, den)
    this.num = (sign * num) / g
    this.den = (sign * den) / g
    Object.freeze(this)
  }

  /** num/den, normalized. Fails with `model.invariant` (rule `denominatorNonZero`) when den = 0. */
  static create(num: bigint, den = 1n): AppResult<Rational> {
    return construct('Rational', () => new Rational(num, den))
  }

  /** An integer; cannot fail. */
  static int(n: bigint): Rational {
    return new Rational(n, 1n)
  }

  /** Load a DTO (shape already checked by Zod); normalizes, checks den ≠ 0. */
  static fromDTO(dto: RationalDTO): AppResult<Rational> {
    return Rational.create(BigInt(dto.num), BigInt(dto.den))
  }

  toDTO(): RationalDTO {
    return { num: this.num.toString(), den: this.den.toString() }
  }

  add(o: Rational): Rational {
    return new Rational(this.num * o.den + o.num * this.den, this.den * o.den)
  }

  mul(o: Rational): Rational {
    return new Rational(this.num * o.num, this.den * o.den)
  }

  neg(): Rational {
    return new Rational(-this.num, this.den)
  }

  /** -1, 0 or 1. */
  compare(o: Rational): -1 | 0 | 1 {
    const d = this.num * o.den - o.num * this.den
    return d < 0n ? -1 : d > 0n ? 1 : 0
  }

  equals(o: Rational): boolean {
    return this.num === o.num && this.den === o.den
  }

  /** Nearest float64 (ties to even); ±Infinity when out of range. */
  toNumber(): number {
    return nearestFloat64(this.num, this.den)
  }

  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`
  }
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a
  b = b < 0n ? -b : b
  while (b !== 0n) [a, b] = [b, a % b]
  return a === 0n ? 1n : a
}

function bitLength(n: bigint): number {
  return n.toString(2).length
}

/** x · 2^e without intermediate overflow/underflow while the result is a normal number. */
function ldexp(x: number, e: number): number {
  while (e > 1023) {
    x *= 2 ** 1023
    e -= 1023
  }
  while (e < -1022) {
    x *= 2 ** -1022
    e += 1022
  }
  return x * 2 ** e
}

const TWO_53 = 2n ** 53n

/**
 * Correctly rounded num/den (den > 0). Number(bigint) rounds to nearest, ties to even; we feed it
 * a quotient with ≥ 64 significant bits plus a sticky bit, so the rounding is exact.
 */
function nearestFloat64(num: bigint, den: bigint): number {
  if (num === 0n) return 0
  const negative = num < 0n
  const a = negative ? -num : num
  const sign = negative ? -1 : 1
  // Both operands exact in float64: IEEE division is correctly rounded.
  if (a <= TWO_53 && den <= TWO_53) return (sign * Number(a)) / Number(den)

  // Subnormal range (< 2^-1022): result is a multiple of 2^-1074; round m = a·2^1074/den.
  if (bitLength(a) - bitLength(den) < -1020) {
    const scaled = a << 1074n
    let m = scaled / den
    const r2 = (scaled % den) * 2n
    if (r2 > den || (r2 === den && (m & 1n) === 1n)) m += 1n
    if (m < 2n ** 52n) return sign * ldexp(Number(m), -1074)
  }

  const s = 64 + bitLength(den) - bitLength(a)
  const n = s >= 0 ? a << BigInt(s) : a
  const d = s >= 0 ? den : den << BigInt(-s)
  let q = n / d
  if (n % d !== 0n) q |= 1n // sticky bit: below the rounding position, only breaks ties
  return sign * ldexp(Number(q), -s)
}
