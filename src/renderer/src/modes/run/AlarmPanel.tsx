// The navigator's alarm panel (M3): while the machine is in Alarm, the alarm's name, what happened
// in plain words, the next steps and GRBL's own text. At the end of the navigator, so it never moves
// the controls (DF34); announced by the run dialogs' assertive announcer, so not a live region here.
// Also the warning after a real connection was lost without a reset (M2).
// Doc: docs/modes/run-machine.md#machine-readiness-m3, #lost-connection-m2
import type { RunStatus } from '../../../../core/run/service'
import { runMessages } from '../../messages/run'
import { Icon } from '../../ui'
import { isConnected, isCriticalAlarm } from './machine-state'
import styles from './Run.module.css'

const m = runMessages.alarm

/** True while the panel shows: connected and in Alarm (or a critical alarm awaiting its reset). */
export function inAlarm(s: RunStatus): boolean {
  return isConnected(s) && (s.state.startsWith('Alarm') || isCriticalAlarm(s))
}

export function AlarmPanel({ status }: { status: RunStatus }): React.JSX.Element | null {
  if (!inAlarm(status)) return null
  const code = status.alarm?.code
  const info = code === undefined ? m.codes[0]! : (m.codes[code] ?? m.other)
  const title = code === undefined ? m.lockedTitle : runMessages.state.alarm(code)
  return (
    <section className={styles['alarmPanel']} aria-label={m.region}>
      <Icon name="error" />
      <div>
        <h3 className={styles['alarmTitle']}>{title}</h3>
        {info.what === '' ? null : <p className={styles['why']}>{info.what}</p>}
        <p className={styles['alarmNext']}>{m.next}</p>
        <ol className={styles['alarmSteps']}>
          {info.next.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {status.alarm?.text ? (
          <p className={styles['hint']}>
            {m.grbl}: {status.alarm.text}
          </p>
        ) : null}
      </div>
    </section>
  )
}

/** After a real connection was lost: it may still be moving (run.md § Safety 6). */
export function LostConnectionWarning({ status }: { status: RunStatus }): React.JSX.Element | null {
  if (status.connection.state !== 'closed' || status.connection.lost?.target !== 'serial')
    return null
  return (
    <div className={styles['alarmPanel']} role="alert">
      <Icon name="error" />
      <div>
        <p className={styles['why']}>{runMessages.navigator.lost}</p>
      </div>
    </div>
  )
}
