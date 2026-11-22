// The viewport's plan scene (task 3.7): the chosen plan's toolpaths in machining order (feeds,
// rapids and plunges in their colours) with the work zero marker, drawn by the run layer without
// playback (nothing done, no tool marker). Current and outdated toolpaths are drawn, outdated ones
// (stale or waiting for Apply, task P3) dimmed; operations without one are left out. Snapshot scene (task E3b): the part drawn is the plan's part (its
// design snapshot with plan-only edits, evaluated as the plan's own subject) on the plan's stock
// copy, its edited operations tinted. `null` outside plan mode.
// Doc: docs/conventions/ui.md#plan-mode-task-37, docs/modes/plan-v0.2.md#plan-only-edits-and-the-snapshot-scene
import { useMemo } from 'react'
import type { EvaluationStatus } from '../../../../core/design/evaluation'
import type { AppMode } from '../../../../core/modes'
import type { PlanDTO } from '../../../../core/plan/plan.dto'
import type { Toolpath } from '../../../../core/toolpath/model'
import { usePlanEvaluation, useReplica } from '../../shell/ShellContext'
import { toolpathLines, type Box, type RunScene, type ViewportMesh } from '../../viewport'
import { chosenPlan, editedOperations, planPart } from './model'
import { usePlanData, usePlanState } from './plan-store'

/** The plan the plan scene shows, or undefined (another mode, no project or no plan). */
function useScenePlan(mode: AppMode): PlanDTO | undefined {
  const replica = useReplica()
  const planId = usePlanState((s) => s.planId)
  const doc = replica.status === 'open' ? replica.doc : undefined
  return mode !== 'plan' || doc === undefined ? undefined : chosenPlan(doc, planId)
}

export function usePlanScene(mode: AppMode): RunScene | null {
  const plan = useScenePlan(mode)
  const data = usePlanData(plan?.id)
  return useMemo(() => {
    if (data === undefined || plan === undefined) return null
    const drawn = plan.setups[0]!.operations.flatMap((o) => {
      const entry = data.toolpaths[o.id]
      return entry?.toolpath ? [entry] : []
    })
    const toolpaths = drawn.map((e) => e.toolpath as Toolpath)
    // outdated (stale, or the plan waits for Apply): dimmed until regenerated (P3)
    const outdated = drawn.map((e) => e.stale || e.pendingApply === true || data.pendingApply)
    return {
      lines: toolpaths.length === 0 ? null : toolpathLines(toolpaths),
      done: 0,
      tool: null,
      ...(outdated.some(Boolean) ? { outdated } : {}),
    }
  }, [data, plan])
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
