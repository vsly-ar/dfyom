/**
 * Persisted shape of a feature (v0.4, record `parts/<id>.json` → `features`): the fields every
 * kind has, plus the kind's own parameters. The part schema only checks the common fields; each
 * kind's full schema is checked when the part loads (feature.ts `FeatureKindSpec.fromDTO`), so a
 * kind added later (hole F3, Clones F5) needs no change here.
 * Doc: docs/modes/features.md#persistence-high-level, docs/modes/design-v0.4.md#implementation-f1
 */
import { z } from 'zod'
import { NAME_MAX } from '../library/item'

/** `hole1`, `clones2`: kind prefix + number, immutable (features.md § Persistence). */
export const FEATURE_ID_PATTERN = /^[a-z][a-zA-Z]*[1-9]\d*$/

// No description: ids come from results (primer; llm-api.md#schemas).
export const FeatureIdSchema = z.string().regex(FEATURE_ID_PATTERN)

/**
 * Role of an owned operation (A3): `<step>` or `<instance>_<step>` for repeated cuts (Clones:
 * `3_pocket2`, `3_hole1_drill`). The step names the cut, so the instances of one step are found
 * by role (cut order tool by tool, D34; feature.ts `stepOf`). A step that is an inner Clones'
 * instance keeps its id (Clones v2, G3: `2_clones2_3_hole2_drill`).
 */
export const FEATURE_ROLE_PATTERN =
  /^([1-9]\d{0,3}_)?([a-z][a-zA-Z]*[1-9]\d*_[1-9]\d{0,3}_)?[a-z][A-Za-z0-9]*(_[a-z][A-Za-z0-9]*){0,2}$/

export const FeatureRoleSchema = z.string().regex(FEATURE_ROLE_PATTERN)

/** Common fields; the kind's parameters are kept as they are (checked by the kind on load). */
export const FeatureDtoSchema = z.looseObject({
  id: FeatureIdSchema,
  kind: z.string().regex(/^[a-z][a-zA-Z]{0,31}$/),
  name: z.string().min(1).max(NAME_MAX),
  /** Face target of the feature (design-v0.2.md#face-targets-generalised-on). */
  on: z.string().min(1).max(128),
})
export type FeatureDTO = z.output<typeof FeatureDtoSchema>
