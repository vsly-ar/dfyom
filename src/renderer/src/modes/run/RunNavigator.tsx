// Run mode navigator (ui.md#app-shell: "Run: connection, homing, jog, work zero"): the plan to run
// and, when it has several, the setup (one program per setup, task E2), the virtual machine connection and its time scale, homing and unlock (confirmed), the jog pad
// and the work zero. Disabled controls say why: once, in one notice above the homing, jog and
// work-zero sections (one reason usually disables them all), each control described by its line.
// Without a plan ("No plan (manual control)") it connects with a library machine (DF31). The
// notice keeps a reserved height and a refused action shows at the end of the panel, so messages
// never move the controls (DF34). Doc: docs/conventions/ui.md#run-mode-safety-ui,
// docs/modes/run.md#machine-frame-and-manual-control-hardening-df31df35,
// docs/modes/run-v0.1.md#commands-and-queries; serial port and real-machine confirmations:
// docs/modes/run-machine.md#ports-and-the-port-picker, docs/modes/run.md#3-confirmations-before-motion;
// continuous jog and the alarm panel: docs/modes/run-machine.md#machine-readiness-m3
import { useEffect, useId, useState } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import type { TimeScale } from '../../../../core/run/clock'
import { runMessages } from '../../messages/run'
import { Icon, Button, ConfirmDialog, ErrorMessage, Select, StatusChip } from '../../ui'
import { AlarmPanel, LostConnectionWarning } from './AlarmPanel'
import { JogPad, useJogMode } from './JogPad'
import { useLibraryItems } from '../plan/usePlan'
import { actionText, formatLength, isConnected, runGates } from './machine-state'
import { runnablePlans } from './plan-info'
import { NO_PLAN, useRun, useRunStore, type Axis } from './run-store'
import { SerialPicker, SettingsWarning } from './SerialPicker'
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
 * Always rendered at a reserved height (DF34): with nothing disabled it says the next step.
 */
function WhyNotice({
  reasons,
  next,
}: {
  reasons: readonly { id: string; text: string }[]
  next: string
}) {
  return (
    <div className={styles['notice']} role="status" aria-label={m.status}>
      <Icon name="info" />
      <div>
        {reasons.length === 0 ? (
          <p className={styles['why']}>{next}</p>
        ) : (
          reasons.map((r) => (
            <p key={r.id} id={r.id} className={styles['why']}>
              {r.text}
            </p>
          ))
        )}
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
  const jogMode = useJogMode()
  const pending = useRun((s) => s.pending)
  const actionError = useRun((s) => s.actionError)
  const [unlockOpen, setUnlockOpen] = useState(false)
  const [homeOpen, setHomeOpen] = useState(false)
  const connectTo = useRun((s) => s.connectTo)
  const ports = useRun((s) => s.ports)
  const portPath = useRun((s) => s.portPath)
  const baud = useRun((s) => s.baud)
  const settingsCheck = useRun((s) => s.settingsCheck)
  const whyBase = useId()
  const a = store.getState()

  const machineId = useRun((s) => s.machineId)
  const plans = runnablePlans(doc)
  // the chosen plan (or manual control), else the first runnable one, else manual control (DF31)
  const chosen =
    planId === NO_PLAN || plans.some((p) => p.id === planId) ? planId : (plans[0]?.id ?? NO_PLAN)
  const manual = chosen === NO_PLAN
  useEffect(() => {
    if (chosen !== planId) store.getState().setPlan(chosen)
  }, [chosen, planId, store])
  const machines = useLibraryItems('machine')
  const machineChosen =
    machines?.some((x) => x.id === machineId) === true ? machineId : machines?.[0]?.id
  useEffect(() => {
    if (manual && machineChosen !== machineId) store.getState().setMachine(machineChosen)
  }, [manual, machineChosen, machineId, store])
  const setups = chosen === undefined || manual ? [] : (doc.plans[chosen]?.setups ?? [])
  const setupChosen = setups.some((x) => x.id === setupId) ? setupId : setups[0]?.id

  const connected = isConnected(status)
  const gates = runGates(status, { planChosen: chosen !== undefined && !manual })
  const liveScale = connected ? status.connection.timeScale : timeScale
  // the open connection's target decides, else the choice
  const serial = connected ? status.connection.target === 'serial' : connectTo === 'serial'
  const units = doc.unitSystem
  const busy = (name: string) => pending.includes(name)
  // one line per distinct reason (home, jog, work zero, disconnect), in that order
  const gated = [gates.home, gates.jog, gates.workZero, connected ? gates.disconnect : null]
  const reasons = [...new Set(gated.filter((r) => r !== null))].map((text, i) => ({
    id: `${whyBase}-${i}`,
    text,
  }))
  const reasonId = (r: string | null) => reasons.find((x) => x.text === r)?.id ?? ''
  const atHome = connected && status.homed && status.workZero.every((v) => v === 0)
  const next = manual ? m.readyNoPlan : m.ready
  const refused = actionError === undefined ? undefined : actionText(actionError, units)
  const ids = {
    home: reasonId(gates.home),
    jog: reasonId(gates.jog),
    zero: reasonId(gates.workZero),
    connect: reasonId(gates.disconnect),
  }

  return (
    <div className={styles['panel']}>
      <Section title={m.plan}>
        <Select
          aria-label={m.plan}
          placeholder={m.planPlaceholder}
          disabled={connected}
          options={[
            { value: NO_PLAN, label: m.noPlan },
            ...plans.map((p) => ({ value: p.id, label: p.name })),
          ]}
          {...(chosen === undefined ? {} : { value: chosen })}
          onValueChange={(v) => a.setPlan(v)}
        />
        {manual ? (
          <div className={styles['row']}>
            <span className={styles['rowLabel']} aria-hidden="true">
              {m.machine}
            </span>
            <Select
              aria-label={m.machine}
              placeholder={m.machinePlaceholder}
              disabled={connected}
              options={(machines ?? []).map((x) => ({ value: x.id, label: x.name }))}
              {...(machineChosen === undefined ? {} : { value: machineChosen })}
              onValueChange={(v) => a.setMachine(v)}
            />
          </div>
        ) : null}
        {manual && machines !== undefined && machines.length === 0 ? (
          <p className={styles['hint']}>{m.noMachines}</p>
        ) : null}
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
        {connected ? null : (
          <SerialPicker
            connectTo={connectTo}
            ports={ports}
            portPath={portPath}
            baud={baud}
            scanning={busy('run.ports.scan')}
            disabled={status.connection.state !== 'closed'}
            onConnectTo={a.setConnectTo}
            onPort={a.setPort}
            onBaud={a.setBaud}
            onScan={() => void a.scanPorts()}
          />
        )}
        {serial ? null : (
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
        )}
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
            {serial && settingsCheck !== undefined ? (
              <SettingsWarning check={settingsCheck} machineId={manual ? machineId : undefined} />
            ) : null}
          </>
        ) : (
          <>
            <Button
              size="lg"
              variant="primary"
              className={styles['wrapButton']}
              icon={<Icon name="connect" />}
              disabled={
                (manual ? machineChosen === undefined : chosen === undefined) ||
                (serial && portPath === undefined) ||
                status.connection.state !== 'closed' ||
                busy('run.connection.open')
              }
              onClick={() => void a.connect()}
            >
              {serial ? m.connectSerial : m.connect}
            </Button>
            <p className={styles['hint']}>
              {serial ? m.connectHintSerial : manual ? m.connectHintNoPlan : m.connectHint}
            </p>
          </>
        )}
      </Section>

      <WhyNotice reasons={reasons} next={next} />

      <Section title={m.homing}>
        <div className={styles['buttons']}>
          <Button
            size="lg"
            icon={<Icon name="home" />}
            disabled={gates.home !== null || busy('run.machine.home')}
            {...(gates.home === null ? {} : { 'aria-describedby': ids.home })}
            // a real machine not yet homed moves to its corner: confirmed once (run.md § Safety 3)
            onClick={() => (serial && !status.homed ? setHomeOpen(true) : void a.home())}
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
          open={homeOpen}
          onOpenChange={setHomeOpen}
          title={runMessages.homeConfirm.title}
          description={runMessages.homeConfirm.description}
          confirmLabel={runMessages.homeConfirm.confirm}
          onConfirm={() => void a.home()}
        />
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
          {...jogMode}
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
            {atHome ? ` · ${m.workZeroAtHome}` : null}
          </p>
        ) : (
          <p className={styles['hint']}>{m.workZeroHint}</p>
        )}
      </Section>

      {/* at the end: an alarm, a lost connection or a refusal never moves the controls (DF34) */}
      <AlarmPanel status={status} />
      <LostConnectionWarning status={status} />
      {actionError ? (
        <ErrorMessage
          error={actionError}
          className={styles['banner']}
          {...(refused === undefined ? {} : { message: refused })}
        />
      ) : null}
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
