// Shell hooks over the bridge and the replica: undo/redo steps, jobs, agent sessions, the window
// title. Doc: docs/conventions/ui.md#undo-and-redo, #jobs-and-progress, #app-shell
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { AgentSessionInfo, CallOpts, CallReply } from '../../../shared/preload-api'
import { shellMessages as m } from '../messages/shell'
import { isDirty } from '../state/replica'
import type { JobView } from '../ui'
import { useReplica, useShell } from './ShellContext'

interface HistoryItem {
  readonly title: string
  readonly source: { readonly kind: string }
}

function stepName(items: unknown): string | null {
  const top = Array.isArray(items) ? (items[0] as HistoryItem | undefined) : undefined
  return top === undefined ? null : m.historyStep(top.title, top.source.kind)
}

export interface HistorySteps {
  /** The step undo would revert, or null. */
  readonly undo: string | null
  readonly redo: string | null
  step(which: 'undo' | 'redo'): void
}

/** The top undo/redo steps of the bound project (`history.list`), re-read after every change. */
export function useHistorySteps(): HistorySteps {
  const { bridge } = useShell()
  const replica = useReplica()
  const key = replica.status === 'open' ? replica.key : undefined
  const revision = replica.status === 'open' ? replica.revision : -1
  const [steps, setSteps] = useState<{ undo: string | null; redo: string | null }>({
    undo: null,
    redo: null,
  })
  useEffect(() => {
    if (key === undefined) return
    let live = true
    void bridge.call('history.list', { limit: 1 }).then((r) => {
      if (!live) return
      if (!r.ok) return setSteps({ undo: null, redo: null })
      const v = r.value as { undo?: unknown; redo?: unknown }
      setSteps({ undo: stepName(v.undo), redo: stepName(v.redo) })
    })
    return () => {
      live = false
    }
  }, [bridge, key, revision])
  const step = useCallback(
    (which: 'undo' | 'redo') => {
      if (key !== undefined) void bridge.call(`history.${which}`, {})
    },
    [bridge, key],
  )
  return key === undefined ? { undo: null, redo: null, step } : { ...steps, step }
}

/**
 * Sends one command through the window's session (one gesture = one undo step; `opts.gesture` for
 * the steps of a live edit, docs/architecture/commands.md#gestures-live-edits).
 */
export function useCall(): (name: string, args: object, opts?: CallOpts) => Promise<CallReply> {
  const { bridge, pending } = useShell()
  return useCallback(
    async (name, args, opts) => {
      const r = await (opts === undefined ? bridge.call(name, args) : bridge.call(name, args, opts))
      // a library edit is pending in projects whose draft plans copy it, without a project event
      if (name.startsWith('library.')) pending.refresh()
      return r
    },
    [bridge, pending],
  )
}

/**
 * Cancels a live edit (Escape in a field's adjust popover): `history.undo { gesture }` reverts and
 * discards the gesture's entry if it is still on top. Resolves false when nothing was reverted
 * (someone committed after it), so the field keeps the value and says so.
 */
export function useCancelGesture(): (gesture: string) => Promise<boolean> {
  const { bridge } = useShell()
  return useCallback(
    async (gesture) => {
      const r = await bridge.call('history.undo', { gesture })
      return r.ok && (r.value as { entrySeq?: unknown }).entrySeq !== null
    },
    [bridge],
  )
}

/** Polling interval of `job.list` while a job runs (progress ticks are not in the action log). */
export const JOB_POLL_MS = 500

interface JobInfo {
  readonly jobId: string
  readonly name: string
  readonly state: 'running' | 'paused' | 'finished'
  readonly progress?: { readonly done: number; readonly total?: number; readonly label?: string }
}

export interface Jobs {
  readonly jobs: readonly JobView[]
  pause(id: string): void
  resume(id: string): void
  cancel(id: string): void
}

const NO_JOBS: readonly JobView[] = []

/** Running and paused jobs of the bound project: read on job events, polled while any runs. */
export function useJobs(): Jobs {
  const { bridge, replica } = useShell()
  const state = useReplica()
  const key = state.status === 'open' ? state.key : undefined
  const [jobs, setJobs] = useState<readonly JobView[]>([])
  const [tick, setTick] = useState(0)

  useEffect(
    () =>
      replica.onEvent((e) => {
        if (e.type === 'job') setTick((t) => t + 1)
      }),
    [replica],
  )
  useEffect(() => {
    if (key === undefined) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = () => {
      void bridge.call('job.list', {}).then((r) => {
        if (!live) return
        const list = r.ok ? ((r.value as { jobs?: JobInfo[] }).jobs ?? []) : []
        const active = list
          .filter((j) => j.state !== 'finished')
          .map((j): JobView => ({
            id: j.jobId,
            label: m.jobs.labels[j.name] ?? j.name,
            state: j.state === 'paused' ? 'paused' : 'running',
            progress: j.progress,
          }))
        setJobs(active)
        if (active.some((j) => j.state === 'running')) timer = setTimeout(read, JOB_POLL_MS)
      })
    }
    read()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [bridge, key, tick])

  const control = useCallback(
    (name: string) => (id: string) => {
      void bridge.call(name, { jobId: id }).then(() => setTick((t) => t + 1))
    },
    [bridge],
  )
  return {
    jobs: key === undefined ? NO_JOBS : jobs,
    pause: control('job.pause'),
    resume: control('job.resume'),
    cancel: control('job.abort'),
  }
}

/** Attached agent sessions (the "agent connected" indicator). */
export function useAgentSessions(): readonly AgentSessionInfo[] {
  const { bridge } = useShell()
  const [sessions, setSessions] = useState<readonly AgentSessionInfo[]>([])
  useEffect(() => {
    let live = true
    let pushed = false
    // a push that arrives before the list's answer is newer: keep it
    const off = bridge.agents.onSessions((s) => {
      pushed = true
      setSessions(s)
    })
    void bridge.agents.list().then((s) => {
      if (live && !pushed) setSessions(s)
    })
    return () => {
      live = false
      off()
    }
  }, [bridge])
  return sessions
}

/** The native title bar shows the project name and its edit state only (decision 17). */
export function useWindowTitle(): void {
  const replica = useReplica()
  const title =
    replica.status === 'open' ? m.windowTitle(replica.doc.name, isDirty(replica)) : m.appName
  useEffect(() => {
    document.title = title
  }, [title])
}

/** A CSS media query as React state. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
  )
}
