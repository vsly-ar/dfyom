/**
 * Persisted shape of a workholding library item's values (library file minus meta): one flat
 * object for every device type, the per-type rules live in `Workholding` (as the pattern cell).
 * Shape only. Doc: docs/modes/workholding-library.md#item-model
 */
import { z } from 'zod'
import { NAME_MAX, NOTES_MAX, quantityDto } from './item'

/** The device types: the setup item kinds (workholding.md § Model). */
export const WORKHOLDING_TYPES = ['toeClamp', 'vise', 'screw', 'block', 'base', 'surface'] as const
export type WorkholdingType = (typeof WORKHOLDING_TYPES)[number]
export const BASE_TYPES = ['spoilboard', 'fixturePlate'] as const
export type BaseType = (typeof BASE_TYPES)[number]
export const SURFACE_TYPES = ['tape', 'vacuum', 'glue'] as const
export type SurfaceType = (typeof SURFACE_TYPES)[number]

/** Display-only thread or stud text ("M8", "4 × 40 wood"); checked by the model, not the schema. */
export const THREAD_MAX = 20

const Len = quantityDto('length').optional()

// No field descriptions: the add tool's `values` description says which type takes which field
// once (tools/list budget, llm-api.md#implementation-task-310).
export const WorkholdingValuesDtoSchema = z.object({
  kind: z.literal('workholding'),
  // name and notes as `commonValuesShape`, without the name description (the primer says it)
  name: z.string().min(1).max(NAME_MAX),
  notes: z.string().max(NOTES_MAX).optional(),
  type: z.enum(WORKHOLDING_TYPES),
  default: z.boolean().optional(),
  width: Len,
  length: Len,
  top: Len,
  gripMin: Len,
  gripMax: Len,
  stud: z.string().optional(),
  jawWidth: Len,
  jawThickness: Len,
  jawHeight: Len,
  maxOpening: Len,
  soft: z.boolean().optional(),
  headDiameter: Len,
  headHeight: Len,
  thread: z.string().optional(),
  height: Len,
  baseType: z.enum(BASE_TYPES).optional(),
  sacrificial: z.boolean().optional(),
  thickness: Len,
  surfaceType: z.enum(SURFACE_TYPES).optional(),
})

export type WorkholdingValuesDTO = z.output<typeof WorkholdingValuesDtoSchema>
