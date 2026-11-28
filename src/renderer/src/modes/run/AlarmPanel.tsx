// The navigator's alarm panel (M3): while the machine is in Alarm, the alarm's name, what happened
// in plain words, the next steps and GRBL's own text. At the end of the navigator, so it never moves
// the controls (DF34); announced by the run dialogs' assertive announcer, so not a live region here.
// GRBL's start-up lock shows as "Needs homing" in neutral colours, not as an error (DF46).
// Also the warning after a real connection was lost without a reset (M2), and auto-reconnect's
// state after a connection lost during a run (DF129 RC4: polite, neutral, "Stop trying").
// DF143 (advanced user): "Unlock and back off" after a hard limit hit while jogging, outside a run.
// Doc: docs/modes/run-machine.md#machine-readiness-m3, #lost-connection-m2, #unlock-and-back-off-df143,
// docs/modes/run.md#run-mode-presentation-df46, docs/modes/run-recovery.md#implementation-rc4
import type { RunStatus } from '../../../../core/run/service'
import { runMessages } from '../../messages/run'
import { Button, Icon } from '../../ui'
import { limitSwitches } from '../../../../core/run/grbl/status'
import { backOffMove, type JogDirection } from '../../../../core/run/back-off'
import type { UnitSystem } from '../../../../core/project/document'
import {
  activeJob,
  formatLength,
  isConnected,
  isCriticalAlarm,
  isResetAlarm,
  needsHoming,
} from './machine-state'
import styles from './Run.module.css'

const m = runMessages.alarm

/** DF134: the active `Pn:` inputs in words ("X limit switch, safety door"), or undefined. */
export function pinsText(pins: string | undefined): string | undefined {
  if (pins === undefined || pins === '') return undefined
  return [...pins].map((p) => m.pins.names[p] ?? p).join(', ')
}

/** True while the panel shows: connected and in Alarm (or a critical alarm awaiting its reset). */
export function inAlarm(s: RunStatus): boolean {
  return isConnected(s) && (s.state.startsWith('Alarm') || isCriticalAlarm(s))
}

/** DF143: "X+ 3.000" per axis of a back-off move. */
function moveText(v: readonly number[], units: UnitSystem): string {
  return v
    .map((d, i) =>
      d === 0 ? '' : `${'XYZ'[i]}${d > 0 ? '+' : '−'} ${formatLength(Math.abs(d), units)}`,
    )
    .filter((t) => t !== '')
    .join(', ')
}

/** DF143: what "Unlock and back off" does here, and the button; or why it cannot. */
function BackOffOffer({
  jog,
  pins,
  distance,
  units,
  busy,
  onBackOff,
}: {
  jog: JogDirection
  pins: string | undefined
  distance: number
  units: UnitSystem
  busy: boolean
  onBackOff: () => void
}): React.JSX.Element {
  const move = backOffMove(jog, pins, distance)
  if (move.isErr()) return <p className={styles['hint']}>{m.backOff.unknown}</p>
  return (
    <div className={styles['backOff']}>
      <p className={styles['why']}>
        {m.backOff.what(moveText(move.unwrap(), units), runMessages.dro.units[units])}
      </p>
      <p className={styles['hint']}>{m.backOff.after}</p>
      <div className={styles['buttons']}>
        <Button disabled={busy} onClick={onBackOff}>
          {m.backOff.button}
        </Button>
      </div>
    </div>
  )
}

export function AlarmPanel({
  status,
  backOff,
}: {
  status: RunStatus
  /** DF143: offered to an advanced user (the setting's distance, mm). */
  backOff?: {
    readonly distance: number
    readonly units: UnitSystem
    readonly busy: boolean
    readonly onBackOff: () => void
  }
}): React.JSX.Element | null {
  if (!inAlarm(status)) return null
  const code = status.alarm?.code
  const info = code === undefined ? m.codes[0]! : (m.codes[code] ?? m.other)
  // the start-up lock is the next step, not an error (DF46): the badge's words, neutral colours
  const lock = needsHoming(status)
  // DF134: reset from a hard or soft limit: home (recommended) or unlock, or release a switch first
  const afterReset = code !== undefined && isResetAlarm(status)
  const pressed = limitSwitches(status.pins)
  const steps = afterReset
    ? [pressed.length > 0 ? m.afterReset.limitPressed(pressed) : (m.afterReset.choice[code] ?? '')]
    : info.next
  const pins = pinsText(status.pins)
  const title = lock
    ? runMessages.state.needsHoming
    : code === undefined
      ? m.lockedTitle
      : afterReset
        ? m.afterReset.title(code)
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
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {pins === undefined ? null : (
          <p className={styles['hint']}>
            {m.pins.label}: {pins}
          </p>
        )}
        {status.alarm?.text ? (
          <p className={styles['hint']}>
            {m.grbl}: {status.alarm.text}
          </p>
        ) : null}
        {backOff !== undefined &&
        code === 1 &&
        status.alarm?.jog !== undefined &&
        !activeJob(status) ? (
          <BackOffOffer jog={status.alarm.jog} pins={status.pins} {...backOff} />
        ) : null}
      </div>
    </section>
  )
}

/**
 * DF134: the safety door outside a run job (a run's door hold has the toolbar's Resume): open →
 * close it; closed → GRBL waits for a cycle start, so Reset (immediate) continues (the position
 * kept: nothing moved). Neutral like the start-up lock; the badge says the state.
 */
export function DoorPanel({ status }: { status: RunStatus }): React.JSX.Element | null {
  if (!isConnected(status) || !status.state.startsWith('Door') || activeJob(status) !== undefined)
    return null
  const closed = status.state === 'Door:0'
  const pins = pinsText(status.pins)
  return (
    <section className={styles['alarmPanel']} data-kind="lock" aria-label={m.door.region}>
      <Icon name="info" />
      <div>
        <h3 className={styles['alarmTitle']}>{closed ? m.door.closed : m.door.open}</h3>
        <p className={styles['why']}>{closed ? m.door.closedWhat : m.door.openWhat}</p>
        <p className={styles['alarmNext']}>{m.next}</p>
        <ol className={styles['alarmSteps']}>
          <li>{closed ? m.door.closedNext : m.door.openNext}</li>
        </ol>
        {pins === undefined ? null : (
          <p className={styles['hint']}>
            {m.pins.label}: {pins}
          </p>
        )}
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
