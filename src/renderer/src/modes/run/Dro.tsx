// DRO: work and machine coordinates per axis in the project's units, mono tabular digits
// (--text-dro), plus feed and spindle; "—" until the machine is homed (DF46, the position is
// unknown before). DF88: a "0" button by each axis letter sets that axis' work zero ("Set X
// zero"; the former navigator's "Zero X/Y/Z"), and the live G54 shows under the table. DF128:
// each coordinate is a button that opens the Go to dialog on its frame and axis.
// Doc: docs/conventions/ui.md#run-mode-safety-ui (DRO), #jog-position-and-probing-df88,
// docs/modes/run-goto.md#what-the-user-does;
// look: ui-design-system.html (.dro)
import { useId } from 'react'
import type { UnitSystem } from '../../../../core/project/document'
import type { RunStatus } from '../../../../core/run/service'
import { runMessages } from '../../messages/run'
import { formatFeed, formatLength, isConnected, positionKnown } from './machine-state'
import type { Axis, GoToRequest } from './run-store'
import styles from './Run.module.css'

const m = runMessages.dro
const AXES = ['X', 'Y', 'Z'] as const

export function Dro({
  status,
  units,
  zero,
  goTo,
}: {
  status: RunStatus
  units: UnitSystem
  /** The per-axis zero buttons: the work-zero gate and the action (`run.workZero.set`). */
  zero?: { gate: string | null; onZero: (axis: Axis) => void }
  /** DF128: the coordinates as Go to buttons: why they cannot open it now, and the action. */
  goTo?: { gate: string | null; onGoTo: (request: GoToRequest) => void }
}): React.JSX.Element {
  const unit = m.units[units]
  const known = positionKnown(status)
  const hintId = useId()
  const whyId = useId()
  const show = (mm: number) => (known ? formatLength(mm, units) : m.unknown)
  const connected = isConnected(status)
  const atHome = connected && status.homed && status.workZero.every((v) => v === 0)
  const zeroDisabled = zero !== undefined && zero.gate !== null
  const goWhyId = useId()
  const goDisabled = goTo !== undefined && goTo.gate !== null
  /** A coordinate: plain text, or the Go to button of its frame and axis (DF128). */
  const value = (mm: number, axis: (typeof AXES)[number], frame: GoToRequest['frame']) =>
    goTo === undefined ? (
      show(mm)
    ) : (
      <button
        type="button"
        className={styles['droGo']}
        aria-label={m.goTo(axis, show(mm), frame)}
        disabled={goDisabled}
        {...(goDisabled ? { 'aria-describedby': goWhyId } : {})}
        onClick={() => goTo.onGoTo({ frame, axis: axis.toLowerCase() as Axis })}
      >
        {show(mm)}
      </button>
    )
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
                {value(status.wpos[i]!, axis, 'work')}
                <small aria-hidden="true">{unit}</small>
              </td>
              <td className={styles['droMachine']} aria-label={`${m.machineLabel} ${axis}`}>
                {value(status.mpos[i]!, axis, 'machine')}
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
      {goDisabled ? (
        <span id={goWhyId} className={styles['srOnly']}>
          {goTo.gate}
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
