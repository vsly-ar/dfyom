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
import { DEFAULT_BAUD, type SerialPortInfo } from '../../../../core/run/serial'
import type { SettingsCheck } from '../../../../core/run/settings-check'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import type { CallReply, PreloadApi } from '../../../../shared/preload-api'
import { useShell } from '../../shell/ShellContext'
import { activeJob, type JogMode } from './machine-state'

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
  /** The plan and setup the run machined, and the setup after it (task E2). */
  readonly planId?: string
  readonly setupId?: string
  readonly next?: { readonly setupId: string; readonly name: string }
}

/** How the window's last run job ended. */
export type RunEnd =
  | { readonly jobId: string; readonly kind: 'done'; readonly summary: RunSummaryView }
  | { readonly jobId: string; readonly kind: 'stopped' }
  | { readonly jobId: string; readonly kind: 'failed'; readonly error: AppErrorData }

export type Axis = 'x' | 'y' | 'z'

/** What "Connect" opens: the GRBL emulator or a real controller (docs/modes/run-machine.md#ui). */
export type ConnectTo = 'virtual' | 'serial'

/** `planId` of "No plan (manual control)": connect with a library machine (DF31). */
export const NO_PLAN = '__noPlan__'

export interface RunState {
  readonly status: RunStatus
  /** Plan chosen in the navigator (per window); `NO_PLAN` = manual control without a plan. */
  readonly planId: string | undefined
  /** Library machine to emulate without a plan (DF31, docs/modes/run.md#connect-without-a-plan-df31). */
  readonly machineId: string | undefined
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
  /** The connect choice (per window). */
  readonly connectTo: ConnectTo
  /** Serial port path chosen in the picker; `undefined` = none yet. */
  readonly portPath: string | undefined
  readonly baud: number
  /** Last `run.ports.scan`; `undefined` = not scanned yet. */
  readonly ports: readonly SerialPortInfo[] | undefined
  /** The serial connection's settings check (`run.connection.open`), until it closes. */
  readonly settingsCheck: SettingsCheck | undefined
  /** Jog step in the project unit. */
  readonly jogStep: string
  /** Step or continuous jogging (M3, per window). */
  readonly jogMode: JogMode
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
  /**
   * The pre-flight is in resume mode (M5) at this plan operation while defined ('' = the first);
   * docs/modes/run-machine.md#section-resume-m5.
   */
  readonly resumeFrom: string | undefined
  /** The run job this window started (M7: a followed run it did not start was started elsewhere). */
  readonly startedHere: string | undefined
  /** Actions in flight, by name (their buttons show busy). */
  readonly pending: readonly string[]

  setPlan(planId: string | undefined): void
  setMachine(machineId: string | undefined): void
  setSetup(setupId: string | undefined): void
  setSetupChangeOpen(open: boolean): void
  setTimeScale(scale: TimeScale): void
  setConnectTo(to: ConnectTo): void
  setPort(path: string | undefined): void
  setBaud(baud: number): void
  /** `run.ports.scan`; keeps the chosen port if still there, else picks the first USB one. */
  scanPorts(): Promise<void>
  setJogStep(step: string): void
  setJogMode(mode: JogMode): void
  setPreflightOpen(open: boolean): void
  /** Opens the pre-flight in resume mode at the operation the last run stopped in (M5). */
  openResume(): void
  setResumeFrom(planOperationId: string): void
  dismissWait(key: string | undefined): void
  closeFailure(): void
  clearActionError(): void

  connect(): Promise<void>
  disconnect(): Promise<void>
  home(): Promise<void>
  unlock(): Promise<void>
  jog(axis: Axis, mm: number, feed: number): Promise<void>
  jogCancel(): Promise<void>
  /**
   * Hold to jog (docs/modes/run-machine.md#machine-readiness-m3): a continuous jog to the travel
   * edge; `jogHoldEnd` cancels it, and again once the start is accepted if it was still on its way.
   */
  jogHoldStart(axis: Axis, sign: 1 | -1, feed: number): Promise<void>
  jogHoldEnd(): void
  setWorkZero(axes: readonly Axis[]): Promise<void>
  /** Z touch plate (`run.machine.probeZ`, M4): a job; a miss shows in the alarm panel. */
  probeZ(plateThickness: number): Promise<void>
  /** `run.override.set` (M6). */
  override(change: OverrideChange): Promise<void>
  reset(): Promise<void>
  /**
   * `setupId`: the setup to run (default: the chosen one; the server needs it for several);
   * `from`: resume at that plan operation (M5).
   */
  startRun(setupId?: string, from?: string): Promise<void>
  hold(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
  continueWait(): Promise<void>
}

/** One override change (docs/modes/run-machine.md#overrides-m6). */
export interface OverrideChange {
  readonly feed?: 'reset' | '+10' | '-10'
  readonly spindle?: 'reset' | '+10' | '-10'
  readonly rapid?: 100 | 50 | 25
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
  /** The continuous jog of this window: still being accepted, and whether released meanwhile. */
  let held: { released: boolean } | undefined

  const store = createStore<RunState>()((set, get) => {
    /** One command; a refusal goes to the action banner (`op.aborted` is never a failure). */
    const call = async (
      name: string,
      args: object = {},
      opts: { keepError?: boolean } = {},
    ): Promise<CallReply> => {
      set((s) =>
        opts.keepError === true
          ? { pending: [...s.pending, name] }
          : { pending: [...s.pending, name], actionError: undefined },
      )
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
      machineId: undefined,
      setupId: undefined,
      setupChange: undefined,
      setupChangeOpen: false,
      timeScale: 1,
      connectTo: 'virtual',
      portPath: undefined,
      baud: DEFAULT_BAUD,
      ports: undefined,
      settingsCheck: undefined,
      jogStep: '10',
      jogMode: 'step',
      jobId: undefined,
      progress: undefined,
      ended: undefined,
      failureOpen: false,
      actionError: undefined,
      dismissedWait: undefined,
      preflightOpen: false,
      resumeFrom: undefined,
      startedHere: undefined,
      pending: [],

      setPlan: (planId) =>
        set((s) =>
          s.planId === planId
            ? {}
            : { planId, setupId: undefined, setupChange: undefined, setupChangeOpen: false },
        ),
      setMachine: (machineId) => set({ machineId }),
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
      setConnectTo: (connectTo) => {
        set({ connectTo })
        if (connectTo === 'serial' && get().ports === undefined) void get().scanPorts()
      },
      setPort: (portPath) => set({ portPath }),
      setBaud: (baud) => set({ baud }),
      async scanPorts() {
        const r = await call('run.ports.scan')
        if (!r.ok) return
        const ports = (r.value as { ports: SerialPortInfo[] }).ports
        set((s) => ({
          ports,
          portPath: ports.some((p) => p.path === s.portPath)
            ? s.portPath
            : (ports.find((p) => p.usb) ?? ports[0])?.path,
        }))
      },
      setJogStep: (jogStep) => set({ jogStep }),
      setJogMode: (jogMode) => set({ jogMode }),
      setPreflightOpen: (preflightOpen) =>
        set(preflightOpen ? { preflightOpen, resumeFrom: undefined } : { preflightOpen }),
      openResume: () =>
        set({
          preflightOpen: true,
          resumeFrom: get().status.lastRun?.planOperationId ?? '',
        }),
      setResumeFrom: (resumeFrom) => set({ resumeFrom }),
      dismissWait: (dismissedWait) => set({ dismissedWait }),
      closeFailure: () => set({ failureOpen: false }),
      clearActionError: () => set({ actionError: undefined }),

      async connect() {
        const { planId, machineId, timeScale, connectTo, portPath, baud } = get()
        const what =
          planId !== undefined && planId !== NO_PLAN
            ? { planId }
            : machineId !== undefined
              ? { machineId }
              : undefined
        if (what === undefined) return
        if (connectTo === 'virtual') {
          await call('run.connection.open', { target: 'virtual', ...what, timeScale })
          return
        }
        if (portPath === undefined) return
        set({ settingsCheck: undefined })
        const r = await call('run.connection.open', {
          target: 'serial',
          path: portPath,
          baud,
          ...what,
        })
        if (r.ok)
          set({ settingsCheck: (r.value as { settingsCheck?: SettingsCheck }).settingsCheck })
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
      async jogHoldStart(axis, sign, feed) {
        if (held !== undefined) return
        const h = { released: false }
        held = h
        const by: [number, number, number] = [0, 0, 0]
        by['xyz'.indexOf(axis)] = sign
        const r = await call('run.machine.jog', { by, feed, continuous: true })
        if (held === h) {
          if (!r.ok) held = undefined
          return
        }
        // released before GRBL accepted the jog: the first 0x85 may have overtaken the $J line
        if (h.released && r.ok) await call('run.machine.jogCancel', {}, { keepError: true })
      },
      jogHoldEnd() {
        const h = held
        if (h === undefined) return
        h.released = true
        held = undefined
        // keep a refusal of the start (e.g. at the travel edge) visible
        void call('run.machine.jogCancel', {}, { keepError: true })
      },
      setWorkZero: async (axes) => void (await call('run.workZero.set', { axes: [...axes] })),
      probeZ: (plateThickness) => job('run.machine.probeZ', { plateThickness }),
      override: async (change) => void (await call('run.override.set', change)),
      reset: async () => void (await call('run.machine.reset')),
      async startRun(chosen, from) {
        const planId = get().planId
        const setupId = chosen ?? get().setupId
        set({ preflightOpen: false, setupChangeOpen: false, resumeFrom: undefined })
        if (planId === undefined || planId === NO_PLAN) return
        const r = await call('run.job.start', {
          planId,
          ...(setupId === undefined ? {} : { setupId }),
          ...(from === undefined || from === '' ? {} : { from }),
        })
        if (!r.ok) return
        const { jobId } = r.value as { jobId: string }
        set({
          jobId,
          startedHere: jobId,
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
       * hold, then reset). Without one: a jog is cancelled; a homing cycle (which GRBL stops only
       * by a reset), a Run, Hold or Door state is reset; otherwise nothing is sent (Stop is then
       * disabled, `stopGate`, DF35).
       */
      async stop() {
        const s = get().status
        const id = activeJob(s)?.jobId ?? (polling === get().jobId ? get().jobId : undefined)
        if (id !== undefined) {
          await call('job.abort', { jobId: id })
          return
        }
        if (s.state.startsWith('Jog')) await call('run.machine.jogCancel')
        else if (/^(Home|Run|Hold|Door)/.test(s.state)) await call('run.machine.reset')
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
        // the run's plan (M7: it may have been started elsewhere, for another plan than chosen here)
        const runPlan = ended.kind === 'done' ? ended.summary.planId : undefined
        if (next !== undefined)
          store.setState({
            ...(runPlan === undefined ? {} : { planId: runPlan }),
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
    if (status.connection.state === 'closed' && store.getState().settingsCheck !== undefined)
      store.setState({ settingsCheck: undefined })
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
