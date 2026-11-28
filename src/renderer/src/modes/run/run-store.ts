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
import { matchPort } from '../../../../core/run/host/reconnect'
import type { LaunchInfo } from '../../../../core/run/interruption'
import type { ResumeFinding, ResumePoint } from '../../../../core/run/recovery'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import { DEFAULT_BAUD, type SerialPortInfo } from '../../../../core/run/serial'
import type { SettingsCheck } from '../../../../core/run/settings-check'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import type { CallReply, PreloadApi, RunRecoveryAction } from '../../../../shared/preload-api'
import { useSettings, useShell } from '../../shell/ShellContext'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import { activeJob, isConnected, isHeld } from './machine-state'
import {
  guardedJog,
  plainJogArgs,
  plainJogEnd,
  type JogArgs,
  type JogRequest,
} from '../../../../core/run/guarded-jog'
import type { Vec3 } from '../../../../core/toolpath/model'
import { entryTo, pointerMoves } from '../../../../core/run/alignment'
import {
  arrived,
  contactItem,
  guardActive,
  JOG_END_STALE_MS,
  jogStart,
  moveGuard,
  PAST_ONCE_MS,
  wcoOf,
  type GuardNotice,
  type JogGuardSetup,
} from './run-guard'
import {
  fileNameOf,
  prepareGcodeFile,
  type PreparedGcodeFile,
} from '../../../../core/run/gcode-file'
import {
  NO_PROBE_CHECK,
  probeCheckForKind,
  probeCheckOnStatus,
  type ProbeCheck,
} from './probe-check'

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

/**
 * DF135 C2: what Run did with the design's already-cut marks after run `jobId`
 * (docs/modes/cut-state.md#marking): `marked` (automatic, with Undo; `undone` after it),
 * `offer` (the finished operations of a stopped or interrupted run), `waiting` (a resume is
 * pending: decided again once it is not), `changed` (the plan changed since the export), `none`
 * (nothing to say) and `closed` (the offer answered).
 */
export type CutMarksState =
  | {
      readonly jobId: string
      readonly kind: 'marked'
      readonly partId: string
      readonly units: readonly string[]
      /** DF135 C4: the listed (recut) units among `units` the run marked anew; Undo keeps them. */
      readonly recut?: readonly string[]
      readonly undone?: boolean
    }
  | {
      readonly jobId: string
      readonly kind: 'offer'
      readonly partId: string
      readonly planId: string
      readonly units: readonly string[]
    }
  | { readonly jobId: string; readonly kind: 'waiting' | 'changed' | 'none' | 'closed' }

/** How the window's last run job ended. */
export type RunEnd =
  | { readonly jobId: string; readonly kind: 'done'; readonly summary: RunSummaryView }
  | { readonly jobId: string; readonly kind: 'stopped' }
  | { readonly jobId: string; readonly kind: 'failed'; readonly error: AppErrorData }

export type Axis = 'x' | 'y' | 'z'

const axisIndex = (a: Axis): 0 | 1 | 2 => (a === 'x' ? 0 : a === 'y' ? 1 : 2)

/** DF133 RW3: a jog's command, its machine end when known and a guarded stop's notice. */
interface PlannedJog {
  readonly args: JogArgs
  readonly end: Vec3 | undefined
  readonly notice?: GuardNotice
}

/** DF128: what the Go to dialog opens on (docs/modes/run-goto.md#what-the-user-does). */
export interface GoToRequest {
  readonly frame: 'work' | 'machine'
  readonly axis: Axis
  /**
   * GT2: where focus returns on close when it is not the focused element at opening (the jog
   * section's menu button: the menu item is gone by then).
   */
  readonly opener?: HTMLElement | null | undefined
  /**
   * Hardening DF140: the DRO's "→0": the fields filled with the work zero of `axis`
   * (`goToZeroTarget`, work frame) and the move started at once when nothing stops it
   * (docs/modes/run-goto.md#go-to-work-zero-per-axis-df140).
   */
  readonly zero?: true
}

/**
 * DF128 GT2: the move the open Go to dialog shows, for the run scene's dashed path (machine
 * coordinates, mm): the start and each step's end, the last one the target.
 */
export interface GoToPreview {
  readonly from: readonly [number, number, number]
  readonly points: readonly (readonly [number, number, number])[]
  /**
   * DF133 RW4: the workholding guard's first contact: on step `step` (0-based) at `at`; the path
   * turns red from there on (docs/modes/run-workholding.md#go-to-and-the-touch-off-spot).
   */
  readonly hit?: { readonly step: number; readonly at: readonly [number, number, number] }
}

/** What "Connect" opens: the GRBL emulator or a real controller (docs/modes/run-machine.md#ui). */
export type ConnectTo = 'virtual' | 'serial'
/** A `softLimit` finding of `run.job.check` (a plan warning; `params` in mm). */
export interface SoftLimitFinding {
  readonly rule: string
  readonly params: Readonly<Record<string, number | string>>
}

/**
 * The pre-flight dialog's soft-limit check (`run.job.check`, DF46): `key` names what was checked
 * (plan, setup, work zero), so a changed work zero checks again.
 */
export type PreflightCheck =
  | { readonly state: 'idle' }
  | { readonly state: 'checking'; readonly key: string }
  | {
      readonly state: 'done'
      readonly key: string
      readonly findings: readonly SoftLimitFinding[]
      /** DF129 RC3: with a start line, `run.job.check`'s lead-in preview. */
      readonly resume?: ResumePreviewView | undefined
    }
  | { readonly state: 'failed'; readonly key: string; readonly error: AppErrorData }

/** `run.job.check { fromLine }`'s `resume` (docs/modes/run-recovery.md#start-from-a-line). */
export interface ResumePreviewView {
  /** The line the run starts at (a tool-change marker passed over). */
  readonly fromLine: number
  readonly programHash: string
  readonly leadIn: readonly string[]
  readonly findings: readonly ResumeFinding[]
  readonly before?: number | undefined
  readonly after?: number | undefined
}

/**
 * DF129 RC3: the pre-flight's "Start at" (docs/modes/run-recovery.md#implementation-rc3): the
 * beginning, a resume point, or a line chosen behind "Choose a line…" (`line` undefined until
 * typed); `snappedFrom`: the line "Start from here…" asked for, snapped back to this point.
 */
export type StartAt =
  | { readonly kind: 'beginning' }
  | { readonly kind: 'point'; readonly line: number; readonly snappedFrom?: number | undefined }
  | { readonly kind: 'line'; readonly line: number | undefined }

/** The line a `StartAt` asks for; undefined = the beginning (or no line typed yet). */
export function startLineOf(at: StartAt): number | undefined {
  return at.kind === 'beginning' ? undefined : at.line
}

/** DF129 RC3: a plan's program as `run.job.check { program: true }` returned it. */
export interface CheckedProgramView {
  /** `planId|setupId` it was exported for. */
  readonly key: string
  readonly lines: readonly string[]
  readonly sections: readonly { readonly fromLine: number; readonly label: string }[]
  readonly points: readonly ResumePoint[]
}

/**
 * DF129 RC5: what the user did in the recovery panel (per window): "The machine is stopped", the
 * checklist's ticks and "Checked", "The work zero is right", and the step they opened.
 */
export interface RecoveryUi {
  readonly jobId: string
  readonly safe: boolean
  readonly ticks: readonly string[]
  readonly checked: boolean
  readonly zeroOk: boolean
  /** The step the user opened (else the current one is open). */
  readonly open?: string | undefined
}

/** The gCode panel's window state (DF84): open, height (rem) and whether it follows the run. */
export interface GcodePanelState {
  readonly open: boolean
  readonly height: number
  readonly follow: boolean
}

/** Open height of the gCode panel in a new window (rem). */
export const GCODE_HEIGHT_REM = 12

/**
 * DF93: the external gCode file this window shows in Run mode
 * (docs/modes/run.md#run-an-external-g-code-file-df93): read and prepared here, run by
 * `run.job.start { file }`, which reads and checks it again.
 */
export type RunFileView =
  | { readonly state: 'loading'; readonly path: string; readonly name: string }
  | {
      readonly state: 'ready'
      readonly path: string
      readonly name: string
      readonly prepared: PreparedGcodeFile
    }
  | {
      readonly state: 'failed'
      readonly path: string
      readonly name: string
      readonly error: AppErrorData
    }

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
  /**
   * DF133 RW6: the work zero (G54) when the setup change began, until it changes: the new
   * setup's items are outlined and the guard off meanwhile (they would stand at the old setup's
   * zero; docs/modes/run-workholding.md#implementation-rw6).
   */
  readonly setupChangeZero: Vec3 | undefined
  /**
   * DF78 (Q107, assumed): bumped when the setup-change prompt hands over to the docked alignment
   * panel, which then takes the focus.
   */
  readonly alignFocus: number
  /** Time scale chosen before connecting; while connected the status has the live one. */
  readonly timeScale: TimeScale
  /**
   * The connect choice (per window, not remembered across launches): a serial port by default
   * (DF101: the real machine is what Run is for), the virtual machine one click away.
   */
  readonly connectTo: ConnectTo
  /** Serial port path chosen in the picker; `undefined` = none yet. */
  readonly portPath: string | undefined
  readonly baud: number
  /** Last `run.ports.scan`; `undefined` = not scanned yet. */
  readonly ports: readonly SerialPortInfo[] | undefined
  /** The serial connection's settings check (`run.connection.open`), until it closes. */
  readonly settingsCheck: SettingsCheck | undefined
  /**
   * Jog step (mm), per window; `undefined` = the unit's default (DF88,
   * docs/conventions/ui.md#jog-position-and-probing-df88).
   */
  readonly jogStep: number | undefined
  /** The step picker's custom value (mm), kept while a preset is chosen. */
  readonly jogCustom: number | undefined
  /** Jog feed (mm/min) of this window, used without a known library machine (DF88). */
  readonly jogFeed: number | undefined
  /** The run job this window follows (started here, or seen in the status). */
  readonly jobId: string | undefined
  readonly progress: RunProgress | undefined
  readonly ended: RunEnd | undefined
  /** The failure dialog shows `ended` while true. */
  readonly failureOpen: boolean
  /** DF135 C2: the already-cut marks of the last run (decided once per run). */
  readonly cutMarks: CutMarksState | undefined
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
  /**
   * DF129 RC3: the run this window started at a line, and its lead-in's line count: the tool
   * wait within it says it is the start's (docs/modes/run-recovery.md#implementation-rc3).
   */
  readonly startedLeadIn: { readonly jobId: string; readonly lines: number } | undefined
  readonly preflightCheck: PreflightCheck
  /** DF129 RC3: the pre-flight's "Start at" (reset when it opens or closes). */
  readonly startAt: StartAt
  /** DF129 RC3: the plan program the pre-flight read for "Start at" (cleared when it closes). */
  readonly startProgram: CheckedProgramView | undefined
  /** Actions in flight, by name (their buttons show busy). */
  readonly pending: readonly string[]
  /**
   * The Probe Z job this window started, while it runs: the toolbar's Resume resumes it once it
   * is held (DF82, docs/modes/run.md#1-emergency-stop-stop-and-reset).
   */
  readonly probeJobId: string | undefined
  /** DF84: the gCode panel under the 3D view, per window (docs/modes/run.md#gcode-panel-df84). */
  readonly gcode: GcodePanelState
  /** DF93: the external gCode file shown, while one is. */
  readonly file: RunFileView | undefined
  /** DF93: the recently run gCode files (main's list), newest first. */
  readonly recentFiles: readonly string[]
  /**
   * DF128: the Go to dialog, while open: the frame and axis of the clicked DRO value. The jog
   * hotkeys are off while it is set (docs/modes/run-goto.md#keyboard).
   */
  readonly goTo: GoToRequest | undefined
  /** DF128: "Lift to the top first", per window (off by default). */
  readonly goToLiftTop: boolean
  /** DF128 GT2: the open dialog's planned steps, drawn in the run scene; absent: none. */
  readonly goToPreview: GoToPreview | undefined
  /**
   * DF129 RC5: the program hash a start line opened from the recovery panel refers to (the
   * interrupted run's program); the pre-flight refuses a preview of another program.
   */
  readonly startHash: string | undefined
  /** DF129 RC5: the recovery panel's steps in this window, for the interruption of `jobId`. */
  readonly recoveryUi: RecoveryUi | undefined
  /**
   * DF133 RW3: what the jog guard checks against (`useJogGuardSync`); absent without a plan setup
   * with items and a tool (docs/modes/run-workholding.md#implementation-rw3).
   */
  readonly guardSetup: JogGuardSetup | undefined
  /** DF133 RW3 (Q186): the Jog menu's switch is off, until reconnect or a setup change. */
  readonly guardOff: boolean
  /** DF133 RW3: the jog notice of the guard, in the jog pads. */
  readonly guardNotice: GuardNotice | undefined
  /** DF133 RW3 (Q186): "Jog past once" until this time (epoch ms): the next jog goes unguarded. */
  readonly pastOnceUntil: number | undefined
  /** DF133 (Q189): the tool of the last tool-change wait seen in this connection. */
  readonly spindleTool: number | undefined
  /** DF133 (Q190): a tool-change wait began and the work zero Z was not set since. */
  readonly zUnset: boolean
  /** v0.5 RV5: the Set X/Y zero dialog is open (docs/modes/run-probing.md#set-xy-zero-rv5). */
  readonly xyZeroOpen: boolean
  /** v0.5 RV6: the Check alignment dialog is open (docs/modes/alignment.md#check-alignment-rv6). */
  readonly checkAlignOpen: boolean
  /**
   * v0.5 RV5: the last X/Y zero this window set, for "Undo zero change": G54 X/Y before and
   * after (MPos mm); dropped when the connection closes.
   */
  readonly zeroUndo: { readonly before: XY; readonly after: XY } | undefined
  /** v0.5 RV5: the plan setup the virtual machine's stock was laid for, in this connection. */
  readonly virtualStockKey: string | undefined
  /** DF143: the probe check of this connection (docs/modes/run-probing.md#probe-check-df143). */
  readonly probeCheck: ProbeCheck
  /** DF143: the probe kind in use; another kind starts the probe check again. */
  setProbeKind(kind: string): void

  /** DF93: reads and prepares a gCode file (main chose it and this window). */
  loadFile(path: string): Promise<void>
  /** DF93: "Run gCode file…": main's dialog (or `path`), then the window that shows it. */
  openFile(path?: string): Promise<void>
  closeFile(): void
  refreshRecentFiles(): Promise<void>
  setPlan(planId: string | undefined): void
  /** DF128: opens the Go to dialog on a frame, with that axis' field focused. */
  openGoTo(request: GoToRequest): void
  closeGoTo(): void
  setGoToLiftTop(on: boolean): void
  setGoToPreview(preview: GoToPreview | undefined): void
  setGcode(patch: Partial<GcodePanelState>): void
  setMachine(machineId: string | undefined): void
  setSetup(setupId: string | undefined): void
  setSetupChangeOpen(open: boolean): void
  /** Closes the setup-change prompt and focuses the alignment panel (Q107). */
  showAlignPanel(): void
  setTimeScale(scale: TimeScale): void
  setConnectTo(to: ConnectTo): void
  setPort(path: string | undefined): void
  setBaud(baud: number): void
  /** `run.ports.scan`; keeps the chosen port if still there, else picks the first USB one. */
  scanPorts(): Promise<void>
  setJogStep(stepMm: number): void
  /** Sets the custom step and chooses it. */
  setJogCustom(stepMm: number): void
  setJogFeed(feed: number): void
  /** DF133 RW3: the guard's setup (a new `key` turns the switch back on). */
  setGuardSetup(setup: JogGuardSetup | undefined): void
  /** DF133 RW3: the Jog menu's "Workholding guard" switch. */
  setGuardOff(off: boolean): void
  /** DF133 RW3: "Jog past once": the next jog or Go to within 30 s goes unguarded. */
  jogPastOnce(): void
  setPreflightOpen(open: boolean): void
  /** Opens the pre-flight in resume mode at the operation the last run stopped in (M5). */
  openResume(): void
  setResumeFrom(planOperationId: string): void
  /** DF129 RC3: the pre-flight's start line. */
  setStartAt(at: StartAt): void
  /**
   * DF129 RC3: "Start from here…" in the gCode panel: the pre-flight at that line, snapped to the
   * resume point at or before it (`points` of the program shown).
   */
  startFromHere(line: number, points: readonly ResumePoint[]): void
  dismissWait(key: string | undefined): void
  closeFailure(): void
  /** DF135 C2: records what Run did with the last run's already-cut marks. */
  setCutMarks(state: CutMarksState): void
  clearActionError(): void

  connect(): Promise<void>
  disconnect(): Promise<void>
  /**
   * DF129 RC4: "Stop trying" (`cancel`) auto-reconnect, or "Simulate a lost connection"
   * (`simulate`, the virtual machine during a run); a refusal shows as the action error.
   */
  reconnect(action: 'cancel' | 'simulate'): Promise<void>
  /** DF129 RC5: the recovery panel's main-side actions; a refusal shows as the action error. */
  recovery(action: RunRecoveryAction): Promise<void>
  /**
   * DF129 RC6: "Connect to …" after a crash: the journal's connection (the virtual machine, or the
   * serial port by path or USB serial number), the run's plan when this window has it. False when
   * the port is not listed (nothing opened). Doc: docs/modes/run-recovery.md#implementation-rc6
   */
  connectRecovery(machine: LaunchInfo['machine'], planId: string | undefined): Promise<boolean>
  /** DF129 RC5: the panel's own state for the interruption of `jobId`. */
  setRecoveryUi(jobId: string, patch: Partial<Omit<RecoveryUi, 'jobId'>>): void
  /**
   * DF129 RC5: the pre-flight opened from the recovery panel at `at` (the interrupted run's plan
   * and setup chosen), bound to `programHash` (the interrupted run's program).
   */
  openRecoveryStart(at: StartAt, programHash: string | undefined): void
  home(): Promise<void>
  unlock(): Promise<void>
  /** DF143: "Unlock and back off" `distance` mm (`run.machine.backOff`, a job). */
  backOff(distance: number): Promise<void>
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
  /**
   * v0.5 RV1: the spindle on at `rpm` (Idle; in a jog a speed change) or off (`run.machine.spindle`,
   * docs/modes/run-machine.md#spindle-while-jogging-rv1); a refusal goes to the banner.
   */
  spindle(on: boolean, rpm?: number): Promise<void>
  /**
   * DF69: jog to the touch-off spot (`touchOffMoves`), one jog after the other; DF128: the Go to
   * steps. False when a jog was refused (the banner has why). DF133 RW4: through the workholding
   * guard while it is on: a step that would come within the margin of an item sends nothing (the
   * jog notice says which) unless `anyway` (the dialog's "Go anyway" ticked) or "Jog past once" is
   * armed (used up here).
   */
  moveTo(
    moves: readonly { readonly to: readonly [number, number, number]; readonly feed: number }[],
    opts?: { readonly anyway?: boolean },
  ): Promise<boolean>
  /** DF78 alignment step: `run.align.goto` (the pointer to `zero`, a point, `next`, `previous`). */
  alignGoto(setupId: string, to: string): Promise<void>
  /** `run.align.tick`: tick or untick an entry, or confirm (`skipUnticked` after the prompt). */
  alignTick(change: {
    entry?: string
    ticked?: boolean
    confirm?: true
    skipUnticked?: true
  }): Promise<void>
  /** DF129 RC5: G54 back to `g54` (machine, mm), the interrupted run's work zero. */
  restoreWorkZero(g54: readonly [number, number, number]): Promise<void>
  /** "Zero on this point": G54 X/Y so the current position gets these work coordinates. */
  setWorkZeroAt(x: number, y: number): Promise<void>
  setXyZeroOpen(open: boolean): void
  setCheckAlignOpen(open: boolean): void
  /**
   * v0.5 RV4: a probing routine (`run.machine.probe`, a job): its result, or undefined when it
   * failed or was stopped (the banner or the alarm panel says why).
   */
  probeRoutine(args: object): Promise<ProbeRoutineResult | undefined>
  /**
   * v0.5 RV5: G54 X and/or Y to these machine positions (`G10 L20` through `run.workZero.set`);
   * true once set, remembered for `undoXyZero`.
   */
  setXyZero(g54: { readonly x?: number; readonly y?: number }): Promise<boolean>
  /** v0.5 RV5: G54 X/Y back to before the last `setXyZero`. */
  undoXyZero(): Promise<void>
  /** v0.5 RV5 (virtual machine): lays the stock once per connection and setup (`key`). */
  layVirtualStock(key: string, stock: VirtualStock): Promise<void>
  /** v0.5 RV5 (virtual machine): the stock closes the probe input while touched (touch step). */
  setVirtualTouch(on: boolean, toolDiameter?: number): Promise<void>
  /** `run.override.set` (M6). */
  override(change: OverrideChange): Promise<void>
  reset(): Promise<void>
  /**
   * `setupId`: the setup to run (default: the chosen one; the server needs it for several);
   * `from`: resume at that plan operation (M5).
   */
  startRun(
    setupId?: string,
    from?: string,
    at?: { readonly fromLine: number; readonly programHash: string; readonly leadIn: number },
  ): Promise<void>
  /**
   * Runs `run.job.check` for the pre-flight dialog unless `key` is checked or being checked;
   * `fromLine`: the start line's preview (DF129 RC3). A plan's first check of an open pre-flight
   * also reads the program (`program: true`) for "Start at".
   */
  checkRun(setupId: string | undefined, key: string, fromLine?: number): Promise<void>
  hold(): Promise<void>
  /** `job.resume` of the held run job, else of this window's held Probe Z job (DF82). */
  resume(): Promise<void>
  stop(): Promise<void>
  continueWait(): Promise<void>
}

/** One override change (docs/modes/run-machine.md#overrides-m6): a step or a target % (DF85). */
export interface OverrideChange {
  readonly feed?: 'reset' | '+10' | '-10' | number
  readonly spindle?: 'reset' | '+10' | '-10' | number
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

type XY = readonly [number, number]

/** v0.5 RV4: `run.machine.probe`'s result (docs/modes/run-probing.md#xy-probing-rv4). */
export interface ProbeRoutineResult {
  readonly cycle: 'edge' | 'corner' | 'centre'
  readonly top?: ProbedValue
  readonly x?: ProbedValue
  readonly y?: ProbedValue
  readonly centre?: {
    readonly x: ProbedValue
    readonly y: ProbedValue
    readonly diameter: ProbedValue
  }
  readonly start: readonly [number, number, number]
}
export interface ProbedValue {
  readonly value: number
  readonly uncertainty: number
}
/** v0.5 RV5: the virtual machine's stock (MPos box). */
export interface VirtualStock {
  readonly min: readonly [number, number, number]
  readonly max: readonly [number, number, number]
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
  /**
   * DF133 RW3: where the jogs this window queued end (MPos), the start of the next guarded jog;
   * forgotten at the end, a cancel, a reset or a state other than Idle and Jog.
   */
  let queued: { end: Vec3; sentAt: number } | undefined
  /** When this window last cancelled a jog or reset (the machine may still decelerate). */
  let cancelAt: number | undefined
  /** A guarded stop's notice, shown when the machine is there (a hold released before: never). */
  let stopNotice: { end: Vec3; notice: GuardNotice } | undefined
  let pastOnceTimer: ReturnType<typeof setTimeout> | undefined
  /** Q190: the work zero Z at the start of the tool-change wait `key`. */
  let zWait: { key: string; z: number } | undefined
  /** DF133 RW3: the guard's part of a status push (set up with the store's actions). */
  let onJogStatus: (status: RunStatus) => void = () => {}
  /** The plan or library machine the open serial connection was checked against (DF87). */
  let checkedAgainst: { planId: string } | { machineId: string } | undefined

  const store = createStore<RunState>()((set, get) => {
    /** One command; a refusal goes to the action banner (`op.aborted` is never a failure). */
    const call = async (
      name: string,
      args: object = {},
      opts: { keepError?: boolean } = {},
    ): Promise<CallReply> => {
      if (name === 'run.machine.jogCancel' || name === 'run.machine.reset') {
        // at rest already (Idle where the queued jogs end): no deceleration to wait for
        const st = get().status
        const atRest = st.state === 'Idle' && (queued === undefined || arrived(st, queued.end))
        if (!atRest) cancelAt = Date.now()
        queued = undefined
        stopNotice = undefined
      }
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
    const job = async (
      name: string,
      args: object = {},
      track?: (jobId: string | undefined) => Partial<RunState>,
    ): Promise<void> => {
      const r = await call(name, args)
      if (!r.ok) return
      const { jobId } = r.value as { jobId: string }
      if (track !== undefined) set(track(jobId))
      try {
        await waitJob(jobId)
      } finally {
        if (track !== undefined) set(track(undefined))
      }
    }
    const waitJob = async (jobId: string): Promise<JobInfo | undefined> => {
      // job.wait caps one wait at MAX_WAIT_SECONDS (300); a run job can last hours, so wait again
      // while it is still running (the previous 600 s argument failed validation silently)
      let w = await bridge.call('job.wait', { jobId, timeoutSeconds: 300 })
      while (w.ok && (w.value as { timedOut?: boolean }).timedOut === true)
        w = await bridge.call('job.wait', { jobId, timeoutSeconds: 300 })
      const info = w.ok ? (w.value as JobInfo) : undefined
      if (info?.outcome && !info.outcome.ok && info.outcome.error.code !== 'op.aborted')
        set({ actionError: info.outcome.error })
      return info
    }
    const jobControl = (name: string) => async () => {
      const id = activeJob(get().status)?.jobId ?? get().jobId
      if (id !== undefined) await call(name, { jobId: id })
    }

    /** DF133 RW3: ends "Jog past once" (used, expired, the switch or a new connection). */
    const disarmPastOnce = (): void => {
      clearTimeout(pastOnceTimer)
      pastOnceTimer = undefined
      if (get().pastOnceUntil === undefined) return
      set((s) => ({
        pastOnceUntil: undefined,
        ...(s.guardNotice?.kind === 'pastOnce' ? { guardNotice: undefined } : {}),
      }))
    }
    /**
     * DF133 RW3: the command of a jog: today's when the guard is not on (Q184) or "Jog past once"
     * is armed (used up here), else through `guardedJog`; undefined when nothing is sent (the
     * notice says why). docs/modes/run-workholding.md#jogs
     */
    const planJog = (request: JogRequest): PlannedJog | undefined => {
      const s = get()
      const status = s.status
      const travel = status.envelope?.travel
      const now = Date.now()
      const guarded = guardActive(status, s.guardSetup, s.guardOff)
      if (!guarded || (s.pastOnceUntil !== undefined && now <= s.pastOnceUntil)) {
        if (guarded) disarmPastOnce()
        const base = queued?.end ?? status.mpos
        return { args: plainJogArgs(request), end: plainJogEnd(request, base, travel) }
      }
      const g = s.guardSetup!
      const from = jogStart(status, queued?.end, cancelAt, now)
      if (from === undefined) {
        set({ guardNotice: { kind: 'moving' } })
        return undefined
      }
      const r = guardedJog({
        request,
        from,
        wco: wcoOf(status),
        offset: [g.zero[0], g.zero[1], status.zeroLevel ?? 0],
        ...(travel === undefined ? {} : { travel }),
        setup: g.setup,
      })
      if (r.kind === 'blocked') {
        set({
          guardNotice: { kind: 'blocked', item: contactItem(g, r.contact), contact: r.contact },
        })
        return undefined
      }
      if (get().guardNotice !== undefined) set({ guardNotice: undefined })
      const item = r.contact === undefined ? undefined : contactItem(g, r.contact)
      return {
        args: r.args,
        end: r.end,
        ...(r.contact === undefined || item === undefined
          ? {}
          : { notice: { kind: 'stopped', item, contact: r.contact } }),
      }
    }
    /** Sends a planned jog; remembers its end (the next guarded jog's start) and stop notice. */
    const sendJog = async (plan: PlannedJog): Promise<CallReply> => {
      const r = await call('run.machine.jog', plan.args)
      if (r.ok) {
        queued = plan.end === undefined ? undefined : { end: plan.end, sentAt: Date.now() }
        stopNotice =
          plan.notice === undefined || plan.end === undefined
            ? undefined
            : { end: plan.end, notice: plan.notice }
        if (stopNotice !== undefined && arrived(get().status, stopNotice.end)) showStopNotice()
      }
      return r
    }
    const showStopNotice = (): void => {
      const n = stopNotice
      stopNotice = undefined
      if (n !== undefined) set({ guardNotice: n.notice })
    }
    onJogStatus = (status: RunStatus): void => {
      const now = Date.now()
      if (!isConnected(status)) {
        queued = undefined
        stopNotice = undefined
        zWait = undefined
        disarmPastOnce()
        const st = get()
        if (
          st.guardOff ||
          st.guardNotice !== undefined ||
          st.spindleTool !== undefined ||
          st.zUnset
        )
          set({ guardOff: false, guardNotice: undefined, spindleTool: undefined, zUnset: false })
        return
      }
      // the queued jogs' end: reached, or stale (an Idle report long after the send), or ended
      if (queued !== undefined) {
        const idle = status.state === 'Idle'
        if (
          (idle && (arrived(status, queued.end) || now - queued.sentAt >= JOG_END_STALE_MS)) ||
          (!idle && !status.state.startsWith('Jog'))
        )
          queued = undefined
      }
      if (stopNotice !== undefined) {
        if (arrived(status, stopNotice.end)) showStopNotice()
        else if (status.state !== 'Idle' && !status.state.startsWith('Jog')) stopNotice = undefined
      }
      // Q189 / Q190: the tool of the wait; its Z not set until the work zero Z changes
      const job = activeJob(status)
      const tc = job?.phase === 'toolChange' ? job.toolChange : undefined
      const patch: { spindleTool?: number; zUnset?: boolean } = {}
      if (job !== undefined && tc !== undefined) {
        if (get().spindleTool !== tc.n) patch.spindleTool = tc.n
        const key = `${job.jobId}:${tc.n}`
        if (zWait?.key !== key) {
          zWait = { key, z: status.workZero[2] }
          patch.zUnset = true
        }
      }
      if (zWait !== undefined && Math.abs(status.workZero[2] - zWait.z) > 1e-6) {
        // set: the note goes; NaN keeps this wait from raising it again
        zWait = { key: zWait.key, z: Number.NaN }
        patch.zUnset = false
      }
      if (Object.keys(patch).length > 0) set(patch)
    }

    return {
      status: closedStatus(),
      planId: undefined,
      machineId: undefined,
      setupId: undefined,
      setupChange: undefined,
      setupChangeOpen: false,
      setupChangeZero: undefined,
      alignFocus: 0,
      timeScale: 1,
      connectTo: 'serial',
      portPath: undefined,
      baud: DEFAULT_BAUD,
      ports: undefined,
      settingsCheck: undefined,
      jogStep: undefined,
      jogCustom: undefined,
      jogFeed: undefined,
      jobId: undefined,
      progress: undefined,
      ended: undefined,
      failureOpen: false,
      cutMarks: undefined,
      actionError: undefined,
      dismissedWait: undefined,
      preflightOpen: false,
      resumeFrom: undefined,
      startedHere: undefined,
      startedLeadIn: undefined,
      preflightCheck: { state: 'idle' },
      startAt: { kind: 'beginning' },
      startHash: undefined,
      recoveryUi: undefined,
      guardSetup: undefined,
      guardOff: false,
      guardNotice: undefined,
      pastOnceUntil: undefined,
      spindleTool: undefined,
      zUnset: false,
      xyZeroOpen: false,
      checkAlignOpen: false,
      zeroUndo: undefined,
      virtualStockKey: undefined,
      probeCheck: NO_PROBE_CHECK,
      setProbeKind: (kind) => {
        const next = probeCheckForKind(get().probeCheck, kind)
        if (next !== get().probeCheck) set({ probeCheck: next })
      },
      startProgram: undefined,
      pending: [],
      probeJobId: undefined,
      gcode: { open: false, height: GCODE_HEIGHT_REM, follow: true },
      file: undefined,
      recentFiles: [],
      goTo: undefined,
      goToLiftTop: false,
      openGoTo: (goTo) => set({ goTo }),
      goToPreview: undefined,
      closeGoTo: () => set({ goTo: undefined, goToPreview: undefined }),
      setGoToPreview: (goToPreview) => set({ goToPreview }),
      setGoToLiftTop: (goToLiftTop) => set({ goToLiftTop }),
      async loadFile(path) {
        const name = fileNameOf(path)
        set({ file: { state: 'loading', path, name }, preflightCheck: { state: 'idle' } })
        const r = await bridge.run.readFile(path)
        if (get().file?.path !== path) return // another file meanwhile
        set({
          file: r.ok
            ? { state: 'ready', path, name, prepared: prepareGcodeFile(r.text) }
            : { state: 'failed', path, name, error: r.error },
          // the panel shows the file's lines before a run (DF84)
          ...(r.ok ? { gcode: { ...get().gcode, open: true } } : {}),
        })
        void get().refreshRecentFiles()
      },
      async openFile(path) {
        await bridge.run.openFile(path)
      },
      closeFile: () => set({ file: undefined, preflightCheck: { state: 'idle' } }),
      async refreshRecentFiles() {
        const recentFiles = await bridge.run.recentFiles()
        set({ recentFiles })
      },

      setGcode: (patch) => set((s) => ({ gcode: { ...s.gcode, ...patch } })),
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
      showAlignPanel: () => set((s) => ({ setupChangeOpen: false, alignFocus: s.alignFocus + 1 })),
      setTimeScale: (timeScale) => {
        set({ timeScale })
        if (get().status.connection.state === 'open')
          void call('run.timeScale.set', { scale: timeScale })
      },
      setConnectTo: (connectTo) => {
        set({ connectTo })
        // choosing the serial port lists the ports again (one plugged in meanwhile shows)
        if (connectTo === 'serial') void get().scanPorts()
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
      setJogCustom: (jogCustom) => set({ jogCustom, jogStep: jogCustom }),
      setJogFeed: (jogFeed) => set({ jogFeed }),
      setGuardSetup: (guardSetup) =>
        set((s) =>
          guardSetup?.key === s.guardSetup?.key
            ? { guardSetup }
            : { guardSetup, guardOff: false, guardNotice: undefined },
        ),
      setGuardOff: (guardOff) => {
        disarmPastOnce()
        set({ guardOff, guardNotice: undefined })
      },
      jogPastOnce() {
        disarmPastOnce()
        set({ pastOnceUntil: Date.now() + PAST_ONCE_MS, guardNotice: { kind: 'pastOnce' } })
        pastOnceTimer = setTimeout(disarmPastOnce, PAST_ONCE_MS)
      },
      setPreflightOpen: (preflightOpen) =>
        set(
          preflightOpen
            ? {
                preflightOpen,
                resumeFrom: undefined,
                startAt: { kind: 'beginning' },
                startHash: undefined,
              }
            : {
                preflightOpen,
                preflightCheck: { state: 'idle' },
                startAt: { kind: 'beginning' },
                startHash: undefined,
                startProgram: undefined,
              },
        ),
      // the gCode panel opens on the start line (behind the dialog, as a loaded file's does)
      setStartAt: (startAt) =>
        set((s) =>
          startLineOf(startAt) === undefined
            ? { startAt }
            : { startAt, gcode: { ...s.gcode, open: true } },
        ),
      startFromHere(line, points) {
        const point = points.filter((p) => p.line <= line).at(-1)
        set({
          preflightOpen: true,
          resumeFrom: undefined,
          startAt:
            point === undefined
              ? { kind: 'line', line }
              : point.line === line
                ? { kind: 'point', line }
                : { kind: 'point', line: point.line, snappedFrom: line },
        })
      },
      openResume: () =>
        set({
          preflightOpen: true,
          startAt: { kind: 'beginning' },
          resumeFrom: get().status.lastRun?.planOperationId ?? '',
        }),
      setResumeFrom: (resumeFrom) => set({ resumeFrom }),
      dismissWait: (dismissedWait) => set({ dismissedWait }),
      closeFailure: () => set({ failureOpen: false }),
      setCutMarks: (cutMarks) => set({ cutMarks }),
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
        checkedAgainst = what
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
      async reconnect(action) {
        const error = await bridge.run.reconnect(action)
        set({ actionError: error ?? undefined })
      },
      async recovery(action) {
        const error = await bridge.run.recovery(action)
        set({ actionError: error ?? undefined })
      },
      async connectRecovery(machine, planId) {
        const plan = planId === undefined ? {} : { planId }
        const port = machine.port
        if (machine.target === 'virtual' || port === undefined) {
          set({ connectTo: 'virtual', ...plan })
          await get().connect()
          return true
        }
        await get().scanPorts()
        const path = matchPort(get().ports ?? [], { path: port.path, ...machine.usb })
        if (path === undefined) return false
        set({ connectTo: 'serial', portPath: path, baud: port.baud, ...plan })
        await get().connect()
        return true
      },
      setRecoveryUi: (jobId, patch) =>
        set((s) => {
          const base: RecoveryUi =
            s.recoveryUi?.jobId === jobId
              ? s.recoveryUi
              : { jobId, safe: false, ticks: [], checked: false, zeroOk: false }
          return { recoveryUi: { ...base, ...patch } }
        }),
      openRecoveryStart(at, programHash) {
        const last = get().status.lastRun
        set((s) => ({
          ...(last?.planId === undefined ? {} : { planId: last.planId }),
          ...(last?.setupId === undefined ? {} : { setupId: last.setupId }),
          preflightOpen: true,
          resumeFrom: undefined,
          setupChange: undefined,
          startAt: at,
          startHash: programHash,
          ...(startLineOf(at) === undefined ? {} : { gcode: { ...s.gcode, open: true } }),
        }))
      },
      home: () => job('run.machine.home'),
      unlock: async () => void (await call('run.machine.unlock')),
      backOff: (distance) => job('run.machine.backOff', { distance }),
      async jog(axis, mm, feed) {
        const request: JogRequest = { kind: 'step', axis: axisIndex(axis), mm, feed }
        const plan = planJog(request)
        if (plan !== undefined) await sendJog(plan)
      },
      jogCancel: async () => void (await call('run.machine.jogCancel')),
      async jogHoldStart(axis, sign, feed) {
        if (held !== undefined) return
        // DF133 RW3: through the guard (a contact: a jog to the stop point; release still cancels)
        const plan = planJog({ kind: 'hold', axis: axisIndex(axis), sign, feed })
        if (plan === undefined) return
        const h = { released: false }
        held = h
        const r = await sendJog(plan)
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
        // released before the stop point: no "Stopped" notice
        stopNotice = undefined
        // keep a refusal of the start (e.g. at the travel edge) visible
        void call('run.machine.jogCancel', {}, { keepError: true })
      },
      setWorkZero: async (axes) => void (await call('run.workZero.set', { axes: [...axes] })),
      spindle: async (on, rpm) =>
        void (await call('run.machine.spindle', on ? { on, rpm } : { on: false })),
      probeZ: (plateThickness) =>
        job('run.machine.probeZ', { plateThickness }, (probeJobId) => ({ probeJobId })),
      async moveTo(moves, opts = {}) {
        // DF133 RW4 (Q186, Q187): through the guard unless "Go anyway" or "Jog past once" (used up)
        const s = get()
        const now = Date.now()
        const past = s.pastOnceUntil !== undefined && now <= s.pastOnceUntil
        if (s.pastOnceUntil !== undefined) disarmPastOnce()
        if (guardActive(s.status, s.guardSetup, s.guardOff) && !past && opts.anyway !== true) {
          const g = s.guardSetup!
          const from = jogStart(s.status, queued?.end, cancelAt, now)
          if (from === undefined) {
            set({ guardNotice: { kind: 'moving' } })
            return false
          }
          const hit = moveGuard(
            s.status,
            g,
            from,
            moves.map((m) => m.to),
          )
          if (hit !== undefined) {
            set({ guardNotice: { kind: 'blocked', item: hit.item, contact: hit.hit.contact } })
            return false
          }
          if (s.guardNotice !== undefined) set({ guardNotice: undefined })
        }
        for (const { to, feed } of moves) {
          const r = await call('run.machine.jog', { to: [...to], feed })
          if (!r.ok) return false
          queued = { end: [to[0], to[1], to[2]], sentAt: Date.now() }
        }
        return true
      },
      async alignGoto(setupId, to) {
        const planId = get().planId
        if (planId === undefined || planId === NO_PLAN) return
        // DF133 RW6: the pointer's jogs (main plans them, `pointerMoves`) through the guard as
        // `moveTo`'s are, for the guard's own setup; "Jog past once" covers and is used up by them
        const s = get()
        const now = Date.now()
        const past = s.pastOnceUntil !== undefined && now <= s.pastOnceUntil
        if (s.pastOnceUntil !== undefined) disarmPastOnce()
        const g = s.guardSetup
        if (
          guardActive(s.status, g, s.guardOff) &&
          !past &&
          g.key === `${planId}:${setupId}` &&
          g.clearance !== undefined
        ) {
          const step = s.status.alignment
          const target =
            step !== undefined && step.planId === planId && step.setupId === setupId
              ? entryTo(step, to)?.target
              : to === 'zero'
                ? ([0, 0] as const)
                : undefined
          if (target !== undefined) {
            const from = jogStart(s.status, queued?.end, cancelAt, now)
            if (from === undefined) {
              set({ guardNotice: { kind: 'moving' } })
              return
            }
            const moves = pointerMoves(
              { mpos: from, workZero: s.status.workZero, zeroLevel: s.status.zeroLevel },
              target,
              g.clearance,
            )
            const hit = moveGuard(
              s.status,
              g,
              from,
              moves.map((m) => m.to),
            )
            if (hit !== undefined) {
              set({ guardNotice: { kind: 'blocked', item: hit.item, contact: hit.hit.contact } })
              return
            }
            if (s.guardNotice !== undefined) set({ guardNotice: undefined })
          }
        }
        await call('run.align.goto', { planId, setupId, to })
      },
      alignTick: async (change) => void (await call('run.align.tick', change)),
      async restoreWorkZero(g54) {
        const p = get().status.mpos
        const values = [p[0] - g54[0], p[1] - g54[1], p[2] - g54[2]]
        await call('run.workZero.set', { axes: ['x', 'y', 'z'], values })
      },
      setXyZeroOpen: (xyZeroOpen) => set({ xyZeroOpen }),
      setCheckAlignOpen: (checkAlignOpen) => set({ checkAlignOpen }),
      async probeRoutine(args) {
        const r = await call('run.machine.probe', args)
        if (!r.ok) return undefined
        const { jobId } = r.value as { jobId: string }
        set({ probeJobId: jobId })
        try {
          const info = await waitJob(jobId)
          return info?.outcome?.ok === true ? (info.outcome.value as ProbeRoutineResult) : undefined
        } finally {
          set({ probeJobId: undefined })
        }
      },
      async setXyZero(g54) {
        // G10 L20 at the current position (Idle: it does not move), as restoreWorkZero does
        const s = get().status
        const before: XY = [s.workZero[0], s.workZero[1]]
        const after: XY = [g54.x ?? before[0], g54.y ?? before[1]]
        const axes = [...(g54.x === undefined ? [] : ['x']), ...(g54.y === undefined ? [] : ['y'])]
        if (axes.length === 0) return false
        const values = [s.mpos[0] - after[0], s.mpos[1] - after[1], s.wpos[2]]
        const r = await call('run.workZero.set', { axes, values })
        if (!r.ok) return false
        set({ zeroUndo: { before, after } })
        return true
      },
      async undoXyZero() {
        const u = get().zeroUndo
        if (u === undefined) return
        const s = get().status
        const values = [s.mpos[0] - u.before[0], s.mpos[1] - u.before[1], s.wpos[2]]
        const r = await call('run.workZero.set', { axes: ['x', 'y'], values })
        if (r.ok) set({ zeroUndo: undefined })
      },
      async layVirtualStock(key, stock) {
        if (get().virtualStockKey === key) return
        const r = await call('run.virtual.stock', { stock, touch: false })
        if (r.ok) set({ virtualStockKey: key })
      },
      setVirtualTouch: async (touch, toolDiameter) =>
        void (await call(
          'run.virtual.stock',
          { touch, ...(toolDiameter === undefined ? {} : { toolDiameter }) },
          { keepError: true },
        )),
      async setWorkZeroAt(x, y) {
        const z = get().status.wpos[2]
        await call('run.workZero.set', { axes: ['x', 'y'], values: [x, y, z] })
      },
      override: async (change) => void (await call('run.override.set', change)),
      reset: async () => void (await call('run.machine.reset')),
      async startRun(chosen, from, at) {
        const file = get().file
        const startAt =
          at === undefined ? {} : { fromLine: at.fromLine, programHash: at.programHash }
        const closed = {
          preflightOpen: false,
          setupChangeOpen: false,
          resumeFrom: undefined,
          startAt: { kind: 'beginning' } as const,
          startHash: undefined,
          startProgram: undefined,
        }
        if (file?.state === 'ready') {
          set(closed)
          const r = await call('run.job.start', { file: file.path, ...startAt })
          if (!r.ok) return
          const { jobId } = r.value as { jobId: string }
          set({
            jobId,
            startedHere: jobId,
            startedLeadIn: at === undefined ? undefined : { jobId, lines: at.leadIn },
            progress: undefined,
            ended: undefined,
            failureOpen: false,
          })
          follow(jobId)
          return
        }
        const planId = get().planId
        const setupId = chosen ?? get().setupId
        set(closed)
        if (planId === undefined || planId === NO_PLAN) return
        const r = await call('run.job.start', {
          planId,
          ...(setupId === undefined ? {} : { setupId }),
          ...(from === undefined || from === '' ? {} : { from }),
          ...startAt,
        })
        if (!r.ok) return
        const { jobId } = r.value as { jobId: string }
        set({
          jobId,
          startedHere: jobId,
          startedLeadIn: at === undefined ? undefined : { jobId, lines: at.leadIn },
          progress: undefined,
          ended: undefined,
          failureOpen: false,
          setupChange: undefined,
        })
        follow(jobId)
      },
      async checkRun(setupId, key, fromLine) {
        const planId = get().planId
        const now = get().preflightCheck
        const file = get().file
        const ofFile = file?.state === 'ready'
        if (!ofFile && (planId === undefined || planId === NO_PLAN)) return
        if (now.state !== 'idle' && now.key === key) return
        set({ preflightCheck: { state: 'checking', key } })
        // DF129 RC3: a plan's program for "Start at", once per open pre-flight and setup
        const programKey = `${planId ?? ''}|${setupId ?? ''}`
        const readProgram = !ofFile && get().startProgram?.key !== programKey
        const at = fromLine === undefined ? {} : { fromLine }
        // not through `call`: a failed check shows in the dialog, not in the action banner
        const r = await bridge.call(
          'run.job.check',
          ofFile
            ? { file: file.path, ...at }
            : {
                planId,
                ...(setupId === undefined ? {} : { setupId }),
                ...at,
                ...(readProgram ? { program: true } : {}),
              },
        )
        const cur = get().preflightCheck
        if (cur.state !== 'checking' || cur.key !== key) return // closed or superseded
        if (!r.ok) {
          set({ preflightCheck: { state: 'failed', key, error: r.error } })
          return
        }
        const value = r.value as {
          findings: SoftLimitFinding[]
          resume?: ResumePreviewView
          program?: Omit<CheckedProgramView, 'key'>
        }
        set({
          preflightCheck: { state: 'done', key, findings: value.findings, resume: value.resume },
          ...(value.program === undefined
            ? {}
            : { startProgram: { key: programKey, ...value.program } }),
        })
      },
      hold: jobControl('job.pause'),
      async resume() {
        const s = get().status
        const run = activeJob(s)
        const probe = get().probeJobId
        // a Probe Z held without a held run (DF82): its job, which the toolbar's Resume shows for
        const id =
          run?.phase !== 'held' && probe !== undefined && isHeld(s)
            ? probe
            : (run?.jobId ?? get().jobId)
        if (id !== undefined) await call('job.resume', { jobId: id })
      },
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
            setupChangeZero: [...store.getState().status.workZero] as Vec3,
          })
      })
    }
    read()
  }

  /**
   * DF87: the settings check again (`run.settings.check`) after a library change, so a machine
   * fixed in the Library clears the warning without reconnecting (docs/modes/run-machine.md#settings-check).
   */
  const recheckSettings = async (): Promise<void> => {
    const against = checkedAgainst
    if (against === undefined || store.getState().settingsCheck === undefined) return
    const r = await bridge.call('run.settings.check', against)
    if (!r.ok || checkedAgainst !== against) return
    const check = (r.value as { settingsCheck?: SettingsCheck }).settingsCheck
    if (check !== undefined) store.setState({ settingsCheck: check })
  }

  const onStatus = (status: RunStatus): void => {
    const probeCheck = probeCheckOnStatus(store.getState().probeCheck, status)
    store.setState({ status, probeCheck })
    onJogStatus(status)
    // a closed connection ends the setup sequence (the stock is no longer on a known machine)
    if (status.connection.state === 'closed' && store.getState().settingsCheck !== undefined)
      store.setState({ settingsCheck: undefined })
    if (status.connection.state === 'closed' && store.getState().setupChange !== undefined)
      store.setState({ setupChange: undefined, setupChangeOpen: false })
    // v0.5 RV5: the undo and the virtual stock belong to the connection
    if (
      status.connection.state === 'closed' &&
      (store.getState().zeroUndo !== undefined || store.getState().virtualStockKey !== undefined)
    )
      store.setState({ zeroUndo: undefined, virtualStockKey: undefined })
    // DF133 RW6: the new setup's zero is set (any G54 change), or the setup change is over
    const was = store.getState().setupChangeZero
    if (
      was !== undefined &&
      (store.getState().setupChange === undefined || status.workZero.some((v, i) => v !== was[i]))
    )
      store.setState({ setupChangeZero: undefined })
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
      const offLibrary = bridge.library.onChanged(() => void recheckSettings())
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
        offLibrary()
      }
    },
  })
}

const stores = new WeakMap<PreloadApi, { store: RunStore; users: number; stop?: () => void }>()

function storeEntry(bridge: PreloadApi): { store: RunStore; users: number; stop?: () => void } {
  let entry = stores.get(bridge)
  if (entry === undefined) {
    entry = { store: createRunStore(bridge), users: 0 }
    stores.set(bridge, entry)
  }
  return entry
}

/** The window's run store outside a component (DF93: main hands the window a gCode file). */
export function runStoreOf(bridge: PreloadApi): RunStore {
  return storeEntry(bridge).store
}

/** The window's run store (one per bridge); follows main while any component uses it. */
export function useRunStore(): RunStore {
  const { bridge } = useShell()
  const e = storeEntry(bridge)
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

/**
 * The unit system Run shows lengths in: the project's, or without a project (DF80) the one the
 * Library window uses without a project (`libraryUnits`, docs/modes/run.md#run-without-a-project-df80).
 */
export function useRunUnits(doc: ProjectDoc | undefined): UnitSystem {
  const fallback = useSettings((s) => s.settings.libraryUnits)
  return doc?.unitSystem ?? fallback
}
