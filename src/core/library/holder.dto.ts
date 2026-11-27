/**
 * Persisted shape of a tool holder (collet nut and spindle body) on a machine; the tool's
 * override reuses it in slice H6. Shape only; domain rules live in holder.ts.
 * Doc: docs/modes/tool-holder.md#model
 */
import { z } from 'zod'
import { quantityDto } from './item'

/** Built-in presets, in picker order (docs/modes/tool-holder.md#presets). */
export const HOLDER_PRESET_IDS = [
  'er11',
  'er11Mini',
  'er16',
  'er16Mini',
  'er20',
  'er20Mini',
  'trimRouter',
  'plungeRouter',
] as const
export type HolderPresetId = (typeof HOLDER_PRESET_IDS)[number]
export const HolderPresetIdSchema = z.enum(HOLDER_PRESET_IDS)

// Sizes are optional in the shape so `{ preset }` alone fills them (agent API, tool-holder.md §
// Agent API); the model always stores all three, so a stored holder has them.
export const HolderDtoSchema = z
  .object({
    preset: HolderPresetIdSchema.optional().describe('Fills the sizes not given'),
    nutDiameter: quantityDto('length').optional(),
    nutLength: quantityDto('length').optional().describe('Nut face (nose) up to the body'),
    bodyDiameter: quantityDto('length').optional().describe('≥ nutDiameter'),
    maxShank: quantityDto('length').optional(),
  })
  .describe('Collet nut and spindle body, for the clamp checks')

export type HolderDTO = z.output<typeof HolderDtoSchema>
