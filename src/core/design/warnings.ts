/**
 * DFM warnings of a design part: the synchronous parameter and tool checks (`parameterChecks`)
 * against the whole tool library and each operation's own tool, for `design.warning.list` and
 * every design command result. The geometry checks come from the evaluation (worker, task 2.9).
 * Doc: docs/modes/design.md#dfm-warnings-task-28-wiring, docs/modes/design-v0.2.md#dfm-with-the-tool
 */
import type { AppResult } from '../../shared/result'
import { parameterChecks, type DfmTool } from '../geometry/dfm'
import type { Region2dPort } from '../geometry/2d/port'
import type { DfmWarning } from '../geometry/model'
import { DfmWarningSchema } from '../geometry/schemas'
import type { Library } from '../library/library'
import type { Stock } from '../library/stock'
import { Tool } from '../library/tool'
import type { ProjectDoc, UnitSystem } from '../project/document'
import { toGeometryInput } from './geometry-input'
import { featureBlock, ownedOperationId, type LoadedFeature } from './feature'
import type { Part } from './operation'
import { dfmTool, operationTools } from './tool-choice'

/** `DfmWarning` as a result schema (defined with the other boundary schemas). */
export { DfmWarningSchema }
export { dfmTool }

/** Every readable tool of the library; files that do not load are skipped. */
export function libraryTools(library: Library): DfmTool[] {
  return library
    .list('tool')
    .items.flatMap((i) => (i.values instanceof Tool ? [dfmTool(i.values)] : []))
}

/**
 * The parameter and tool warnings of a (valid) part, in operation order; specific tools of the
 * tool field resolve in `snapshots`.
 */
export function partWarnings(
  part: Part,
  stock: Stock,
  units: UnitSystem,
  tools: readonly DfmTool[],
  snapshots: ProjectDoc['snapshots'] = {},
  region2d?: Region2dPort,
  features: readonly LoadedFeature[] = [],
): AppResult<DfmWarning[]> {
  return toGeometryInput(part, stock, region2d).map((input) =>
    insertInOrder(
      part.operations,
      parameterChecks(input, {
        tools,
        unitSystem: units === 'inch' ? 'inch' : 'metric',
        operationTools: operationTools(part.operations, snapshots),
        ...(region2d !== undefined && { region2d }),
      }),
      featureWarnings(part.operations, features),
    ),
  )
}

/**
 * The features' own notes (`FeatureKindSpec.warnings`, e.g. `dfm.holeCustomSize`), for features
 * that still own operations in `ops` (a removed one is skipped).
 */
function featureWarnings(
  ops: Part['operations'],
  features: readonly LoadedFeature[],
): DfmWarning[] {
  return features.flatMap(({ spec, feature }) => {
    const { start, end } = featureBlock(ops, feature.id)
    if (start === end || spec.warnings === undefined) return []
    return spec.warnings(feature, (role) => ownedOperationId(feature.id, role))
  })
}

/**
 * `extra` inserted into `warnings` (left in their order) after the last warning of an operation
 * at or before each one's operation, so a list in design order stays so.
 */
function insertInOrder(
  ops: Part['operations'],
  warnings: DfmWarning[],
  extra: DfmWarning[],
): DfmWarning[] {
  if (extra.length === 0) return warnings
  const index = new Map(ops.map((o, i) => [o.id, i]))
  const at = (w: DfmWarning) => index.get(w.operation) ?? -1
  const out = [...warnings]
  for (const w of extra) {
    let i = out.length
    while (i > 0 && at(out[i - 1]!) > at(w)) i--
    out.splice(i, 0, w)
  }
  return out
}
