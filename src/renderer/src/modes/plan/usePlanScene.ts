// The viewport's plan scene (task 3.7): the chosen plan's toolpaths in machining order (feeds,
// rapids and plunges in their colours) with the work zero marker, drawn by the run layer without
// playback (nothing done, no tool marker). Current and outdated toolpaths are drawn; operations
// without one are left out. `null` outside plan mode. Doc: docs/conventions/ui.md#plan-mode-task-37
import { useMemo } from 'react'
import type { AppMode } from '../../../../core/modes'
import type { Toolpath } from '../../../../core/toolpath/model'
import { useReplica } from '../../shell/ShellContext'
import { toolpathLines, type RunScene } from '../../viewport'
import { chosenPlan } from './model'
import { usePlanData, usePlanState } from './plan-store'

export function usePlanScene(mode: AppMode): RunScene | null {
  const replica = useReplica()
  const planId = usePlanState((s) => s.planId)
  const doc = replica.status === 'open' ? replica.doc : undefined
  const plan = doc === undefined ? undefined : chosenPlan(doc, planId)
  const active = mode === 'plan' && plan !== undefined
  const data = usePlanData(active ? plan.id : undefined)
  return useMemo(() => {
    if (!active || data === undefined || plan === undefined) return null
    const toolpaths = plan.setups[0]!.operations.flatMap((o) => {
      const tp = data.toolpaths[o.id]?.toolpath
      return tp ? [tp as Toolpath] : []
    })
    return { lines: toolpaths.length === 0 ? null : toolpathLines(toolpaths), done: 0, tool: null }
  }, [active, data, plan])
}
