// The navigator's alarm panel (M3): while the machine is in Alarm, the alarm's name, what happened
// in plain words, the next steps and GRBL's own text. At the end of the navigator, so it never moves
// the controls (DF34); announced by the run dialogs' assertive announcer, so not a live region here.
// GRBL's start-up lock shows as "Needs homing" in neutral colours, not as an error (DF46).
// Also the warning after a real connection was lost without a reset (M2), and auto-reconnect's
// state after a connection lost during a run (DF129 RC4: polite, neutral, "Stop trying").
// Doc: docs/modes/run-machine.md#machine-readiness-m3, #lost-connection-m2,
// docs/modes/run.md#run-mode-presentation-df46, docs/modes/run-recovery.md#implementation-rc4
import type { RunStatus } from '../../../../core/run/service'
import { runMessages } from '../../messages/run'
import { Button, Icon } from '../../ui'
import { isConnected, isCriticalAlarm, needsHoming } from './machine-state'
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
  // the start-up lock is the next step, not an error (DF46): the badge's words, neutral colours
  const lock = needsHoming(status)
  const title = lock
    ? runMessages.state.needsHoming
    : code === undefined
      ? m.lockedTitle
      : runMessages.state.alarm(code)
  return (
    <section
      className={styles['alarmPanel']}
      data-kind={lock ? 'lock' : 'alarm'}
      aria-label={lock ? runMessages.state.needsHoming : m.region}
    >
      <Icon name={lock ? 'info' : 'error'} />
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
  // DF129 RC4: also while auto-reconnect connects (lost is kept), so it is not announced again
  if (status.connection.state === 'open' || status.connection.lost?.target !== 'serial') return null
  return (
    <div className={styles['alarmPanel']} role="alert">
      <Icon name="error" />
      <div>
        <p className={styles['why']}>{runMessages.navigator.lost}</p>
      </div>
    </div>
  )
}

const r = runMessages.navigator.reconnect

/**
 * DF129 RC4: auto-reconnect after a connection lost during a run: "Reconnecting… attempt n" with
 * "Stop trying", "Reconnected — machine needs homing" until homed, "Gave up after 2 min". A polite
 * live region: only the loss itself is assertive (docs/modes/run-recovery.md#auto-reconnect).
 */
export function ReconnectStatus({
  status,
  onStop,
}: {
  status: RunStatus
  onStop: () => void
}): React.JSX.Element | null {
  const rc = status.connection.reconnect
  const trying = rc !== undefined && (rc.phase === 'waiting' || rc.phase === 'connecting')
  const shown =
    rc !== undefined &&
    (trying || rc.phase === 'gaveUp' || (rc.phase === 'reconnected' && !status.homed))
  return (
    <div role="status" aria-label={r.region}>
      {shown ? (
        <div className={styles['alarmPanel']} data-kind="lock">
          <Icon name="info" />
          <div>
            <h3 className={styles['alarmTitle']}>
              {trying
                ? r.trying(Math.max(1, rc.attempt))
                : rc.phase === 'gaveUp'
                  ? r.gaveUp
                  : r.reconnected}
            </h3>
            <p className={styles['why']}>
              {trying ? r.tryingHint : rc.phase === 'gaveUp' ? r.gaveUpHint : r.reconnectedHint}
            </p>
            {trying ? <Button onClick={onStop}>{r.stop}</Button> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
