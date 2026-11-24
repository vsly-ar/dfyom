/**
 * Persisted shape of a setup's work zero and alignment points (alignment phase 1, hardening
 * DF78). Shape only; positions, findings and texts live in `alignment.ts`.
 * Doc: docs/modes/alignment.md#setup-work-zero-q61, docs/modes/alignment.md#alignment-points,
 * docs/modes/alignment.md#implementation-slice-1 (S1)
 */
import { z } from 'zod'
import { RECORD_ID_PATTERN } from '../design/part.dto'

/** The eight stock corners by part faces: top/bottom, front/back, left/right. */
export const STOCK_CORNERS = [
  'top front left',
  'top front right',
  'top back left',
  'top back right',
  'bottom front left',
  'bottom front right',
  'bottom back left',
  'bottom back right',
] as const
export type StockCorner = (typeof STOCK_CORNERS)[number]

/** The twelve stock edges by their two part faces (top/bottom, front/back, left/right order). */
export const STOCK_EDGES = [
  'top front',
  'top back',
  'top left',
  'top right',
  'bottom front',
  'bottom back',
  'bottom left',
  'bottom right',
  'front left',
  'front right',
  'back left',
  'back right',
] as const
export type StockEdge = (typeof STOCK_EDGES)[number]

/** Points a setup may list at most (the header lists each; the cycle steps through all). */
export const ALIGNMENT_POINTS_MAX = 16
/** A zero this far from the corner (mm) is a typo, not a choice. */
export const ZERO_LIMIT_MM = 10_000

const AlignmentIdSchema = z.string().regex(RECORD_ID_PATTERN)

/** A string out of `values`, validated but listed only by example (keeps tools/list small). */
function oneOf<T extends string>(values: readonly T[], example: string) {
  return z
    .string()
    .refine((v): v is T => (values as readonly string[]).includes(v), {
      message: `one of ${values.join(', ')}`,
    })
    .describe(example)
}
const index = z.int().min(0).max(9999)

/**
 * Where an alignment point is (S1): a stock corner, a point on a stock edge, or a hole centre or
 * outline vertex of a plan operation cut before the setup.
 */
export const AlignmentSourceDtoSchema = z.union([
  // free strings checked by refine: the enums cost ≈ 0.5 K of tools/list (llm-api.md budget)
  z.object({ corner: oneOf(STOCK_CORNERS, "e.g. 'top front left'") }).strict(),
  z
    .object({
      edge: oneOf(STOCK_EDGES, "e.g. 'top front', 'front left'"),
      t: z.number().min(0).max(1).optional().describe('0..1, default 0.5'),
    })
    .strict(),
  z
    .object({
      operation: AlignmentIdSchema,
      hole: index.describe('0-based'),
    })
    .strict(),
  z
    .object({
      operation: AlignmentIdSchema,
      vertex: index.describe('0-based'),
    })
    .strict(),
])
export type AlignmentSourceDTO = z.output<typeof AlignmentSourceDtoSchema>

export const AlignmentPointDtoSchema = z.object({
  id: AlignmentIdSchema,
  name: z.string().min(1).max(80).optional().describe('Absent = named after the source'),
  source: AlignmentSourceDtoSchema,
})
export type AlignmentPointDTO = z.output<typeof AlignmentPointDtoSchema>

const coord = z.number().min(-ZERO_LIMIT_MM).max(ZERO_LIMIT_MM)

/**
 * The setup's work zero G54 X0 Y0 (Q61): `at` in the setup frame (mm from the front-left corner of
 * the up face, any value, negative too), or on one of the setup's alignment points.
 */
export const SetupZeroDtoSchema = z.union([
  z.object({ at: z.tuple([coord, coord]).describe('X, Y in mm from the corner') }).strict(),
  z
    .object({ point: AlignmentIdSchema.describe("One of the setup's alignment point ids") })
    .strict(),
])
export type SetupZeroDTO = z.output<typeof SetupZeroDtoSchema>
