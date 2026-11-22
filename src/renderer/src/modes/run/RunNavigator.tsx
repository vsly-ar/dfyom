// Run mode navigator (ui.md#app-shell: "Run: connection, homing, jog, work zero"): the plan to run
// and, when it has several, the setup (one program per setup, task E2), the virtual machine connection and its time scale, homing and unlock (confirmed), the jog pad
// and the work zero. Disabled controls say why: once, in one notice above the homing, jog and
// work-zero sections (one reason usually disables them all), each control described by its line. Doc: docs/conventions/ui.md#run-mode-safety-ui,
// docs/modes/run-v0.1.md#commands-and-queries
import { useEffect, useId, useState } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import type { TimeScale } from '../../../../core/run/clock'
import { runMessages } from '../../messages/run'
import { Icon, Button, ConfirmDialog, ErrorMessage, Select, StatusChip } from '../../ui'
import { JogPad } from './JogPad'
import { formatLength, isConnected, runGates } from './machine-state'
import { runnablePlans } from './plan-info'
import { useRun, useRunStore, type Axis } from './run-store'
import styles from './Run.module.css'

const m = runMessages.navigator

const TIME_SCALES: readonly TimeScale[] = [1, 10, 100, 'max']
const scaleValue = (s: TimeScale) => String(s)
const parseScale = (v: string): TimeScale => (v === 'max' ? 'max' : Number(v))

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId()
  return (
    <section className={styles['section']} aria-labelledby={id}>
      <h3 id={id} className={styles['sectionTitle']}>
        {title}
      </h3>
      {children}
    </section>
  )
}

function Why({ id, reason }: { id: string; reason: string | null }) {
  return reason === null ? null : (
    <p id={id} className={styles['why']}>
      {reason}
    </p>
  )
}

/**
 * The distinct reasons the navigator's controls are disabled, each shown once (UX audit: the same
 * "Connect … first" under every section read as noise); a control's `aria-describedby` is its line.
 */
function WhyNotice({ reasons }: { reasons: readonly { id: string; text: string }[] }) {
  return reasons.length === 0 ? null : (
    <div className={styles['notice']}>
      <Icon name="info" />
      <div>
        {reasons.map((r) => (
          <p key={r.id} id={r.id} className={styles['why']}>
            {r.text}
          </p>
        ))}
      </div>
    </div>
  )
}

export function RunNavigator({ doc }: { doc: ProjectDoc }): React.JSX.Element {
  const store = useRunStore()
  const status = useRun((s) => s.status)
  const planId = useRun((s) => s.planId)
  const setupId = useRun((s) => s.setupId)
  const timeScale = useRun((s) => s.timeScale)
  const jogStep = useRun((s) => s.jogStep)
  const pending = useRun((s) => s.pending)
  const actionError = useRun((s) => s.actionError)
  const [unlockOpen, setUnlockOpen] = useState(false)
  const whyBase = useId()
  const a = store.getState()

  const plans = runnablePlans(doc)
  // the chosen plan, else the first runnable one
  const chosen = plans.some((p) => p.id === planId) ? planId : plans[0]?.id
  useEffect(() => {
    if (chosen !== planId) store.getState().setPlan(chosen)
  }, [chosen, planId, store])
  const setups = chosen === undefined ? [] : (doc.plans[chosen]?.setups ?? [])
  const setupChosen = setups.some((x) => x.id === setupId) ? setupId : setups[0]?.id

  const connected = isConnected(status)
  const gates = runGates(status, { planChosen: chosen !== undefined })
  const liveScale = connected ? status.connection.timeScale : timeScale
  const units = doc.unitSystem
  const busy = (name: string) => pending.includes(name)
  // one line per distinct reason (home, jog, work zero, disconnect), in that order
  const gated = [gates.home, gates.jog, gates.workZero, connected ? gates.disconnect : null]
  const reasons = [...new Set(gated.filter((r) => r !== null))].map((text, i) => ({
    id: `${whyBase}-${i}`,
    text,
  }))
  const reasonId = (r: string | null) => reasons.find((x) => x.text === r)?.id ?? ''
  const ids = {
    home: reasonId(gates.home),
    jog: reasonId(gates.jog),
    zero: reasonId(gates.workZero),
    connect: reasonId(gates.disconnect),
  }

  return (
    <div className={styles['panel']}>
      {actionError ? <ErrorMessage error={actionError} className={styles['banner']} /> : null}

      <Section title={m.plan}>
        <Select
          aria-label={m.plan}
          placeholder={m.planPlaceholder}
          options={plans.map((p) => ({ value: p.id, label: p.name }))}
          {...(chosen === undefined ? {} : { value: chosen })}
          onValueChange={(v) => a.setPlan(v)}
        />
      </Section>

      {setups.length > 1 ? (
        <Section title={m.setup}>
          <Select
            aria-label={m.setup}
            options={setups.map((x, i) => ({ value: x.id, label: `${i + 1}. ${x.name}` }))}
            {...(setupChosen === undefined ? {} : { value: setupChosen })}
            onValueChange={(v) => a.setSetup(v)}
          />
          <p className={styles['hint']}>{m.setupHint}</p>
        </Section>
      ) : null}

      <Section title={m.connection}>
        <div className={styles['row']}>
          <span className={styles['rowLabel']} aria-hidden="true">
            {m.timeScale}
          </span>
          <Select
            aria-label={m.timeScale}
            options={TIME_SCALES.map((s) => ({
              value: scaleValue(s),
              label: runMessages.timeScale(s),
            }))}
            value={scaleValue(liveScale)}
            onValueChange={(v) => a.setTimeScale(parseScale(v))}
          />
        </div>
        {connected ? (
          <>
            <Button
              size="lg"
              icon={<Icon name="disconnect" />}
              disabled={gates.disconnect !== null || busy('run.connection.close')}
              {...(gates.disconnect === null ? {} : { 'aria-describedby': ids.connect })}
              onClick={() => void a.disconnect()}
            >
              {m.disconnect}
            </Button>
          </>
        ) : (
          <>
            <Button
              size="lg"
              variant="primary"
              className={styles['wrapButton']}
              icon={<Icon name="connect" />}
              disabled={
                chosen === undefined ||
                status.connection.state !== 'closed' ||
                busy('run.connection.open')
              }
              onClick={() => void a.connect()}
            >
              {m.connect}
            </Button>
            <p className={styles['hint']}>{m.connectHint}</p>
          </>
        )}
      </Section>

      <WhyNotice reasons={reasons} />

      <Section title={m.homing}>
        <div className={styles['buttons']}>
          <Button
            size="lg"
            icon={<Icon name="home" />}
            disabled={gates.home !== null || busy('run.machine.home')}
            {...(gates.home === null ? {} : { 'aria-describedby': ids.home })}
            onClick={() => void a.home()}
          >
            {m.home}
          </Button>
          <Button
            size="lg"
            disabled={gates.unlock !== null || !status.state.startsWith('Alarm')}
            onClick={() => setUnlockOpen(true)}
          >
            {m.unlock}
          </Button>
          {connected ? (
            <StatusChip tone={status.homed ? 'success' : 'warning'}>
              {status.homed ? m.homed : m.notHomed}
            </StatusChip>
          ) : null}
        </div>
        <ConfirmDialog
          open={unlockOpen}
          onOpenChange={setUnlockOpen}
          title={runMessages.unlockConfirm.title}
          description={runMessages.unlockConfirm.description}
          confirmLabel={runMessages.unlockConfirm.confirm}
          onConfirm={() => void a.unlock()}
        />
      </Section>

      <Section title={m.jog}>
        <JogPad
          units={units}
          step={jogStep}
          onStep={a.setJogStep}
          onJog={(axis, mm, feed) => void a.jog(axis, mm, feed)}
          onCancel={() => void a.jogCancel()}
          disabledReason={gates.jog}
          reasonId={ids.jog}
          reasonShown={false}
        />
      </Section>

      <Section title={m.workZero}>
        <WorkZeroButtons
          gate={gates.workZero}
          reasonId={ids.zero}
          reasonShown={false}
          onZero={(axes) => void a.setWorkZero(axes)}
        />
        {connected ? (
          <p className={styles['hint']}>
            G54 {status.workZero.map((v) => formatLength(v, units)).join(' · ')}{' '}
            {runMessages.dro.units[units]}
          </p>
        ) : (
          <p className={styles['hint']}>{m.workZeroHint}</p>
        )}
      </Section>
    </div>
  )
}

export function WorkZeroButtons({
  gate,
  reasonId,
  onZero,
  only,
  reasonShown = true,
}: {
  gate: string | null
  /** id of the reason text, for `aria-describedby`. */
  reasonId: string
  /** false: the reason is shown elsewhere (the navigator's notice) under `reasonId`. */
  reasonShown?: boolean
  onZero: (axes: readonly Axis[]) => void
  only?: Axis
}): React.JSX.Element {
  const disabled = gate !== null
  const describe = disabled ? { 'aria-describedby': reasonId } : {}
  const axes: readonly Axis[] = only === undefined ? ['x', 'y', 'z'] : [only]
  return (
    <>
      <div className={styles['buttons']}>
        {axes.map((axis) => (
          <Button
            key={axis}
            size="lg"
            disabled={disabled}
            {...describe}
            onClick={() => onZero([axis])}
          >
            {only === undefined ? m.zeroAxis(axis.toUpperCase()) : runMessages.toolChange.setZ}
          </Button>
        ))}
        {only === undefined ? (
          <Button
            size="lg"
            icon={<Icon name="work-zero" />}
            disabled={disabled}
            {...describe}
            onClick={() => onZero(['x', 'y', 'z'])}
          >
            {m.zeroAll}
          </Button>
        ) : null}
      </div>
      {reasonShown ? <Why id={reasonId} reason={gate} /> : null}
    </>
  )
}
