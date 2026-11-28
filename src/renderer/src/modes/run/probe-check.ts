// Hardening DF143: the probe check. Each probing session (a connection and a probe kind) sees the
// probe input go touching → open once (the operator touches the plate to the bit) before any probe
// button enables. Pure state steps; the run store keeps the state per window.
// Doc: docs/modes/run-probing.md#probe-check-df143
import type { RunStatus } from '../../../../core/run/service'
import { isConnected } from './machine-state'

export interface ProbeCheck {
  /** The probe kind the check is for; undefined until a probing control names it. */
  readonly kind: string | undefined
  /** The input read touching since the session began. */
  readonly touched: boolean
  /** It then read open again: probing is enabled. */
  readonly ok: boolean
}

export const NO_PROBE_CHECK: ProbeCheck = { kind: undefined, touched: false, ok: false }

/** `Pn:P` in the status: the probe input reads touching. */
export const probeTouching = (s: RunStatus): boolean => s.pins?.includes('P') === true

/** The check after a status push: reset when not connected; touching, then open → ok. */
export function probeCheckOnStatus(prev: ProbeCheck, s: RunStatus): ProbeCheck {
  if (!isConnected(s))
    return prev.touched || prev.ok ? { ...NO_PROBE_CHECK, kind: prev.kind } : prev
  if (probeTouching(s)) return prev.touched ? prev : { ...prev, touched: true }
  return prev.touched && !prev.ok ? { ...prev, ok: true } : prev
}

/** The check for the probe kind in use: another kind starts it again (the first one adopts). */
export function probeCheckForKind(prev: ProbeCheck, kind: string): ProbeCheck {
  if (prev.kind === kind) return prev
  return prev.kind === undefined ? { ...prev, kind } : { kind, touched: false, ok: false }
}

/** Whether probing may start for `kind`. */
export const probeChecked = (c: ProbeCheck, kind: string): boolean => c.kind === kind && c.ok
