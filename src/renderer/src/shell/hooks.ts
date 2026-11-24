// Shell hooks over the bridge and the replica: undo/redo steps, jobs, agent sessions, the window
// title. Doc: docs/conventions/ui.md#undo-and-redo, #jobs-and-progress, #app-shell
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { AgentSessionInfo, CallOpts, CallReply, PreloadApi } from '../../../shared/preload-api'
import { shellMessages as m } from '../messages/shell'
import { isDirty, type Replica } from '../state/replica'
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
  readonly pausable?: false
  readonly progress?: { readonly done: number; readonly total?: number; readonly label?: string }
}

export interface Jobs {
  readonly jobs: readonly JobView[]
  pause(id: string): void
  resume(id: string): void
  cancel(id: string): void
}

const NO_JOBS: readonly JobView[] = []

/**
 * One window's `job.list` reads, shared by every `useJobs` (the status bar and the Apply button):
 * read on job events and on `refresh`, polled every `JOB_POLL_MS` while a job runs, never while
 * none does (P7, idle cost: before, each reader polled on its own). Overlapping reads coalesce.
 * Doc: docs/conventions/ui.md#jobs-and-progress
 */
export interface JobsFeed {
  subscribe(listener: () => void): () => void
  get(): readonly JobView[]
  refresh(): void
}

export function createJobsFeed(
  bridge: Pick<PreloadApi, 'call'>,
  events: Pick<Replica, 'onEvent'>,
): JobsFeed {
  let jobs: readonly JobView[] = NO_JOBS
  let timer: ReturnType<typeof setTimeout> | undefined
  let reading = false
  let again = false
  let offEvents: (() => void) | undefined
  const listeners = new Set<() => void>()
  const read = (): void => {
    if (listeners.size === 0) return
    if (reading) {
      again = true
      return
    }
    clearTimeout(timer)
    timer = undefined
    reading = true
    void bridge.call('job.list', {}).then((r) => {
      reading = false
      if (listeners.size === 0) return
      const list = r.ok ? ((r.value as { jobs?: JobInfo[] }).jobs ?? []) : []
      jobs = list
        .filter((j) => j.state !== 'finished')
        .map((j): JobView => ({
          id: j.jobId,
          label: m.jobs.labels[j.name] ?? j.name,
          state: j.state === 'paused' ? 'paused' : 'running',
          ...(j.pausable === false ? { pausable: false } : {}),
          progress: j.progress,
        }))
      for (const l of [...listeners]) l()
      if (again) {
        again = false
        read()
      } else if (jobs.some((j) => j.state === 'running')) timer = setTimeout(read, JOB_POLL_MS)
    })
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      offEvents ??= events.onEvent((e) => {
        if (e.type === 'job') read()
      })
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        offEvents?.()
        offEvents = undefined
        clearTimeout(timer)
        timer = undefined
        again = false
        jobs = NO_JOBS
      }
    },
    get: () => jobs,
    refresh: read,
  }
}

const jobsFeeds = new WeakMap<Replica, JobsFeed>()

/** Running and paused jobs of the bound project, from the window's shared `JobsFeed`. */
export function useJobs(): Jobs {
  const { bridge, replica } = useShell()
  const state = useReplica()
  const key = state.status === 'open' ? state.key : undefined
  const feed = useMemo(() => {
    let f = jobsFeeds.get(replica)
    if (f === undefined) jobsFeeds.set(replica, (f = createJobsFeed(bridge, replica)))
    return f
  }, [bridge, replica])
  const jobs = useSyncExternalStore(feed.subscribe, feed.get)
  useEffect(() => {
    if (key !== undefined) feed.refresh()
  }, [feed, key])

  const control = useCallback(
    (name: string) => (id: string) => {
      void bridge.call(name, { jobId: id }).then(() => feed.refresh())
    },
    [bridge, feed],
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
