/**
 * Tool resolution from the design tool field: which tool `plan.create` and a rebuild assign to a
 * plan operation (the assignment table), and the derived findings `plan.designToolReplaced`,
 * `plan.designToolFailed` and `plan.toolUnresolved` of `toolSource: 'design'` operations.
 * Pure: the library arrives as items; the plan is read only from its own record.
 * Doc: docs/modes/plan-v0.2.md#tool-resolution-from-the-design-tool-field
 */
import type { LibraryItem } from '../library/library-item'
import type { PlanWarning } from './checks'
import { planDesignTool } from './design-tool'
import type { LoadedPlan } from './plan'
import type { PlanOperationDTO } from './plan.dto'
import { failedCheck, suggestTools, type ToolSuggestion } from './suggest'

export type ToolResolution =
  /** The design's specific tool: the plan's copy of the design's snapshot. */
  | { readonly kind: 'copy'; readonly snapshotId: string }
  /** A library tool (the plan takes or reuses a copy). */
  | { readonly kind: 'item'; readonly item: LibraryItem }
  /** No tool: a locked generalized tool without a matching library tool that passes. */
  | { readonly kind: 'none' }
  /** Nothing fits: the operation keeps its current tool (a new one stays without). */
  | { readonly kind: 'keep' }

/**
 * The assignment table (docs/modes/plan-v0.2.md#tool-resolution-from-the-design-tool-field):
 * specific unlocked → the design's tool if it passes the plan checks, else the first suggestion
 * (none fits: the design's tool, its checks report why); specific locked → the design's tool,
 * always; generalized unlocked or none → the first suggestion (matching tools rank first);
 * generalized locked → the best matching suggestion, else no tool.
 */
export function resolveTool(
  plan: LoadedPlan,
  op: PlanOperationDTO,
  library: readonly LibraryItem[],
): ToolResolution {
  const suggestions = suggestTools(plan, op, library)
  const item = (s: ToolSuggestion | undefined): ToolResolution => {
    const found = library.find((i) => i.id === s?.toolLibraryItemId)
    return found === undefined ? { kind: 'keep' } : { kind: 'item', item: found }
  }
  const design = planDesignTool(plan, op)
  if (design.isNone()) return item(suggestions[0])
  const d = design.unwrap()
  if (d.specific !== undefined) {
    const copy: ToolResolution = { kind: 'copy', snapshotId: d.specific.snapshotId }
    if (d.locked || suggestions.length === 0) return copy
    return failedCheck(plan, op, d.specific.tool) === undefined ? copy : item(suggestions[0])
  }
  if (!d.locked) return item(suggestions[0])
  const match = suggestions.find((s) => s.matchesDesign)
  return match === undefined ? { kind: 'none' } : item(match)
}

const FIXES =
  'assign another tool in the plan, change the machine, extend the stickout, or change the design'

/**
 * Findings of the design tool field, derived from the plan's record on every call (operations
 * with `toolSource: 'design'` only; a plan assignment wins inside the plan):
 * - `plan.designToolReplaced` (info): an unlocked specific design tool fails a plan check and
 *   another tool is assigned;
 * - `plan.designToolFailed` (error): a locked specific design tool fails a plan check (it stays);
 * - `plan.toolUnresolved` (error): a locked generalized tool has no matching library tool.
 * `params.alternatives` / `alternativeIds` list the fitting library tools (comma-separated).
 */
export function designToolFindings(
  plan: LoadedPlan,
  library: readonly LibraryItem[],
): PlanWarning[] {
  const out: PlanWarning[] = []
  for (const op of plan.operations) {
    if (op.toolSource !== 'design') continue
    const design = planDesignTool(plan, op)
    if (design.isNone()) continue
    const d = design.unwrap()
    const alternatives = () => {
      const s = suggestTools(plan, op, library)
      return {
        alternatives: s.map((t) => t.name).join(', '),
        alternativeIds: s.map((t) => t.toolLibraryItemId).join(','),
      }
    }
    const listed = (a: { alternatives: string }) =>
      a.alternatives === '' ? 'no library tool fits' : `fitting: ${a.alternatives}`
    const base = { planOperationId: op.id, field: 'tool' }
    if (d.specific !== undefined) {
      const assigned = op.tool === d.specific.snapshotId
      // the assigned design tool as the plan uses it; another one as resolution judged it
      const failed = assigned ? failedCheck(plan, op) : failedCheck(plan, op, d.specific.tool)
      if (failed === undefined) continue
      const check = { check: failed.rule, checkField: failed.field ?? 'tool', designTool: d.label }
      if (d.locked && assigned) {
        const a = alternatives()
        out.push({
          ...base,
          code: 'plan.designToolFailed',
          severity: 'error',
          message: `the design's locked tool ${d.label} fails the plan check: ${failed.message} (${listed(a)}); ${FIXES}`,
          rule: failed.rule,
          params: { ...check, ...a },
        })
      } else if (!d.locked && op.tool !== undefined && !assigned) {
        const name = plan.tools.get(op.tool)?.name ?? op.tool
        out.push({
          ...base,
          code: 'plan.designToolReplaced',
          severity: 'info',
          message: `the design's tool ${d.label} fails the plan check (${failed.message}): ${name} is assigned instead`,
          rule: failed.rule,
          params: { ...check, tool: name },
        })
      }
    } else if (d.locked && op.tool === undefined) {
      const a = alternatives()
      out.push({
        ...base,
        code: 'plan.toolUnresolved',
        severity: 'error',
        message: `no library tool matching the design's locked ${d.label} passes the plan checks (${listed(a)}); add one to the library or ${FIXES}`,
        rule: 'noMatchingTool',
        params: { designTool: d.label, ...a },
      })
    }
  }
  return out
}
