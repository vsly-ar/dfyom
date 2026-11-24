// The viewport's run scene (`<Viewport run={useRunScene(mode)} />`): the chosen setup's toolpaths
// (`plan.toolpath.get` per plan operation, re-read when a run starts, since the run regenerates
// stale ones), the done part from following `wpos` along them, and the tool marker at `wpos`, all
// placed on the part by the setup's frame (task E2: one program per setup, in its WCS), and the
// machine travel with its home position in work coordinates while connected (DF33). Positions
// are in the setup frame: a work zero set on a tool run's Z reference surface (DF69, the host's
// `zeroLevel`) is added back, and a tool-change wait onto such a surface shows the surface and
// its touch-off spot (docs/modes/z-reference.md#dfyom-run).
// `null` outside run mode. Doc: docs/conventions/ui.md#viewport-task-35 (run scene)
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppMode } from '../../../../core/modes'
import type { UnitSystem } from '../../../../core/project/document'
import type { Toolpath } from '../../../../core/toolpath/model'
import { useReplica, useShell } from '../../shell/ShellContext'
import { homedPosition } from '../../../../core/run/grbl/envelope'
import { lengthSource } from '../../messages/dfm'
import { planMessages } from '../../messages/plan'
import {
  advancePlayback,
  toolpathLines,
  type RunEnvelope,
  type RunScene,
  type ToolpathLines,
  type ZRefOverlay,
} from '../../viewport'
import type { ZRefRunView } from '../plan/plan-store'
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
  const wpos = isConnected(status) ? status.wpos : null
  // DF69: Z0 on a surface below the stock top: the setup frame is that much lower
  const level = isConnected(status) ? (status.zeroLevel ?? 0) : 0
  // by value: a status that moved nothing (a tool-change wait's elapsed time) redraws nothing (P7)
  const tool = useMemo(
    (): readonly [number, number, number] | null =>
      wpos === null ? null : [wpos[0], wpos[1], wpos[2] + level],
    [wpos === null, wpos?.[0], wpos?.[1], wpos?.[2], level],
  )
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
  const env = isConnected(status) ? status.envelope : undefined
  const wz = status.workZero
  const envelope = useMemo((): RunEnvelope | undefined => {
    if (env === undefined) return undefined
    const w = (v: number, i: number) => v - (wz[i] ?? 0) + (i === 2 ? level : 0)
    const home = homedPosition(env)
    return {
      min: [w(-env.travel[0], 0), w(-env.travel[1], 1), w(-env.travel[2], 2)],
      max: [w(0, 0), w(0, 1), w(0, 2)],
      home: [w(home[0], 0), w(home[1], 1), w(home[2], 2)],
    }
    // workZero values, not the array identity (a new status each report)
  }, [
    env?.travel[0],
    env?.travel[1],
    env?.travel[2],
    env?.homingMask,
    env?.pullOff,
    wz[0],
    wz[1],
    wz[2],
    level,
  ])
  const zRef = useWaitZRef(planId, setupId, units)
  return useMemo(
    () =>
      active
        ? {
            lines,
            done,
            tool,
            ...(frame === undefined ? {} : { frame }),
            ...(envelope === undefined ? {} : { envelope }),
            ...(zRef === undefined ? {} : { zRef }),
          }
        : null,
    [active, lines, done, tool, frame, envelope, zRef],
  )
}

const noDrag = (): void => {}

/**
 * At a tool-change wait onto a surface other than the stock top (DF69): that tool run's reference
 * surface and touch-off spot from `plan.warning.list` (read once per wait), not draggable.
 */
function useWaitZRef(
  planId: string | undefined,
  setupId: string | undefined,
  units: UnitSystem,
): ZRefOverlay | undefined {
  const { bridge } = useShell()
  const status = useRun((s) => s.status)
  const job = activeJob(status)
  const tc = job?.phase === 'toolChange' ? job.toolChange : undefined
  const n = tc?.at === undefined ? undefined : tc.n
  const key = n === undefined || job === undefined ? undefined : `${job.jobId}:${n}`
  const [run, setRun] = useState<{ key: string; view: ZRefRunView } | undefined>(undefined)
  useEffect(() => {
    if (key === undefined || planId === undefined || n === undefined) return
    let live = true
    void bridge.call('plan.warning.list', { planId }).then((r) => {
      if (!live || !r.ok) return
      const views = (r.value as { zRefs?: ZRefRunView[] }).zRefs ?? []
      const view = views.find(
        (v) => v.toolNumber === n && (setupId === undefined || v.setupId === setupId),
      )
      if (view !== undefined) setRun({ key, view })
    })
    return () => {
      live = false
    }
  }, [bridge, key, planId, setupId, n])
  return useMemo((): ZRefOverlay | undefined => {
    const z = run?.view.zRef
    const outline = run?.view.outline
    if (run === undefined || run.key !== key || z == null || outline == null) return undefined
    return {
      key: run.key,
      patch: outline.patch,
      level: z.level,
      at: z.at,
      clearance: outline.clearance,
      caption: planMessages.toolChanges.zSpotCaption(
        lengthSource(z.at[0], units),
        lengthSource(z.at[1], units),
      ),
      draggable: false,
      dragging: false,
      onDrag: noDrag,
    }
  }, [run, key, units])
}
