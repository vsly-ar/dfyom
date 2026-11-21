// DRO: work and machine coordinates per axis in the project's units, mono tabular digits
// (--text-dro), plus feed and spindle. Doc: docs/conventions/ui.md#run-mode-safety-ui (DRO);
// look: ui-design-system.html (.dro)
import type { UnitSystem } from '../../../../core/project/document'
import type { RunStatus } from '../../../../core/run/service'
import { runMessages } from '../../messages/run'
import { formatFeed, formatLength } from './machine-state'
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
  return (
    <div className={styles['dro']}>
      <table className={styles['droTable']} aria-label={m.title}>
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
                {formatLength(status.wpos[i]!, units)}
                <small aria-hidden="true">{unit}</small>
              </td>
              <td className={styles['droMachine']} aria-label={`${m.machineLabel} ${axis}`}>
                {formatLength(status.mpos[i]!, units)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
