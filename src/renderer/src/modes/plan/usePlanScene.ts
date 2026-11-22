// The viewport's plan scene (task 3.7): the toolpaths of the window's setup in machining order
// (feeds, rapids and plunges in their colours) with the work zero marker, placed on the part by
// the setup's WCS (`setupFrame`, v0.2 task F6: a bottom or side setup lands on the part), drawn
// by the run layer without playback (nothing done, no tool marker). Current and outdated toolpaths are drawn; operations
// without one are left out. Snapshot scene (task E3b): the part drawn is the plan's part (its
// design snapshot with plan-only edits, evaluated as the plan's own subject) on the plan's stock
// copy, its edited operations tinted. `null` outside plan mode.
// Doc: docs/conventions/ui.md#plan-mode-task-37, docs/modes/plan-v0.2.md#plan-only-edits-and-the-snapshot-scene
import { useMemo } from 'react'
import type { EvaluationStatus } from '../../../../core/design/evaluation'
import type { AppMode } from '../../../../core/modes'
import type { PlanDTO } from '../../../../core/plan/plan.dto'
import type { Toolpath } from '../../../../core/toolpath/model'
import { usePlanEvaluation, useReplica, useUi } from '../../shell/ShellContext'
import { toolpathLines, type Box, type RunScene, type ViewportMesh } from '../../viewport'
import {
  chosenPlan,
  currentSetup,
  editedOperations,
  planPart,
  planStockSize,
  setupPlacement,
} from './model'
import { usePlanData, usePlanState } from './plan-store'

/** The plan the plan scene shows, or undefined (another mode, no project or no plan). */
function useScenePlan(mode: AppMode): PlanDTO | undefined {
  const replica = useReplica()
  const planId = usePlanState((s) => s.planId)
  const doc = replica.status === 'open' ? replica.doc : undefined
  return mode !== 'plan' || doc === undefined ? undefined : chosenPlan(doc, planId)
}

export function usePlanScene(mode: AppMode): RunScene | null {
  const replica = useReplica()
  const plan = useScenePlan(mode)
  const data = usePlanData(plan?.id)
  const selected = useUi((s) => s.selection.plan)
  const last = usePlanState((s) => s.lastSelection)
  const doc = replica.status === 'open' ? replica.doc : undefined
  const setup = plan === undefined ? undefined : currentSetup(plan, selected, last)
  return useMemo(() => {
    if (data === undefined || plan === undefined || setup === undefined || doc === undefined)
      return null
    // per-setup preview (task F6): only the window's setup, placed on the part by its WCS
    const toolpaths = setup.operations.flatMap((o) => {
      const tp = data.toolpaths[o.id]?.toolpath
      return tp ? [tp as Toolpath] : []
    })
    const stock = planStockSize(doc, plan)
    return {
      lines: toolpaths.length === 0 ? null : toolpathLines(toolpaths),
      done: 0,
      tool: null,
      ...(stock === undefined ? {} : { frame: setupPlacement(setup, stock) }),
    }
  }, [data, plan, setup, doc])
}

/** The plan's part as the plan scene draws it. */
export interface PlanPartScene {
  /** The last good mesh of the plan's part; null before its first evaluation. */
  readonly mesh: ViewportMesh | null
  readonly stock: Box | null
  readonly status: EvaluationStatus
  /** Design operations edited in the plan (tinted); null when none. */
  readonly tinted: ReadonlySet<string> | null
}

/** The snapshot scene's part, or null (not in plan mode, or no plan). */
export function usePlanPartScene(mode: AppMode): PlanPartScene | null {
  const replica = useReplica()
  const plan = useScenePlan(mode)
  const evaluation = usePlanEvaluation(plan?.id)
  const doc = replica.status === 'open' ? replica.doc : undefined
  const shape = useMemo(() => {
    if (plan === undefined || doc === undefined) return undefined
    const s = planPart(doc, plan).loaded?.stock
    const edited = editedOperations(plan)
    return {
      stock:
        s === undefined
          ? null
          : {
              min: [0, 0, -s.thickness.canonical] as const,
              max: [s.length.canonical, s.width.canonical, 0] as const,
            },
      tinted: edited.size === 0 ? null : edited,
    }
  }, [plan, doc])
  if (plan === undefined || shape === undefined) return null
  return {
    mesh: evaluation?.mesh ?? null,
    stock: shape.stock,
    status: evaluation?.status ?? 'pending',
    tinted: shape.tinted,
  }
}
