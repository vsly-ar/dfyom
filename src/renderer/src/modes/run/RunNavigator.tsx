// Run mode navigator (ui.md#app-shell: "Run: connection, homing, jog, work zero"): the plan to run,
// the virtual machine connection and its time scale, homing and unlock (confirmed), the jog pad
// and the work zero. Disabled controls say why. Doc: docs/conventions/ui.md#run-mode-safety-ui,
// docs/modes/run-v0.1.md#commands-and-queries
import { Crosshair, House, Plug, Unplug } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import type { TimeScale } from '../../../../core/run/clock'
import { runMessages } from '../../messages/run'
import { Button, ConfirmDialog, ErrorMessage, Select, StatusChip } from '../../ui'
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

export function RunNavigator({ doc }: { doc: ProjectDoc }): React.JSX.Element {
  const store = useRunStore()
  const status = useRun((s) => s.status)
  const planId = useRun((s) => s.planId)
  const timeScale = useRun((s) => s.timeScale)
  const jogStep = useRun((s) => s.jogStep)
  const pending = useRun((s) => s.pending)
  const actionError = useRun((s) => s.actionError)
  const [unlockOpen, setUnlockOpen] = useState(false)
  const ids = { home: useId(), jog: useId(), zero: useId(), connect: useId() }
  const a = store.getState()

  const plans = runnablePlans(doc)
  // the chosen plan, else the first runnable one
  const chosen = plans.some((p) => p.id === planId) ? planId : plans[0]?.id
  useEffect(() => {
    if (chosen !== planId) store.getState().setPlan(chosen)
  }, [chosen, planId, store])

  const connected = isConnected(status)
  const gates = runGates(status, { planChosen: chosen !== undefined })
  const liveScale = connected ? status.connection.timeScale : timeScale
  const units = doc.unitSystem
  const busy = (name: string) => pending.includes(name)

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
              icon={<Unplug aria-hidden="true" />}
              disabled={gates.disconnect !== null || busy('run.connection.close')}
              {...(gates.disconnect === null ? {} : { 'aria-describedby': ids.connect })}
              onClick={() => void a.disconnect()}
            >
              {m.disconnect}
            </Button>
            <Why id={ids.connect} reason={gates.disconnect} />
          </>
        ) : (
          <>
            <Button
              size="lg"
              variant="primary"
              icon={<Plug aria-hidden="true" />}
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

      <Section title={m.homing}>
        <div className={styles['buttons']}>
          <Button
            size="lg"
            icon={<House aria-hidden="true" />}
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
        <Why id={ids.home} reason={gates.home} />
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
        />
      </Section>

      <Section title={m.workZero}>
        <WorkZeroButtons
          gate={gates.workZero}
          reasonId={ids.zero}
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
}: {
  gate: string | null
  reasonId: string
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
            icon={<Crosshair aria-hidden="true" />}
            disabled={disabled}
            {...describe}
            onClick={() => onZero(['x', 'y', 'z'])}
          >
            {m.zeroAll}
          </Button>
        ) : null}
      </div>
      <Why id={reasonId} reason={gate} />
    </>
  )
}
