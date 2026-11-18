/**
 * Synchronous step control for pure code: abort and pause between steps, progress per step.
 * Doc: docs/architecture/workers.md#abort-and-pause
 *
 * Pure functions (`evaluatePart`, the toolpath generators) take an optional `steps: Steps =
 * noSteps` and call `steps.step()` between steps; nothing interrupts a step. Rule: no step takes
 * longer than 50 ms on the reference parts, so abort latency stays within one step.
 */
import { fail, Ok, type AppResult } from '../../shared/result'

/** Progress of one task: steps done, of `total` if known, and where ("pocket1: level 3/8"). */
export interface StepProgress {
  readonly done: number
  readonly total?: number
  readonly label?: string
}

export interface Steps {
  /** Reports progress; `Err(op.aborted)` once aborted (the caller returns it at once). */
  step(p?: StepProgress): AppResult<void>
}

const OK: AppResult<void> = Ok(undefined)

/** Never aborts, ignores progress: pure code called directly stays unchanged. */
export const noSteps: Steps = { step: () => OK }

export function aborted(where = 'steps.step'): AppResult<never> {
  return fail('op.aborted', 'aborted between steps', { where })
}

/** Steps backed by an `AbortSignal` (in-process runs; pause is a no-op inside a task). */
export function signalSteps(signal: AbortSignal, progress?: (p: StepProgress) => void): Steps {
  return {
    step(p) {
      if (signal.aborted) return aborted()
      if (p !== undefined) progress?.(p)
      return OK
    },
  }
}

/** Values of `Int32Array(control)[0]`, written by the host (`Atomics.store` + `Atomics.notify`). */
export const RUN_STATE = { run: 0, pause: 1, abort: 2 } as const
export type RunState = (typeof RUN_STATE)[keyof typeof RUN_STATE]

/** Bytes of the shared control buffer of one run. */
export const CONTROL_BYTES = 4

export interface SharedStepHooks {
  readonly progress?: (p: StepProgress) => void
  /** The task parked at a step (`paused`) or left it (`running`). */
  readonly parked?: (state: 'paused' | 'running', label?: string) => void
}

/**
 * Steps over a shared control word (worker side): `step()` reads it with `Atomics.load`, parks
 * on pause with `Atomics.wait` (allowed in workers) and returns `Err(op.aborted)` on abort, also
 * when woken from a pause.
 */
export function sharedSteps(control: Int32Array, hooks: SharedStepHooks = {}): Steps {
  let lastLabel: string | undefined
  return {
    step(p) {
      if (p !== undefined) {
        if (p.label !== undefined) lastLabel = p.label
        hooks.progress?.(p)
      }
      let state = Atomics.load(control, 0)
      if (state === RUN_STATE.pause) {
        hooks.parked?.('paused', lastLabel)
        while (state === RUN_STATE.pause) {
          Atomics.wait(control, 0, RUN_STATE.pause)
          state = Atomics.load(control, 0)
        }
        if (state !== RUN_STATE.abort) hooks.parked?.('running', lastLabel)
      }
      return state === RUN_STATE.abort ? aborted() : OK
    },
  }
}

/** Host side: writes the run state of a control word and wakes a parked worker. */
export function setRunState(control: Int32Array, state: RunState): void {
  Atomics.store(control, 0, state)
  Atomics.notify(control, 0)
}
