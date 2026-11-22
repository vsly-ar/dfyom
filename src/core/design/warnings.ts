/**
 * DFM warnings of a design part: the synchronous parameter and tool checks (`parameterChecks`)
 * against the whole tool library, for `design.warning.list` and every design command result.
 * The geometry checks come from the evaluation (worker, task 2.9).
 * Doc: docs/modes/design.md#dfm-warnings-task-28-wiring
 */
import type { AppResult } from '../../shared/result'
import { parameterChecks, type DfmTool } from '../geometry/dfm'
import type { DfmWarning } from '../geometry/model'
import { DfmWarningSchema } from '../geometry/schemas'
import type { Library } from '../library/library'
import type { Stock } from '../library/stock'
import { Tool } from '../library/tool'
import type { UnitSystem } from '../project/document'
import { toGeometryInput } from './geometry-input'
import type { Part } from './operation'

/** `DfmWarning` as a result schema (defined with the other boundary schemas). */
export { DfmWarningSchema }

/** A library tool reduced to what the DFM rules need (canonical mm). */
export function dfmTool(tool: Tool): DfmTool {
  return {
    type: tool.type,
    diameter: tool.diameter.canonical,
    ...(tool.cornerRadius.isSome() && { cornerRadius: tool.cornerRadius.unwrap().canonical }),
    reach: tool.stickout.mapOr(tool.fluteLength.canonical, (s) => s.canonical),
  }
}

/** Every readable tool of the library; files that do not load are skipped. */
export function libraryTools(library: Library): DfmTool[] {
  return library
    .list('tool')
    .items.flatMap((i) => (i.values instanceof Tool ? [dfmTool(i.values)] : []))
}

/** The parameter and tool warnings of a (valid) part, in operation order. */
export function partWarnings(
  part: Part,
  stock: Stock,
  units: UnitSystem,
  tools: readonly DfmTool[],
): AppResult<DfmWarning[]> {
  return toGeometryInput(part, stock).map((input) =>
    parameterChecks(input, { tools, unitSystem: units === 'inch' ? 'inch' : 'metric' }),
  )
}
