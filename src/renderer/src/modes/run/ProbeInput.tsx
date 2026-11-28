// Hardening DF143: the probe input live (`Pn:P`) beside every probing action, and the probe check
// that enables probing once the input went touching → open in this connection (per probe kind).
// The virtual machine offers "Touch probe" (its probe input closed for a moment).
// Doc: docs/modes/run-probing.md#probe-check-df143
import { useEffect, useId, useRef } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import { runMessages } from '../../messages/run'
import { useShell } from '../../shell/ShellContext'
import { Button, Icon, StatusChip } from '../../ui'
import { useLibraryItems } from '../plan/usePlan'
import { isConnected } from './machine-state'
import { machineProbe } from './plan-info'
import { probeChecked, probeTouching } from './probe-check'
import { NO_PLAN, useRun, useRunStore } from './run-store'
import styles from './Run.module.css'

const m = runMessages.probe.check

/** How long "Touch probe" keeps the virtual probe input closed (ms). */
export const VIRTUAL_TOUCH_MS = 400

/** The probe kind of the chosen plan's machine (or the manual library machine). */
export function useProbeKind(doc: ProjectDoc | undefined): string {
  const planId = useRun((s) => s.planId)
  const machineId = useRun((s) => s.machineId)
  const machines = useLibraryItems('machine')
  const plan = planId === undefined || planId === NO_PLAN ? undefined : doc?.plans[planId]
  return machineProbe(plan, machines, machineId).kind
}

/**
 * Whether probing may start (the probe check passed for the probe kind in use); names the kind to
 * the store, which starts the check again when it changes.
 */
export function useProbeCheck(doc: ProjectDoc | undefined): boolean {
  const kind = useProbeKind(doc)
  const store = useRunStore()
  const check = useRun((s) => s.probeCheck)
  useEffect(() => store.getState().setProbeKind(kind), [store, kind])
  return probeChecked(check, kind)
}

/**
 * The live probe input, prominent until the check passed: a chip (Open / Touching), the prompt or
 * what it reads now, announced politely; "Touch probe" on the virtual machine. Nothing when not
 * connected.
 */
export function ProbeInput({
  doc,
  id,
}: {
  doc: ProjectDoc | undefined
  /** id of the prompt, for the probe buttons' `aria-describedby` while they wait. */
  id?: string
}): React.JSX.Element | null {
  const { bridge } = useShell()
  const status = useRun((s) => s.status)
  const ok = useProbeCheck(doc)
  const own = useId()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  if (!isConnected(status)) return null
  const touching = probeTouching(status)
  const line = ok ? (touching ? m.waits : m.ok) : touching ? m.release : m.prompt
  const virtual = status.connection.target === 'virtual'
  const touch = () => {
    clearTimeout(timer.current)
    void bridge.run.simulateInput('probe', true).then(() => {
      timer.current = setTimeout(
        () => void bridge.run.simulateInput('probe', false),
        VIRTUAL_TOUCH_MS,
      )
    })
  }
  return (
    <div
      className={styles['notice']}
      data-tone={ok ? undefined : 'warning'}
      role="group"
      aria-label={m.region}
    >
      <Icon name="probe" />
      <div>
        <p className={styles['probeInputRow']}>
          <span>{m.label}</span>
          <StatusChip tone={touching ? 'success' : 'neutral'}>
            {touching ? m.touching : m.open}
          </StatusChip>
        </p>
        <p id={id ?? own} className={styles['why']} role="status">
          {line}
        </p>
        {virtual ? (
          <div className={styles['buttons']}>
            <Button size="sm" title={m.touchHint} onClick={touch}>
              {m.touch}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
