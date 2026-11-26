/**
 * Round corners (DF120): a rectangle's `round` flag, its derived corner radius and the apply rule
 * that turns Round on instead of refusing a too-large radius. Shared by operation shapes, shape
 * items and pattern cells.
 * Doc: docs/modes/hole-slots-and-round-corners.md#round-corners-df120
 */
import { z } from 'zod'
import type { UnitSystem } from '../project/document'
import type { Quantity } from '../quantity/quantity'
import { Rational } from '../quantity/rational'
import { CHORD_TOLERANCE } from '../geometry/model'
import { derivedLength } from './hole'

const HALF = Rational.create(1n, 2n).unwrap()

/** The `cornerRadius` source that means Round (agent args, hole-slots-and-round-corners.md SH-C). */
export const ROUND = 'round'

/** One value a command changed from what was entered (results only, never stored). */
export interface Adjusted {
  /** The parameter, as in the args (`shape.cornerRadius`, `cell.cornerRadius`, `items.0.cornerRadius`). */
  readonly path: string
  /** The value that did not fit, in the project units. */
  readonly from: string
  readonly to: 'round'
  readonly rule: 'cornerRadiusRound'
  /** Which edit made the radius too large: "3 mm is more than half the width (2.75 mm): set to Round." */
  readonly message: string
}

export const AdjustedSchema = z
  .array(
    z.object({
      path: z.string(),
      from: z.string(),
      to: z.literal('round'),
      rule: z.literal('cornerRadiusRound'),
      message: z.string(),
    }),
  )
  .describe('Values changed on apply: a corner radius above half the narrowest side became Round')

/** The unit system a length was entered in (its default unit). */
export const unitsOf = (q: Quantity): UnitSystem => (q.defaultUnit === 'in' ? 'inch' : 'mm')

/** Half the narrowest side, exact (mm). */
export const halfNarrowest = (length: Quantity, width: Quantity): Rational =>
  (length.exact.compare(width.exact) <= 0 ? length : width).exact.mul(HALF)

/** The radius of a Round rectangle: half the narrowest side, nominal and untoleranced. */
export function roundRadius(length: Quantity, width: Quantity, units = unitsOf(length)): Quantity {
  return derivedLength(halfNarrowest(length, width), units).unwrap()
}

/** Whether a Round rectangle's stored radius is the derived one (invariant `roundRadius`). */
export const roundRadiusHolds = (length: Quantity, width: Quantity, radius: Quantity): boolean =>
  radius.exact.equals(halfNarrowest(length, width))

/** A rectangle's sizes before an edit (absent on add). */
export interface RoundPrev {
  readonly length: Quantity
  readonly width: Quantity
  readonly cornerRadius: Quantity
  readonly round: boolean
}

/** What a rectangle edit gave. */
export interface RoundInput {
  readonly length: Quantity
  readonly width: Quantity
  /** The radius the edit gives: entered, else the default or the previous one. */
  readonly cornerRadius: Quantity
  /** Whether this edit entered a radius (a `"round"` source is `round: true`, not a radius). */
  readonly radiusGiven: boolean
  /** The edit's Round flag: true (also `"round"`), false (explicitly off) or not given. */
  readonly round: boolean | undefined
  readonly units: UnitSystem
  /** The radius parameter's path, for `adjusted`. */
  readonly path: string
}

export interface RoundResult {
  readonly cornerRadius: Quantity
  readonly round: boolean
  readonly adjusted?: Adjusted
}

/**
 * The apply rule (hole-slots-and-round-corners.md § Apply rule): `round: true` derives the radius;
 * a Round rectangle stays Round (following its sizes) unless the edit enters another radius or
 * sets Round off; a radius above half the narrowest side turns Round on and reports it, unless
 * the edit sets Round off (then the `cornerRadiusRange` check refuses it as before). A radius
 * within the chord tolerance above half becomes Round without a report.
 */
export function settleRound(input: RoundInput, prev: RoundPrev | undefined): RoundResult {
  const { length, width, units } = input
  const round = (): RoundResult => ({
    cornerRadius: roundRadius(length, width, units),
    round: true,
  })
  if (input.round === true) return round()
  // the same radius as stored (an inspector sends the whole shape) is not a new radius
  const entered =
    input.radiusGiven &&
    (prev === undefined || !prev.round || !input.cornerRadius.exact.equals(prev.cornerRadius.exact))
  if (input.round === undefined && prev?.round === true && !entered) return round()
  const half = halfNarrowest(length, width)
  const r = input.cornerRadius
  if (input.round === false || r.exact.compare(half) <= 0) return { cornerRadius: r, round: false }
  const over = r.exact.sub(half).toNumber()
  if (over <= CHORD_TOLERANCE) return round()
  const side = length.exact.compare(width.exact) < 0 ? 'length' : 'width'
  const text = (exact: Rational) => derivedLength(exact, units).unwrap().source
  const sizeEdit =
    prev !== undefined &&
    !prev.round &&
    r.exact.equals(prev.cornerRadius.exact) &&
    !(length.exact.equals(prev.length.exact) && width.exact.equals(prev.width.exact))
  const message = sizeEdit
    ? `R ${text(r.exact)} does not fit the new ${side} (half is ${text(half)}): set to Round.`
    : `${text(r.exact)} is more than half the ${side} (${text(half)}): set to Round.`
  return {
    ...round(),
    adjusted: {
      path: input.path,
      from: text(r.exact),
      to: 'round',
      rule: 'cornerRadiusRound',
      message,
    },
  }
}
