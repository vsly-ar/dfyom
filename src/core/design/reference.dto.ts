/**
 * Persisted shape of a reference model (record `references/<id>.json`).
 * Shape only. Doc: docs/modes/reference-model.md#data-model, storage:
 * docs/architecture/persistence.md#assets-and-references-v02
 *
 * Plan task R1 adds the record collection and its asset; R2 adds the commands that write it.
 */
import { z } from 'zod'
import { NAME_MAX, quantityDto } from '../library/item'
import { ASSET_PATH } from '../project/assets'

const xyz = <T extends z.ZodType>(t: () => T) => z.object({ x: t(), y: t(), z: t() })
const finite = () => z.number().finite()

/** The stored file: content-addressed path, its hash and what the parser read from it. */
export const ReferenceAssetDtoSchema = z.object({
  path: z.string().regex(ASSET_PATH).describe('assets/<sha256>.stl inside the project'),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe('sha256 of the file bytes'),
  format: z.literal('stl'),
  triangles: z.number().int().nonnegative(),
  bounds: z
    .object({ min: xyz(finite), max: xyz(finite) })
    .describe('Bounding box in source units, as read from the file'),
})
export type ReferenceAssetDTO = z.output<typeof ReferenceAssetDtoSchema>

export const ReferenceDtoSchema = z.object({
  id: z.string().min(1).max(128),
  partId: z.string().min(1).max(128).describe('The part this reference belongs to'),
  name: z.string().min(1).max(NAME_MAX).describe('Display label; defaults to the file name'),
  asset: ReferenceAssetDtoSchema,
  sourceUnit: z.enum(['mm', 'inch']).describe('What one STL unit means'),
  scale: quantityDto('scalar').describe('Uniform factor on top of sourceUnit'),
  rotation: xyz(() => quantityDto('angle')).describe('Applied x, then y, then z, about part axes'),
  position: xyz(() => quantityDto('length')).describe('Where the placed bounding-box min lands'),
})
export type ReferenceDTO = z.output<typeof ReferenceDtoSchema>
