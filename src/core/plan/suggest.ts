/**
 * `plan.tool.suggest`: library tools that pass the tool checks of a plan operation, ranked by
 * the design's tool (its library item → matching type and diameter) → preset for the stock's
 * material class → already used in this plan → largest diameter.
 * Doc: docs/modes/plan-v0.1.md#tool-assignment-and-checks,
 * docs/modes/plan-v0.2.md#tool-resolution-from-the-design-tool-field
 */
import type { Region2dPort } from '../geometry/2d/port'
import type { LibraryItem } from '../library/library-item'
import { Tool } from '../library/tool'
import type { PlanWarning } from './checks'
import { isDesignTool, matchesDesign, planDesignTool } from './design-tool'
import { evaluateOperation } from './evaluate'
import type { LoadedPlan } from './plan'
import type { PlanOperationDTO } from './plan.dto'

export interface ToolSuggestion {
  readonly toolLibraryItemId: string
  readonly name: string
  readonly diameter: number
  /** The library item the design's specific tool was taken from. */
  readonly designTool: boolean
  /** Same type and diameter (and RE) as the design's tool within 0.01 mm. */
  readonly matchesDesign: boolean
  readonly hasPreset: boolean
  readonly usedInPlan: boolean
  /** Why it ranks where it does, e.g. "has a preset for aluminum". */
  readonly reasons: readonly string[]
}

/** Findings that disqualify a tool: the tool and reach checks, not missing feeds or strategy. */
const DISQUALIFYING = new Set(['tool', 'stickout', 'stepdown'])

/**
 * The first check `tool` fails for the plan operation (judged with its own default stickout and
 * preset), or undefined when it passes. Without `tool`: the operation as assigned (its tool,
 * stickout and preset). With the 2D port the width checks of general shapes count (T3).
 */
export function failedCheck(
  plan: LoadedPlan,
  op: PlanOperationDTO,
  tool?: Tool,
  port?: Region2dPort,
): PlanWarning | undefined {
  const { stickout: _s, presetName: _p, ...base } = op
  const e =
    tool === undefined
      ? evaluateOperation(plan, op, undefined, undefined, port)
      : evaluateOperation(plan, base, tool, undefined, port)
  return e.findings.find(
    (f) =>
      f.severity === 'error' &&
      f.field !== undefined &&
      DISQUALIFYING.has(f.field) &&
      f.rule !== 'unresolved',
  )
}

/** Ranked candidates among `items` (tool items of the library) for one plan operation. */
export function suggestTools(
  plan: LoadedPlan,
  op: PlanOperationDTO,
  items: readonly LibraryItem[],
  port?: Region2dPort,
): ToolSuggestion[] {
  const materialClass = plan.stock.material.class
  const design = planDesignTool(plan, op)
  const used = new Set(
    plan.dto.snapshots.filter((s) => s.kind === 'tool').map((s) => s.libraryItemId),
  )
  const out: ToolSuggestion[] = []
  for (const item of items) {
    const tool = item.values
    if (!(tool instanceof Tool)) continue
    if (failedCheck(plan, op, tool, port) !== undefined) continue
    const designTool = design.mapOr(false, (d) => isDesignTool(item, d))
    const matches = design.mapOr(false, (d) => matchesDesign(tool, d))
    const hasPreset = tool.presets.some((p) =>
      p.materialClass.mapOr(false, (c) => c === materialClass),
    )
    const usedInPlan = used.has(item.id)
    const label = design.mapOr('', (d) => d.label)
    const reasons = [
      ...(designTool ? ["the design's tool"] : matches ? [`matches the design's ${label}`] : []),
      ...(hasPreset ? [`has a preset for ${materialClass}`] : []),
      ...(usedInPlan ? ['already used in this plan (fewer tool changes)'] : []),
      `diameter ${tool.diameter.canonical} mm`,
    ]
    out.push({
      toolLibraryItemId: item.id,
      name: tool.name,
      diameter: tool.diameter.canonical,
      designTool,
      matchesDesign: matches,
      hasPreset,
      usedInPlan,
      reasons,
    })
  }
  return out.sort(
    (a, b) =>
      Number(b.designTool) - Number(a.designTool) ||
      Number(b.matchesDesign) - Number(a.matchesDesign) ||
      Number(b.hasPreset) - Number(a.hasPreset) ||
      Number(b.usedInPlan) - Number(a.usedInPlan) ||
      b.diameter - a.diameter ||
      a.toolLibraryItemId.localeCompare(b.toolLibraryItemId),
  )
}
