/**
 * `plan.tool.suggest`: library tools that pass the tool checks of a plan operation, ranked by
 * preset for the stock's material class → already used in this plan → largest diameter.
 * Doc: docs/modes/plan-v0.1.md#tool-assignment-and-checks
 */
import type { LibraryItem } from '../library/library-item'
import { Tool } from '../library/tool'
import { evaluateOperation } from './evaluate'
import type { LoadedPlan } from './plan'
import type { PlanOperationDTO } from './plan.dto'

export interface ToolSuggestion {
  readonly toolLibraryItemId: string
  readonly name: string
  readonly diameter: number
  readonly hasPreset: boolean
  readonly usedInPlan: boolean
  /** Why it ranks where it does, e.g. "has a preset for aluminum". */
  readonly reasons: readonly string[]
}

/** Findings that disqualify a tool: the tool and reach checks, not missing feeds or strategy. */
const DISQUALIFYING = new Set(['tool', 'stickout', 'stepdown'])

/** Ranked candidates among `items` (tool items of the library) for one plan operation. */
export function suggestTools(
  plan: LoadedPlan,
  op: PlanOperationDTO,
  items: readonly LibraryItem[],
): ToolSuggestion[] {
  // A candidate is judged with its own default stickout and preset.
  const { stickout: _s, presetName: _p, ...base } = op
  const materialClass = plan.stock.material.class
  const used = new Set(
    plan.dto.snapshots.filter((s) => s.kind === 'tool').map((s) => s.libraryItemId),
  )
  const out: ToolSuggestion[] = []
  for (const item of items) {
    const tool = item.values
    if (!(tool instanceof Tool)) continue
    const e = evaluateOperation(plan, base, tool)
    const failing = e.findings.some(
      (f) =>
        f.severity === 'error' &&
        f.field !== undefined &&
        DISQUALIFYING.has(f.field) &&
        f.rule !== 'unresolved',
    )
    if (failing) continue
    const hasPreset = tool.presets.some((p) =>
      p.materialClass.mapOr(false, (c) => c === materialClass),
    )
    const usedInPlan = used.has(item.id)
    const reasons = [
      ...(hasPreset ? [`has a preset for ${materialClass}`] : []),
      ...(usedInPlan ? ['already used in this plan (fewer tool changes)'] : []),
      `diameter ${tool.diameter.canonical} mm`,
    ]
    out.push({
      toolLibraryItemId: item.id,
      name: tool.name,
      diameter: tool.diameter.canonical,
      hasPreset,
      usedInPlan,
      reasons,
    })
  }
  return out.sort(
    (a, b) =>
      Number(b.hasPreset) - Number(a.hasPreset) ||
      Number(b.usedInPlan) - Number(a.usedInPlan) ||
      b.diameter - a.diameter ||
      a.toolLibraryItemId.localeCompare(b.toolLibraryItemId),
  )
}
