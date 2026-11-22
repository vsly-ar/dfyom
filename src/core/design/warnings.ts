/**
 * DFM warnings of a design part: the synchronous parameter and tool checks (`parameterChecks`)
 * against the whole tool library and each operation's own tool, for `design.warning.list` and
 * every design command result. The geometry checks come from the evaluation (worker, task 2.9).
 * Doc: docs/modes/design.md#dfm-warnings-task-28-wiring, docs/modes/design-v0.2.md#dfm-with-the-tool
 */
import type { AppResult } from '../../shared/result'
import { parameterChecks, type DfmTool } from '../geometry/dfm'
import type { DfmWarning } from '../geometry/model'
import { DfmWarningSchema } from '../geometry/schemas'
import type { Library } from '../library/library'
import type { Stock } from '../library/stock'
import { Tool } from '../library/tool'
import type { ProjectDoc, UnitSystem } from '../project/document'
import { toGeometryInput } from './geometry-input'
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
): AppResult<DfmWarning[]> {
  return toGeometryInput(part, stock).map((input) =>
    parameterChecks(input, {
      tools,
      unitSystem: units === 'inch' ? 'inch' : 'metric',
      operationTools: operationTools(part.operations, snapshots),
    }),
  )
}
