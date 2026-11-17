/**
 * Persisted shape of a tool item's values and its feeds-and-speeds presets.
 * Shape only; domain rules live in Tool / CuttingPreset. Doc: docs/architecture/library.md#tool
 */
import { z } from 'zod'
import { commonValuesShape, MaterialClassSchema, quantityDto } from './item'

export const TOOL_TYPES = ['flatEndMill', 'bullNoseEndMill', 'ballEndMill', 'drill'] as const
export type ToolType = (typeof TOOL_TYPES)[number]

export const TOOL_MATERIALS = ['carbide', 'hss', 'other'] as const
export type ToolMaterial = (typeof TOOL_MATERIALS)[number]

export const PRESET_NAME_MAX = 60
export const COATING_MAX = 60

export const CuttingPresetDtoSchema = z.object({
  name: z.string().min(1).max(PRESET_NAME_MAX).describe('Unique per tool'),
  materialClass: MaterialClassSchema.optional().describe('Material class; none = any material'),
  spindleSpeed: quantityDto('spindleSpeed'),
  feedRate: quantityDto('feedRate'),
  plungeRate: quantityDto('feedRate'),
  stepdown: quantityDto('length').optional(),
  stepover: quantityDto('length').optional().describe('At most the tool diameter'),
})
export type CuttingPresetDTO = z.output<typeof CuttingPresetDtoSchema>

export const ToolValuesDtoSchema = z.object({
  kind: z.literal('tool'),
  ...commonValuesShape,
  type: z.enum(TOOL_TYPES),
  diameter: quantityDto('length').describe('DC: cutting diameter'),
  cornerRadius: quantityDto('length')
    .optional()
    .describe('RE: bull nose only, 0 < RE < DC/2 (flat = 0 and ball = DC/2 are derived)'),
  fluteLength: quantityDto('length').describe('LCF: length of cut'),
  overallLength: quantityDto('length').describe('OAL: greater than the flute length'),
  stickout: quantityDto('length').optional().describe('Default length below the collet'),
  shankDiameter: quantityDto('length').optional(),
  fluteCount: quantityDto('scalar').describe('NOF: whole number ≥ 1'),
  pointAngle: quantityDto('angle').optional().describe('SIG: drill only, 0° < SIG < 180°'),
  toolMaterial: z.enum(TOOL_MATERIALS).optional(),
  coating: z.string().max(COATING_MAX).optional(),
  presets: z.array(CuttingPresetDtoSchema).default([]).describe('Feeds-and-speeds presets'),
})
export type ToolValuesDTO = z.output<typeof ToolValuesDtoSchema>
