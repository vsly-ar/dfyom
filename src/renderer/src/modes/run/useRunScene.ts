// The viewport's run scene (`<Viewport run={useRunScene(mode)} />`): the chosen setup's toolpaths
// (`plan.toolpath.get` per plan operation, re-read when a run starts, since the run regenerates
// stale ones), the done part from following `wpos` along them, and the tool marker at `wpos`, all
// placed on the part by the setup's frame (task E2: one program per setup, in its WCS), and the
// machine travel with its home position in work coordinates while connected (DF33). Positions
// are in the setup frame: a work zero set on a tool run's Z reference surface (DF69, the host's
// `zeroLevel`) is added back, and a tool-change wait onto such a surface shows the surface and
// its touch-off spot (docs/modes/z-reference.md#dfyom-run). DF64 L3: the lowered links between
// operations (`plan.warning.list`) drawn as the program moves, so playback follows the tool.
// An external gCode file (DF93) draws its own moves instead (`fileMoves`, work coordinates, no
// setup frame). DF128 GT2: the open Go to dialog's planned steps as a dashed path to a target
// marker (docs/modes/run-goto.md#preview). DF129 RC6: after an interrupted run, a ghost tool at
// its last seen position and the toolpath before it dimmed; after a crash the interrupted plan's
// toolpaths are generated again (docs/modes/run-recovery.md#implementation-rc6). DF133 RW1: the
// setup's workholding, outlined until homed with the work zero set, hidden while G54 was never
// set, and the holder ghost of the tool in the spindle at the tool marker
// (docs/modes/run-workholding.md#implementation-rw1).
// `null` outside run mode. Doc: docs/conventions/ui.md#viewport-task-35 (run scene),
// docs/modes/run.md#run-an-external-g-code-file-df93
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppMode } from '../../../../core/modes'
import type { UnitSystem } from '../../../../core/project/document'
import { linkedToolpaths } from '../../../../core/toolpath/links'
import type { Toolpath } from '../../../../core/toolpath/model'
import { useReplica, useShell } from '../../shell/ShellContext'
import { homedPosition } from '../../../../core/run/grbl/envelope'
import { fileMoves } from '../../../../core/run/gcode-file'
import { lengthSource } from '../../messages/dfm'
import { planMessages } from '../../messages/plan'
import { runMessages } from '../../messages/run'
import {
  SEGMENT,
  advancePlayback,
  toolpathLines,
  type RunEnvelope,
  type GoToOverlay,
  type RunScene,
  type ToolpathLines,
  type ZRefOverlay,
} from '../../viewport'
import type { LoweredLinkView, SetupLinksView, ZRefRunView } from '../plan/plan-store'
import { activeJob, isConnected } from './machine-state'
import { planRunInfo, setupPlacement } from './plan-info'
import { useRun } from './run-store'
import { skippedSegments } from './start-at'
import { useStartPreview } from './StartAt'
import { guardTool, runHolderGhost, runWorkholdingOverlay, type GuardTool } from './run-workholding'
import { useRunWorkholding } from './useRunWorkholding'

export function useRunScene(mode: AppMode): RunScene | null {
  const { bridge, replica: events } = useShell()
  const replica = useReplica()
  const status = useRun((s) => s.status)
  const planId = useRun((s) => s.planId)
  const setupId = useRun((s) => s.setupId)
  const jobId = useRun((s) => s.jobId)
  const ended = useRun((s) => s.ended)
  const file = useRun((s) => s.file)
  const fileLines = file?.state === 'ready' ? file.prepared.lines : undefined
  const plan =
    fileLines === undefined && replica.status === 'open' && planId !== undefined
      ? replica.doc.plans[planId]
      : undefined
  const info = useMemo(() => (plan ? planRunInfo(plan, setupId) : undefined), [plan, setupId])
  const operations = useMemo(() => info?.operations ?? [], [info])
  const runSetupId = info?.setup.id
  const units = replica.status === 'open' ? replica.doc.unitSystem : 'mm'
  const frame = useMemo(
    () => (plan ? setupPlacement(plan, setupId, units)?.frame : undefined),
    [plan, setupId, units],
  )
  const [read, setRead] = useState<{ toolpaths: Toolpath[]; current: boolean } | null>(null)
  // toolpaths generated meanwhile (the recovery's generation below, Plan mode, another window)
  const [generated, setGenerated] = useState(0)
  const [lowered, setLowered] = useState<readonly LoweredLinkView[]>([])
  const active = mode === 'run'

  // the toolpaths, in machining order
  useEffect(() => {
    if (!active || planId === undefined || operations.length === 0) {
      setRead(null)
      return
    }
    let live = true
    void Promise.all(
      operations.map((planOperationId) =>
        bridge.call('plan.toolpath.get', { planId, planOperationId }),
      ),
    ).then((replies) => {
      if (!live) return
      const got = replies.flatMap((r) =>
        r.ok ? [r.value as { toolpath: Toolpath | null; stale: boolean }] : [],
      )
      const toolpaths = got.flatMap((r) => (r.toolpath === null ? [] : [r.toolpath]))
      setRead({
        toolpaths,
        current: toolpaths.length === operations.length && got.every((r) => !r.stale),
      })
    })
    return () => {
      live = false
    }
  }, [active, bridge, planId, operations, jobId, generated])
  useEffect(
    () =>
      events.onEvent((e) => {
        if (e.type === 'job' && e.name === 'plan.toolpath.generate' && e.state === 'finished')
          setGenerated((n) => n + 1)
      }),
    [events],
  )

  // DF129 RC6: after a crash the toolpath cache went with the app, so the interrupted run's plan
  // has none to draw: generate them once (the run had, and a resume would), then read them again
  const recoveringPlan =
    status.lastRun?.interruption !== undefined && status.lastRun.planId === planId
  const missing = read !== null && read.toolpaths.length < operations.length
  const asked = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!active || !recoveringPlan || !missing || planId === undefined) return
    if (asked.current === planId) return
    asked.current = planId
    void bridge.call('plan.toolpath.generate', { planId })
  }, [active, recoveringPlan, missing, planId, bridge])

  // DF64 L3: the lowered links between operations (`plan.warning.list`), read when the setup is
  // shown, not again when a run starts: the checks are not recomputed while the run streams
  useEffect(() => {
    setLowered([])
    if (!active || planId === undefined || runSetupId === undefined) return
    let live = true
    void bridge.call('plan.warning.list', { planId }).then((r) => {
      if (!live || !r.ok) return
      const links = (r.value as { links?: SetupLinksView[] }).links
      setLowered(links?.find((l) => l.setupId === runSetupId)?.links?.lowered ?? [])
    })
    return () => {
      live = false
    }
  }, [active, bridge, planId, runSetupId])

  // the moves the program makes: the links applied when every toolpath of the setup is current
  // (they are computed from exactly those)
  const lines = useMemo((): ToolpathLines | null => {
    if (fileLines !== undefined) return fileToolpathLines(fileLines)
    if (read === null || read.toolpaths.length === 0) return null
    const linked =
      read.current && lowered.length > 0 ? linkedToolpaths(read.toolpaths, lowered) : read.toolpaths
    return toolpathLines(linked)
  }, [read, lowered, fileLines])

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
  // DF129 RC3: before a start at a line, the toolpath the run skips is dimmed like the done part
  const start = useStartPreview()
  const startLines = start?.lines
  const startLine = start?.start
  const skipped = useMemo(
    () =>
      lines === null || startLines === undefined || startLine === undefined
        ? 0
        : skippedSegments(lines, startLines, startLine, level),
    [lines, startLines, startLine, level],
  )
  // RC6: the interrupted run's last seen position (its work coordinates), while no run streams
  const lastSeen = job === undefined ? status.lastRun?.interruption?.lastReport?.wpos : undefined
  const ghost = useMemo(
    (): readonly [number, number, number] | undefined =>
      lastSeen === undefined ? undefined : [lastSeen[0], lastSeen[1], lastSeen[2] + level],
    [lastSeen?.[0], lastSeen?.[1], lastSeen?.[2], level],
  )
  let done = 0
  if (lines !== null) {
    if (job === undefined && start !== undefined) {
      done = skipped
    } else if (ghost !== undefined) {
      // the remaining toolpath from where it stopped stays live
      done = advancePlayback(lines, 0, ghost)
    } else if (job !== undefined && tool !== null) {
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
  // DF128 GT2: the open Go to dialog's steps, machine → work coordinates (as the tool marker)
  const preview = useRun((s) => s.goToPreview)
  const wco = isConnected(status)
    ? [
        status.mpos[0] - status.wpos[0],
        status.mpos[1] - status.wpos[1],
        status.mpos[2] - status.wpos[2],
      ]
    : undefined
  const goTo = useMemo((): GoToOverlay | undefined => {
    if (preview === undefined || wco === undefined) return undefined
    const w = (p: readonly [number, number, number]): [number, number, number] => [
      p[0] - wco[0]!,
      p[1] - wco[1]!,
      p[2] - wco[2]! + level,
    ]
    return { points: [w(preview.from), ...preview.points.map(w)], label: runMessages.goTo.target }
    // the offset by value (a new status each report)
  }, [preview, wco?.[0], wco?.[1], wco?.[2], level])
  const workholding = useSceneWorkholding(tool, units)
  return useMemo(
    () =>
      active
        ? {
            lines,
            done,
            tool,
            ...(workholding.overlay === undefined ? {} : { workholding: workholding.overlay }),
            ...(workholding.holder === undefined ? {} : { holder: workholding.holder }),
            ...(frame === undefined ? {} : { frame }),
            ...(envelope === undefined ? {} : { envelope }),
            ...(zRef === undefined ? {} : { zRef }),
            ...(goTo === undefined ? {} : { goTo }),
            ...(ghost === undefined ? {} : { ghost }),
          }
        : null,
    [active, lines, done, tool, frame, envelope, zRef, goTo, ghost, workholding],
  )
}

/**
 * DF133 RW1: the setup's items as the trust state allows and the holder ghost at the tool marker
 * while the position is known (homed). The tool (Q189): the one of the tool-change wait, else the
 * last wait's tool seen in this connection, else the setup's first.
 */
function useSceneWorkholding(
  tool: readonly [number, number, number] | null,
  units: UnitSystem,
): {
  overlay: RunScene['workholding']
  holder: RunScene['holder']
} {
  const wh = useRunWorkholding()
  const status = useRun((s) => s.status)
  const job = activeJob(status)
  const waiting = job?.phase === 'toolChange' ? job.toolChange?.n : undefined
  // the last tool-change wait of this connection (a new connection forgets it)
  const last = useRef<number | undefined>(undefined)
  if (!isConnected(status)) last.current = undefined
  else if (waiting !== undefined) last.current = waiting
  const n = last.current
  const overlay = useMemo(
    () =>
      wh === undefined
        ? undefined
        : runWorkholdingOverlay(wh.holding, wh.setup.id, wh.zero, wh.trust),
    [wh],
  )
  const spindle = useMemo(
    () => (wh === undefined ? undefined : guardTool(wh.plan, wh.setup, n)),
    [wh?.plan, wh?.setup, n],
  )
  const known = isConnected(status) && status.homed
  const holder = useMemo(
    () =>
      runHolderGhost(spindle, known ? tool : null, (g: GuardTool) =>
        runMessages.guard.tool(
          g.n,
          lengthSource(g.tool.diameter.canonical, units),
          lengthSource(g.stickout, units),
          g.holder?.name ?? runMessages.guard.nut(lengthSource(g.holder?.nutDiameter ?? 0, units)),
        ),
      ),
    [spindle, known, tool, units],
  )
  return useMemo(() => ({ overlay, holder }), [overlay, holder])
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

/** DF93: a file's moves as viewport lines (rapids, feeds, plunges: a feed straight down). */
function fileToolpathLines(lines: readonly string[]): ToolpathLines {
  const moves = fileMoves(lines)
  const kind = new Uint8Array(moves.segments)
  const p = moves.positions
  for (let i = 0; i < moves.segments; i++) {
    const o = i * 6
    const down = p[o + 3] === p[o] && p[o + 4] === p[o + 1] && (p[o + 5] ?? 0) < (p[o + 2] ?? 0)
    kind[i] = moves.rapid[i] === 1 ? SEGMENT.rapid : down ? SEGMENT.plunge : SEGMENT.feed
  }
  return {
    positions: p.subarray(0, moves.segments * 6),
    kind,
    segments: moves.segments,
    starts: new Uint32Array([0]),
  }
}
