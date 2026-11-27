/**
 * Persisted shape of a stock item's values (snapshot `values` and library file minus meta).
 * Shape only; domain rules live in Stock. Doc: docs/architecture/library.md#stock
 */
import { z } from 'zod'
import { commonValuesShape, MaterialClassSchema, NAME_MAX, quantityDto } from './item'

export const StockValuesDtoSchema = z.object({
  kind: z.literal('stock'),
  ...commonValuesShape,
  shape: z.literal('block').describe('Rectangular block only'),
  length: quantityDto('length').describe('Size along X'),
  width: quantityDto('length').describe('Size along Y'),
  thickness: quantityDto('length').describe('Size along Z; its tolerance is the real variation'),
  material: z.object({
    name: z.string().min(1).max(NAME_MAX).describe('e.g. "6061-T6", "birch plywood"'),
    class: MaterialClassSchema.describe('Key for feeds-and-speeds presets and DFM hints'),
  }),
})

export type StockValuesDTO = z.output<typeof StockValuesDtoSchema>
