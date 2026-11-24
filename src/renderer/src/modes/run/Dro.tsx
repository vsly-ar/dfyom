// DRO: work and machine coordinates per axis in the project's units, mono tabular digits
// (--text-dro), plus feed and spindle; "—" until the machine is homed (DF46, the position is
// unknown before). DF88: a "0" button by each axis letter sets that axis' work zero ("Set X
// zero"; the former navigator's "Zero X/Y/Z"), and the live G54 shows under the table.
// Doc: docs/conventions/ui.md#run-mode-safety-ui (DRO), #jog-position-and-probing-df88;
// look: ui-design-system.html (.dro)
import { useId } from 'react'
import type { UnitSystem } from '../../../../core/project/document'
import type { RunStatus } from '../../../../core/run/service'
import { runMessages } from '../../messages/run'
import { formatFeed, formatLength, isConnected, positionKnown } from './machine-state'
import type { Axis } from './run-store'
import styles from './Run.module.css'

const m = runMessages.dro
const AXES = ['X', 'Y', 'Z'] as const

export function Dro({
  status,
  units,
  zero,
}: {
  status: RunStatus
  units: UnitSystem
  /** The per-axis zero buttons: the work-zero gate and the action (`run.workZero.set`). */
  zero?: { gate: string | null; onZero: (axis: Axis) => void }
}): React.JSX.Element {
  const unit = m.units[units]
  const known = positionKnown(status)
  const hintId = useId()
  const whyId = useId()
  const show = (mm: number) => (known ? formatLength(mm, units) : m.unknown)
  const connected = isConnected(status)
  const atHome = connected && status.homed && status.workZero.every((v) => v === 0)
  const zeroDisabled = zero !== undefined && zero.gate !== null
  return (
    <div className={styles['dro']}>
      <table
        className={styles['droTable']}
        aria-label={m.title}
        data-known={known ? undefined : 'false'}
        {...(known ? {} : { 'aria-describedby': hintId })}
      >
        <thead>
          <tr>
            <th scope="col">
              <span className={styles['srOnly']}>Axis</span>
            </th>
            <th scope="col">{m.work}</th>
            <th scope="col">{m.machine}</th>
          </tr>
        </thead>
        <tbody>
          {AXES.map((axis, i) => (
            <tr key={axis}>
              <th scope="row" className={styles['droAxis']}>
                <span className={styles['droAxisCell']}>
                  {axis}
                  {zero === undefined ? null : (
                    <button
                      type="button"
                      className={styles['droZero']}
                      aria-label={m.setZero(axis)}
                      disabled={zeroDisabled}
                      {...(zeroDisabled ? { 'aria-describedby': whyId } : {})}
                      onClick={() => zero.onZero(axis.toLowerCase() as Axis)}
                    >
                      {m.zero}
                    </button>
                  )}
                </span>
              </th>
              <td className={styles['droWork']} aria-label={`${m.workLabel} ${axis}`}>
                {show(status.wpos[i]!)}
                <small aria-hidden="true">{unit}</small>
              </td>
              <td className={styles['droMachine']} aria-label={`${m.machineLabel} ${axis}`}>
                {show(status.mpos[i]!)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* always there, so homing never moves the controls below the DRO (Reset, Start run) */}
      <p id={hintId} className={styles['droUnknown']} aria-hidden={known ? true : undefined}>
        {known ? null : m.unknownHint}
      </p>
      {zeroDisabled ? (
        <span id={whyId} className={styles['srOnly']}>
          {zero.gate}
        </span>
      ) : null}
      <dl className={styles['droMeta']}>
        <div>
          <dt>{m.feed}</dt>
          <dd>
            {formatFeed(status.feed, units)} {m.feedUnits[units]}
          </dd>
        </div>
        <div>
          <dt>{m.spindle}</dt>
          <dd>
            {status.spindle.toFixed(0)} {m.rpm}
          </dd>
        </div>
      </dl>
      {zero === undefined ? null : (
        <p className={styles['droG54']}>
          {connected ? (
            <>
              G54{' '}
              <span className={styles['mono']}>
                {status.workZero.map((v) => formatLength(v, units)).join(' · ')}
              </span>{' '}
              {unit}
              {atHome ? ` · ${runMessages.navigator.workZeroAtHome}` : null}
            </>
          ) : (
            m.workZeroHint
          )}
        </p>
      )}
    </div>
  )
}
