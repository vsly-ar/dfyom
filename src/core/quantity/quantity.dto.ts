/**
 * Persisted shape of a Quantity. Shape only; domain rules live in Quantity / Tolerance / Rational.
 * Doc: docs/architecture/quantities.md#persistence-dto
 */
import { z } from 'zod'
import { MAX_SOURCE_LENGTH } from './parse'
import { QUANTITY_KINDS, UNIT_IDS } from './units'

/** Bigint as decimal strings; den ≠ 0 is a model invariant, not a shape rule. */
export const RationalDtoSchema = z.object({
  num: z.string().regex(/^-?\d+$/),
  den: z.string().regex(/^\d+$/),
})

export const QuantityDtoSchema = z.object({
  kind: z.enum(QUANTITY_KINDS),
  source: z.string().min(1).max(MAX_SOURCE_LENGTH), // display only
  defaultUnit: z.enum(UNIT_IDS), // bare-number unit at entry, used when the source is re-parsed after an edit
  exact: RationalDtoSchema, // canonical unit; the value
  tolerance: z
    .object({
      notation: z.enum(['symmetric', 'deviations']),
      upper: RationalDtoSchema,
      lower: RationalDtoSchema,
    })
    .optional(), // explicit tolerance only
})

export type QuantityDTO = z.infer<typeof QuantityDtoSchema>
