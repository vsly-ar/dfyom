// DF133 RW5 (Q192): the live clearance at the tool, once per status report (the status rate, 5 Hz):
// the nearest item and its distance for the Position panel's chip, each item's tone for the scene.
// Present while the guard can vouch for the items (homed, G54 set, a setup with items and a tool);
// `on` is false while the user switched the guard off (the scene then drops the red and amber).
// Doc: docs/modes/run-workholding.md#live-clearance, #implementation-rw5
import { useMemo } from 'react'
import { useRun } from './run-store'
import { guardActive, liveClearance, type LiveClearance } from './run-guard'

export interface LiveClearanceState {
  readonly clearance: LiveClearance
  /** The guard is on (not switched off by the user). */
  readonly on: boolean
}

export function useLiveClearance(): LiveClearanceState | undefined {
  const status = useRun((s) => s.status)
  const setup = useRun((s) => s.guardSetup)
  const off = useRun((s) => s.guardOff)
  return useMemo(() => {
    if (!guardActive(status, setup, false)) return undefined
    const clearance = liveClearance(status, setup)
    return clearance === undefined ? undefined : { clearance, on: !off }
  }, [status, setup, off])
}
