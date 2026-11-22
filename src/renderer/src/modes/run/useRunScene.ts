// The viewport's run scene (`<Viewport run={useRunScene(mode)} />`): the chosen setup's toolpaths
// (`plan.toolpath.get` per plan operation, re-read when a run starts, since the run regenerates
// stale ones), the done part from following `wpos` along them, and the tool marker at `wpos`, all
// placed on the part by the setup's frame (task E2: one program per setup, in its WCS).
// `null` outside run mode. Doc: docs/conventions/ui.md#viewport-task-35 (run scene)
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppMode } from '../../../../core/modes'
import type { Toolpath } from '../../../../core/toolpath/model'
import { useReplica, useShell } from '../../shell/ShellContext'
import { advancePlayback, toolpathLines, type RunScene, type ToolpathLines } from '../../viewport'
import { activeJob, isConnected } from './machine-state'
import { planRunInfo, setupPlacement } from './plan-info'
import { useRun } from './run-store'

export function useRunScene(mode: AppMode): RunScene | null {
  const { bridge } = useShell()
  const replica = useReplica()
  const status = useRun((s) => s.status)
  const planId = useRun((s) => s.planId)
  const setupId = useRun((s) => s.setupId)
  const jobId = useRun((s) => s.jobId)
  const ended = useRun((s) => s.ended)
  const plan =
    replica.status === 'open' && planId !== undefined ? replica.doc.plans[planId] : undefined
  const operations = useMemo(
    () => (plan ? planRunInfo(plan, setupId).operations : []),
    [plan, setupId],
  )
  const units = replica.status === 'open' ? replica.doc.unitSystem : 'mm'
  const frame = useMemo(
    () => (plan ? setupPlacement(plan, setupId, units)?.frame : undefined),
    [plan, setupId, units],
  )
  const [lines, setLines] = useState<ToolpathLines | null>(null)
  const active = mode === 'run'

  // the toolpaths, in machining order
  useEffect(() => {
    if (!active || planId === undefined || operations.length === 0) {
      setLines(null)
      return
    }
    let live = true
    void Promise.all(
      operations.map((planOperationId) =>
        bridge.call('plan.toolpath.get', { planId, planOperationId }),
      ),
    ).then((replies) => {
      if (!live) return
      const toolpaths = replies.flatMap((r) =>
        r.ok ? [(r.value as { toolpath: Toolpath | null }).toolpath].filter((t) => t !== null) : [],
      )
      setLines(toolpaths.length === 0 ? null : toolpathLines(toolpaths))
    })
    return () => {
      live = false
    }
  }, [active, bridge, planId, operations, jobId])

  // playback: a cursor that only moves forward during one run
  const cursor = useRef({ jobId: undefined as string | undefined, done: 0 })
  const job = activeJob(status)
  const tool = isConnected(status) ? status.wpos : null
  let done = 0
  if (lines !== null) {
    if (job !== undefined && tool !== null) {
      if (cursor.current.jobId !== job.jobId) cursor.current = { jobId: job.jobId, done: 0 }
      cursor.current.done = advancePlayback(lines, cursor.current.done, tool)
      done = cursor.current.done
    } else if (ended?.kind === 'done' && ended.jobId === cursor.current.jobId) {
      done = lines.segments
    } else if (ended !== undefined && ended.jobId === cursor.current.jobId) {
      done = cursor.current.done
    }
  }
  return useMemo(
    () => (active ? { lines, done, tool, ...(frame === undefined ? {} : { frame }) } : null),
    [active, lines, done, tool, frame],
  )
}
