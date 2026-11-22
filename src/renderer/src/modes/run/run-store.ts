// Run-mode state of one window: main's machine status (pushed, `window.dfyom.run.onStatus`), the
// run job's progress and outcome, and the window's run choices (plan, setup, time scale, jog step,
// open dialogs). One run job per setup: a run that ends with a next setup opens the setup-change
// prompt (task E2). Every action is a command over the bridge; nothing here talks to the machine.
// One store per bridge, started while a component uses it.
// Doc: docs/modes/run-v0.1.md#status, docs/conventions/ui.md#run-mode-safety-ui,
// docs/modes/plan-v0.2.md#setup-change-in-run
import { useEffect } from 'react'
import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { TimeScale } from '../../../../core/run/clock'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import type { CallReply, PreloadApi } from '../../../../shared/preload-api'
import { useShell } from '../../shell/ShellContext'
import { activeJob } from './machine-state'

/** Progress poll of the run job (`job.get`) while it runs: progress ticks are not pushed. */
export const RUN_PROGRESS_POLL_MS = 250

export interface RunProgress {
  readonly done: number
  readonly total?: number | undefined
  readonly label?: string | undefined
}

export interface RunSummaryView {
  readonly lines: number
  readonly seconds: number
  readonly elapsedSeconds: number
  readonly toolChanges: number
  readonly pauses: number
  /** The setup the run machined, and the one after it (task E2). */
  readonly setupId?: string
  readonly next?: { readonly setupId: string; readonly name: string }
}

/** How the window's last run job ended. */
export type RunEnd =
  | { readonly jobId: string; readonly kind: 'done'; readonly summary: RunSummaryView }
  | { readonly jobId: string; readonly kind: 'stopped' }
  | { readonly jobId: string; readonly kind: 'failed'; readonly error: AppErrorData }

export type Axis = 'x' | 'y' | 'z'

export interface RunState {
  readonly status: RunStatus
  /** Plan chosen in the navigator (per window). */
  readonly planId: string | undefined
  /** Setup of the plan whose program runs; `undefined` = the first (one program per setup). */
  readonly setupId: string | undefined
  /**
   * The setup to re-fixture for: set when a run ends with a next setup, cleared when a run
   * starts or the plan or setup is chosen by hand. The setup-change prompt shows it.
   */
  readonly setupChange: string | undefined
  readonly setupChangeOpen: boolean
  /** Time scale chosen before connecting; while connected the status has the live one. */
  readonly timeScale: TimeScale
  /** Jog step in the project unit. */
  readonly jogStep: string
  /** The run job this window follows (started here, or seen in the status). */
  readonly jobId: string | undefined
  readonly progress: RunProgress | undefined
  readonly ended: RunEnd | undefined
  /** The failure dialog shows `ended` while true. */
  readonly failureOpen: boolean
  /** Last refused action (inline banner in the panel that started it). */
  readonly actionError: AppErrorData | undefined
  /** Key of the tool change / pause wait the user put off with "Later". */
  readonly dismissedWait: string | undefined
  readonly preflightOpen: boolean
  /** Actions in flight, by name (their buttons show busy). */
  readonly pending: readonly string[]

  setPlan(planId: string | undefined): void
  setSetup(setupId: string | undefined): void
  setSetupChangeOpen(open: boolean): void
  setTimeScale(scale: TimeScale): void
  setJogStep(step: string): void
  setPreflightOpen(open: boolean): void
  dismissWait(key: string | undefined): void
  closeFailure(): void
  clearActionError(): void

  connect(): Promise<void>
  disconnect(): Promise<void>
  home(): Promise<void>
  unlock(): Promise<void>
  jog(axis: Axis, mm: number, feed: number): Promise<void>
  jogCancel(): Promise<void>
  setWorkZero(axes: readonly Axis[]): Promise<void>
  reset(): Promise<void>
  /** `setupId`: the setup to run (default: the chosen one; the server needs it for several). */
  startRun(setupId?: string): Promise<void>
  hold(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
  continueWait(): Promise<void>
}

export type RunStore = StoreApi<RunState> & {
  /** Follows main (status push, progress poll); returns the stop function. */
  start(): () => void
}

/** Key of the wait the job is at, if any (`toolChange:2`, `pause:1`). */
export function waitKey(status: RunStatus): string | undefined {
  const job = activeJob(status)
  if (job?.phase === 'toolChange' && job.toolChange) return `${job.jobId}:tc:${job.toolChange.n}`
  if (job?.phase === 'programPause') return `${job.jobId}:pause:${job.pause ?? 0}`
  return undefined
}

interface JobInfo {
  readonly state: 'running' | 'paused' | 'finished'
  readonly progress?: RunProgress
  readonly outcome?:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: AppErrorData }
}

export function createRunStore(bridge: PreloadApi): RunStore {
  let poll: ReturnType<typeof setTimeout> | undefined
  let polling: string | undefined
  let live = false

  const store = createStore<RunState>()((set, get) => {
    /** One command; a refusal goes to the action banner (`op.aborted` is never a failure). */
    const call = async (name: string, args: object = {}): Promise<CallReply> => {
      set((s) => ({ pending: [...s.pending, name], actionError: undefined }))
      const r = await bridge.call(name, args)
      set((s) => {
        const i = s.pending.indexOf(name)
        const pending = i < 0 ? s.pending : [...s.pending.slice(0, i), ...s.pending.slice(i + 1)]
        return !r.ok && r.error.code !== 'op.aborted'
          ? { pending, actionError: r.error }
          : { pending }
      })
      return r
    }
    /** A job command: waits for its outcome; a failure goes to the banner. */
    const job = async (name: string, args: object = {}): Promise<void> => {
      const r = await call(name, args)
      if (!r.ok) return
      const { jobId } = r.value as { jobId: string }
      const w = await bridge.call('job.wait', { jobId, timeoutSeconds: 600 })
      const info = w.ok ? (w.value as JobInfo) : undefined
      if (info?.outcome && !info.outcome.ok && info.outcome.error.code !== 'op.aborted')
        set({ actionError: info.outcome.error })
    }
    const jobControl = (name: string) => async () => {
      const id = activeJob(get().status)?.jobId ?? get().jobId
      if (id !== undefined) await call(name, { jobId: id })
    }

    return {
      status: closedStatus(),
      planId: undefined,
      setupId: undefined,
      setupChange: undefined,
      setupChangeOpen: false,
      timeScale: 1,
      jogStep: '10',
      jobId: undefined,
      progress: undefined,
      ended: undefined,
      failureOpen: false,
      actionError: undefined,
      dismissedWait: undefined,
      preflightOpen: false,
      pending: [],

      setPlan: (planId) =>
        set((s) =>
          s.planId === planId
            ? {}
            : { planId, setupId: undefined, setupChange: undefined, setupChangeOpen: false },
        ),
      setSetup: (setupId) =>
        set((s) =>
          s.setupId === setupId ? {} : { setupId, setupChange: undefined, setupChangeOpen: false },
        ),
      setSetupChangeOpen: (setupChangeOpen) => set({ setupChangeOpen }),
      setTimeScale: (timeScale) => {
        set({ timeScale })
        if (get().status.connection.state === 'open')
          void call('run.timeScale.set', { scale: timeScale })
      },
      setJogStep: (jogStep) => set({ jogStep }),
      setPreflightOpen: (preflightOpen) => set({ preflightOpen }),
      dismissWait: (dismissedWait) => set({ dismissedWait }),
      closeFailure: () => set({ failureOpen: false }),
      clearActionError: () => set({ actionError: undefined }),

      async connect() {
        const { planId, timeScale } = get()
        if (planId === undefined) return
        await call('run.connection.open', { target: 'virtual', planId, timeScale })
      },
      disconnect: async () => void (await call('run.connection.close')),
      home: () => job('run.machine.home'),
      unlock: async () => void (await call('run.machine.unlock')),
      async jog(axis, mm, feed) {
        const by: [number, number, number] = [0, 0, 0]
        by['xyz'.indexOf(axis)] = mm
        await call('run.machine.jog', { by, feed })
      },
      jogCancel: async () => void (await call('run.machine.jogCancel')),
      setWorkZero: async (axes) => void (await call('run.workZero.set', { axes: [...axes] })),
      reset: async () => void (await call('run.machine.reset')),
      async startRun(chosen) {
        const planId = get().planId
        const setupId = chosen ?? get().setupId
        set({ preflightOpen: false, setupChangeOpen: false })
        if (planId === undefined) return
        const r = await call('run.job.start', {
          planId,
          ...(setupId === undefined ? {} : { setupId }),
        })
        if (!r.ok) return
        const { jobId } = r.value as { jobId: string }
        set({
          jobId,
          progress: undefined,
          ended: undefined,
          failureOpen: false,
          setupChange: undefined,
        })
        follow(jobId)
      },
      hold: jobControl('job.pause'),
      resume: jobControl('job.resume'),
      /**
       * Stop is never confirmed (ui.md decision 11). With a run job: `job.abort` (controlled stop:
       * hold, then reset). Without one: a jog is cancelled, a homing cycle (which GRBL stops only
       * by a reset) is reset; otherwise nothing moves and nothing is sent.
       */
      async stop() {
        const s = get().status
        const id = activeJob(s)?.jobId ?? (polling === get().jobId ? get().jobId : undefined)
        if (id !== undefined) {
          await call('job.abort', { jobId: id })
          return
        }
        if (s.state.startsWith('Jog')) await call('run.machine.jogCancel')
        else if (s.state.startsWith('Home')) await call('run.machine.reset')
      },
      async continueWait() {
        const job = activeJob(get().status)
        if (job === undefined) return
        set({ dismissedWait: undefined })
        if (job.phase === 'toolChange' && job.toolChange)
          await call('run.job.continue', { jobId: job.jobId, toolChange: job.toolChange.n })
        else if (job.phase === 'programPause')
          await call('run.job.continue', { jobId: job.jobId, pause: job.pause ?? 0 })
      },
    }
  })

  /** Polls the run job's progress until it finished, then records how it ended. */
  const follow = (jobId: string): void => {
    if (polling === jobId) return
    polling = jobId
    clearTimeout(poll)
    const read = (): void => {
      if (!live || polling !== jobId) return
      void bridge.call('job.get', { jobId }).then((r) => {
        if (!live || polling !== jobId) return
        if (!r.ok) {
          polling = undefined // a job of another project's dispatcher: status only
          return
        }
        const info = r.value as JobInfo
        if (info.progress) store.setState({ progress: info.progress })
        if (info.state !== 'finished' || info.outcome === undefined) {
          poll = setTimeout(read, RUN_PROGRESS_POLL_MS)
          return
        }
        polling = undefined
        const o = info.outcome
        const ended: RunEnd = o.ok
          ? { jobId, kind: 'done', summary: o.value as RunSummaryView }
          : o.error.code === 'op.aborted'
            ? { jobId, kind: 'stopped' }
            : { jobId, kind: 'failed', error: o.error }
        store.setState({ ended, failureOpen: ended.kind === 'failed', dismissedWait: undefined })
        // one program per setup: the next setup is chosen and its setup change prompted (E2)
        const next = ended.kind === 'done' ? ended.summary.next : undefined
        if (next !== undefined)
          store.setState({
            setupId: next.setupId,
            setupChange: next.setupId,
            setupChangeOpen: true,
          })
      })
    }
    read()
  }

  const onStatus = (status: RunStatus): void => {
    store.setState({ status })
    // a closed connection ends the setup sequence (the stock is no longer on a known machine)
    if (status.connection.state === 'closed' && store.getState().setupChange !== undefined)
      store.setState({ setupChange: undefined, setupChangeOpen: false })
    const job = status.job
    if (job !== undefined && store.getState().jobId !== job.jobId) {
      // a run started elsewhere (another window, an agent): follow it too
      store.setState({
        jobId: job.jobId,
        progress: undefined,
        ended: undefined,
        setupChange: undefined,
        setupChangeOpen: false,
      })
      follow(job.jobId)
    }
  }

  return Object.assign(store, {
    start(): () => void {
      live = true
      let pushed = false
      const off = bridge.run.onStatus((s) => {
        pushed = true
        onStatus(s)
      })
      // the mirror as it is now (a push that arrived meanwhile is newer)
      void bridge.call('run.status.get', {}).then((r) => {
        if (live && !pushed && r.ok) onStatus(r.value as RunStatus)
      })
      const id = store.getState().jobId
      if (id !== undefined && store.getState().ended === undefined) {
        polling = undefined
        follow(id)
      }
      return () => {
        live = false
        polling = undefined
        clearTimeout(poll)
        off()
      }
    },
  })
}

const stores = new WeakMap<PreloadApi, { store: RunStore; users: number; stop?: () => void }>()

/** The window's run store (one per bridge); follows main while any component uses it. */
export function useRunStore(): RunStore {
  const { bridge } = useShell()
  let entry = stores.get(bridge)
  if (entry === undefined) {
    entry = { store: createRunStore(bridge), users: 0 }
    stores.set(bridge, entry)
  }
  const e = entry
  useEffect(() => {
    e.users += 1
    if (e.users === 1) e.stop = e.store.start()
    return () => {
      e.users -= 1
      if (e.users === 0) {
        e.stop?.()
        delete e.stop
      }
    }
  }, [e])
  return e.store
}

export function useRun<T>(selector: (s: RunState) => T): T {
  return useStore(useRunStore(), selector)
}
