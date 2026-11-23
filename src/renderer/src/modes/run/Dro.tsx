// DRO: work and machine coordinates per axis in the project's units, mono tabular digits
// (--text-dro), plus feed and spindle; "—" until the machine is homed (DF46, the position is
// unknown before). Doc: docs/conventions/ui.md#run-mode-safety-ui (DRO);
// look: ui-design-system.html (.dro)
import { useId } from 'react'
import type { UnitSystem } from '../../../../core/project/document'
import type { RunStatus } from '../../../../core/run/service'
import { runMessages } from '../../messages/run'
import { formatFeed, formatLength, positionKnown } from './machine-state'
import styles from './Run.module.css'

const m = runMessages.dro
const AXES = ['X', 'Y', 'Z'] as const

export function Dro({
  status,
  units,
}: {
  status: RunStatus
  units: UnitSystem
}): React.JSX.Element {
  const unit = m.units[units]
  const known = positionKnown(status)
  const hintId = useId()
  const show = (mm: number) => (known ? formatLength(mm, units) : m.unknown)
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
                {axis}
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
    </div>
  )
}
