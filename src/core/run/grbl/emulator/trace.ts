/**
 * What the virtual machine records for tests. Doc: docs/architecture/grbl.md#observability-for-tests
 * Times are the emulator's clock in ms; positions are MPos in mm.
 */
import type { Vec3 } from './planner'

export interface TraceLine {
  /** The line as received, without its end-of-line byte (comments included). */
  readonly text: string
  readonly receivedAt: number
  /** `ok` or `error:N`; unset while executing or when a reset or alarm aborted it. */
  response?: string
  ackedAt?: number
  /** First motion block or dwell of the line started. */
  startedAt?: number
  /** Last motion block or dwell of the line finished. */
  endedAt?: number
}

export interface PositionSample {
  readonly t: number
  readonly mpos: Vec3
  /** Reported state, e.g. `Run`, `Hold:0`. */
  readonly state: string
  /** Current speed, mm/min. */
  readonly rate: number
}

export interface Response {
  readonly t: number
  /** One output line without `\r\n` (banner, `ok`, `error:N`, `ALARM:N`, `[MSG:…]`, `<…>`). */
  readonly text: string
}

export interface Transition {
  readonly t: number
  readonly from: string
  readonly to: string
}

export type ViolationKind = 'rxOverflow' | 'nonAscii' | 'lineTooLong'

export interface Violation {
  readonly t: number
  readonly kind: ViolationKind
  /** The dropped byte (`rxOverflow`, `nonAscii`) or the line (`lineTooLong`). */
  readonly detail: string
}

export interface Trace {
  readonly lines: readonly TraceLine[]
  readonly samples: readonly PositionSample[]
  readonly responses: readonly Response[]
  readonly transitions: readonly Transition[]
  readonly violations: readonly Violation[]
}

export interface MutableTrace {
  lines: TraceLine[]
  samples: PositionSample[]
  responses: Response[]
  transitions: Transition[]
  violations: Violation[]
}

export const emptyTrace = (): MutableTrace => ({
  lines: [],
  samples: [],
  responses: [],
  transitions: [],
  violations: [],
})
