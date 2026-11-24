/**
 * A setup's tool runs (hardening DF66): its plan operations split where the tool copy changes, and
 * the tool changes the operator makes for it, the one at the setup start included unless the tool
 * stays in the spindle from the setup before (DF65).
 * Doc: docs/modes/plan-v0.4.md#tool-changes-per-setup-hardening-df66
 */
import type { PlanOperationDTO } from './plan.dto'

/** What a run needs of an operation: its tool copy (plan DTOs, or the agent summary's rows). */
type WithTool = { readonly tool?: string | undefined }

export interface ToolRun<T extends WithTool = PlanOperationDTO> {
  /** The tool copy's snapshot id; undefined: an operation without a tool (a run of its own). */
  readonly tool: string | undefined
  readonly operations: readonly T[]
  /** Index of the run's first operation in the setup. */
  readonly start: number
}

/** Consecutive operations with the same tool; each operation without a tool is a run of its own. */
export function toolRuns<T extends WithTool>(operations: readonly T[]): ToolRun<T>[] {
  const runs: { tool: string | undefined; operations: T[]; start: number }[] = []
  operations.forEach((op, i) => {
    const last = runs.at(-1)
    if (last !== undefined && op.tool !== undefined && last.tool === op.tool)
      last.operations.push(op)
    else runs.push({ tool: op.tool, operations: [op], start: i })
  })
  return runs
}

type Setups = readonly { readonly operations: readonly WithTool[] }[]

/** The tool that stays in the spindle into setup `index` from the setup before, if its first. */
export function carriedTool(setups: Setups, index: number): string | undefined {
  const first = setups[index]?.operations[0]?.tool
  const before = index > 0 ? setups[index - 1]?.operations.at(-1)?.tool : undefined
  return first !== undefined && first === before ? first : undefined
}

/** Tool changes of setup `index`: one per run, less the start when the tool is carried over. */
export function setupToolChanges(setups: Setups, index: number): number {
  const runs = toolRuns(setups[index]?.operations ?? []).length
  return carriedTool(setups, index) === undefined ? runs : runs - 1
}

/**
 * The time a tool run's links save (s): the lowered links into its operations after the first
 * (`indices`: the run's positions in the setup). A run's time is its toolpaths' estimates minus
 * this, as the setup's is minus the summary's `savedSeconds` (one source: the links summary of
 * `plan.warning.list`, DF64 L3, docs/modes/safe-links.md#where-it-runs).
 */
export function runLinkSavings(
  lowered: readonly { readonly index: number; readonly savedSeconds: number }[],
  indices: readonly number[],
): number {
  const own = new Set(indices)
  let saved = 0
  for (const l of lowered) if (own.has(l.index) && own.has(l.index - 1)) saved += l.savedSeconds
  return saved
}
