// Run mode navigator (ui.md#app-shell: "Run: connection, homing, jog, probing"): the plan to run
// and, when it has several, the setup (one program per setup, task E2), the virtual machine connection and its time scale, homing and unlock (confirmed;
// the real-machine Home confirmation can be skipped per machine, DF88), the jog pad and probing
// (the per-axis zero buttons are in the inspector's Position table since DF88). Disabled controls
// say why: once, in one notice above the homing, jog and probing sections (one reason usually
// disables them all), each control described by its line.
// Without a plan ("No plan (manual control)") it connects with a library machine (DF31). Without a
// project (DF80) only the machine select shows: manual control. The
// notice keeps a reserved height and a refused action shows at the end of the panel, so messages
// never move the controls (DF34). Doc: docs/conventions/ui.md#run-mode-safety-ui,
// docs/modes/run.md#machine-frame-and-manual-control-hardening-df31df35, #run-mode-presentation-df46,
// docs/modes/run-v0.1.md#commands-and-queries; serial port and real-machine confirmations:
// docs/modes/run-machine.md#ports-and-the-port-picker, docs/modes/run.md#3-confirmations-before-motion;
// continuous jog and the alarm panel: docs/modes/run-machine.md#machine-readiness-m3
import { useEffect, useId, useRef, useState } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import type { TimeScale } from '../../../../core/run/clock'
import { runMessages } from '../../messages/run'
import { useSettings } from '../../shell/ShellContext'
import {
  Icon,
  IconButton,
  Button,
  Checkbox,
  ConfirmDialog,
  ErrorMessage,
  Menu,
  Select,
  StatusChip,
} from '../../ui'
import { AlarmPanel, DoorPanel, LostConnectionWarning, ReconnectStatus } from './AlarmPanel'
import { JogPad, useJogControls, useMachineJog } from './JogPad'
import { planLabel } from '../plan/model'
import { useLibraryItems } from '../plan/usePlan'
import {
  actionText,
  activeJob,
  formatLength,
  goToOpenGate,
  isConnected,
  isResetAlarm,
  needsHoming,
  runGates,
} from './machine-state'
import { firstRunSetup, runnablePlans } from './plan-info'
import { NO_PLAN, useRun, useRunStore, useRunUnits, type Axis } from './run-store'
import { SerialPicker, SettingsWarning } from './SerialPicker'
import { ProbeZButton, usePlateThickness } from './ProbeZButton'
import { ProbeInput } from './ProbeInput'
import { SpindleControl } from './SpindleControl'
import { useMachineOverrideLimits } from './OverridesSection'
import styles from './Run.module.css'

const m = runMessages.navigator

const TIME_SCALES: readonly TimeScale[] = [1, 10, 100, 'max']
const scaleValue = (s: TimeScale) => String(s)
const parseScale = (v: string): TimeScale => (v === 'max' ? 'max' : Number(v))

function Section({
  title,
  menu,
  children,
}: {
  title: string
  /** A menu button at the title's end (DF128 GT2: the jog section's "Go to…"). */
  menu?: React.ReactNode
  children: React.ReactNode
}) {
  const id = useId()
  const heading = (
    <h3 id={id} className={styles['sectionTitle']}>
      {title}
    </h3>
  )
  return (
    <section className={styles['section']} aria-labelledby={id}>
      {menu === undefined ? (
        heading
      ) : (
        <div className={styles['sectionHead']}>
          {heading}
          {menu}
        </div>
      )}
      {children}
    </section>
  )
}

/**
 * DF128 GT2 (Q157): the jog section's menu, "Go to…" (`G`) for keyboard users; disabled with the
 * DRO buttons' gate. The dialog opens once the menu has closed (instead of the menu focusing its
 * button, which would take the focus back from the dialog's field); focus returns to the menu
 * button when the dialog closes.
 */
function JogMenu({
  gate,
  onGoTo,
  guard,
}: {
  gate: string | null
  onGoTo: (opener: HTMLElement | null) => void
  /** DF133 RW3 (Q186): the "Workholding guard" switch, while the setup has items to guard. */
  guard?: { readonly on: boolean; toggle(): void }
}) {
  const g = runMessages.goTo
  const trigger = useRef<HTMLButtonElement>(null)
  const chosen = useRef(false)
  return (
    <Menu
      label={g.menu}
      align="end"
      onCloseAutoFocus={(e) => {
        if (!chosen.current) return
        chosen.current = false
        e.preventDefault()
        onGoTo(trigger.current)
      }}
      items={[
        {
          label: g.open,
          shortcut: 'G',
          description: g.openHint,
          disabledReason: gate ?? undefined,
          onSelect: () => {
            chosen.current = true
          },
        },
        ...(guard === undefined
          ? []
          : [
              'separator' as const,
              {
                label: runMessages.guard.switchLabel,
                description: runMessages.guard.switchHint,
                checked: guard.on,
                onSelect: guard.toggle,
              },
            ]),
      ]}
    >
      <IconButton
        ref={trigger}
        label={g.menu}
        icon={<Icon name="more" />}
        className={styles['sectionMenu']}
      />
    </Menu>
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

/** `doc` undefined: no project (DF80), manual control with a library machine only. */
export function RunNavigator({ doc }: { doc: ProjectDoc | undefined }): React.JSX.Element {
  const store = useRunStore()
  const status = useRun((s) => s.status)
  const planId = useRun((s) => s.planId)
  const setupId = useRun((s) => s.setupId)
  const timeScale = useRun((s) => s.timeScale)
  const jog = useJogControls(doc)
  const spindleMachine = useMachineOverrideLimits(doc)
  const guardSetup = useRun((s) => s.guardSetup)
  const guardOff = useRun((s) => s.guardOff)
  const machineKey = useMachineJog(doc).key
  const skipHome = useSettings((s) => s.settings.skipHomeConfirm)
  // DF143: an advanced user homes, unlocks and starts the spindle without confirmations
  const advanced = useSettings((s) => s.settings.advancedUser)
  const backOffMm = useSettings((s) => s.settings.limitBackOff)
  const updateSettings = useSettings((s) => s.update)
  const pending = useRun((s) => s.pending)
  const actionError = useRun((s) => s.actionError)
  const zeroUndo = useRun((s) => s.zeroUndo)
  const [unlockOpen, setUnlockOpen] = useState(false)
  const [homeOpen, setHomeOpen] = useState(false)
  const [dontAsk, setDontAsk] = useState(false)
  const connectTo = useRun((s) => s.connectTo)
  const ports = useRun((s) => s.ports)
  const portPath = useRun((s) => s.portPath)
  const baud = useRun((s) => s.baud)
  const settingsCheck = useRun((s) => s.settingsCheck)
  const whyBase = useId()
  const a = store.getState()

  const machineId = useRun((s) => s.machineId)
  const plate = usePlateThickness(doc)
  const plans = doc === undefined ? [] : runnablePlans(doc)
  // the chosen plan (or manual control), else the first runnable one, else manual control (DF31)
  const chosen =
    planId === NO_PLAN || plans.some((p) => p.id === planId) ? planId : (plans[0]?.id ?? NO_PLAN)
  const manual = chosen === NO_PLAN
  // without a project (DF80) the window's plan choice is left unset, not "manual control", so a
  // project opened later starts at its first runnable plan as usual
  const stored = doc === undefined && planId !== NO_PLAN ? undefined : chosen
  useEffect(() => {
    if (stored !== planId) store.getState().setPlan(stored)
  }, [stored, planId, store])
  const machines = useLibraryItems('machine')
  const machineChosen =
    machines?.some((x) => x.id === machineId) === true ? machineId : machines?.[0]?.id
  useEffect(() => {
    if (manual && machineChosen !== machineId) store.getState().setMachine(machineChosen)
  }, [manual, machineChosen, machineId, store])
  const chosenPlan = chosen === undefined || manual ? undefined : doc?.plans[chosen]
  const setups = chosenPlan?.setups ?? []
  // DF137: by default the first setup with a program (not cut in full)
  const setupChosen = setups.some((x) => x.id === setupId)
    ? setupId
    : chosenPlan === undefined
      ? undefined
      : firstRunSetup(chosenPlan)?.id

  const connected = isConnected(status)
  // the serial port is the default choice (DF101): list the ports once, as choosing it does
  const closed = status.connection.state === 'closed'
  useEffect(() => {
    if (closed && connectTo === 'serial' && ports === undefined) void store.getState().scanPorts()
  }, [closed, connectTo, ports, store])
  const gates = runGates(status, { planChosen: chosen !== undefined && !manual })
  const liveScale = connected ? status.connection.timeScale : timeScale
  // the open connection's target decides, else the choice
  const serial = connected ? status.connection.target === 'serial' : connectTo === 'serial'
  const units = useRunUnits(doc)
  const busy = (name: string) => pending.includes(name)
  // v0.5 RV5: Set X/Y zero needs the work-zero gate and no program (the routine is a job)
  const xyZeroGate =
    gates.workZero ?? (activeJob(status) !== undefined ? runMessages.xyZero.gate.running : null)
  // v0.5 RV6: Check alignment as Set X/Y zero, once G54 X/Y is set (the stops follow it)
  const checkGate =
    xyZeroGate ??
    (status.workZero[0] === 0 && status.workZero[1] === 0 ? runMessages.checkAlign.zeroFirst : null)
  // one line per distinct reason (home, jog, work zero, disconnect), in that order
  const gated = [gates.home, gates.jog, gates.workZero, connected ? gates.disconnect : null]
  const reasons = [...new Set(gated.filter((r) => r !== null))].map((text, i) => ({
    id: `${whyBase}-${i}`,
    text,
  }))
  const reasonId = (r: string | null) => reasons.find((x) => x.text === r)?.id ?? ''
  const next = manual ? m.readyNoPlan : m.ready
  const refused = actionError === undefined ? undefined : actionText(actionError, units)
  const ids = {
    home: reasonId(gates.home),
    jog: reasonId(gates.jog),
    zero: reasonId(gates.workZero),
    connect: reasonId(gates.disconnect),
    check: `${whyBase}-check`,
    probe: `${whyBase}-probe`,
  }

  return (
    <div className={styles['panel']}>
      {doc === undefined ? (
        // no project (DF80): nothing to run, only the machine to control
        <Section title={m.machine}>
          <Select
            aria-label={m.machine}
            placeholder={m.machinePlaceholder}
            disabled={connected}
            options={(machines ?? []).map((x) => ({ value: x.id, label: x.name }))}
            {...(machineChosen === undefined ? {} : { value: machineChosen })}
            onValueChange={(v) => a.setMachine(v)}
          />
          <p className={styles['hint']}>
            {machines !== undefined && machines.length === 0 ? m.noMachines : m.machineHint}
          </p>
        </Section>
      ) : (
        <Section title={m.plan}>
          <Select
            aria-label={m.plan}
            placeholder={m.planPlaceholder}
            disabled={connected}
            options={[
              { value: NO_PLAN, label: m.noPlan },
              ...plans.map((p) => ({
                value: p.id,
                label: doc === undefined ? p.name : planLabel(doc, p),
              })),
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
      )}

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
            {/* DF129, Q173: practise a lost connection on the virtual machine, mid-run */}
            {!serial && status.job !== undefined ? (
              <>
                <Button onClick={() => void a.reconnect('simulate')}>{m.reconnect.simulate}</Button>
                <p className={styles['hint']}>{m.reconnect.simulateHint}</p>
              </>
            ) : null}
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
              {m.connect}
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
            // the next step while GRBL's start-up lock holds (DF46): one primary in the panel
            // DF134: also after a reset from a hard or soft limit (Home recommended over Unlock)
            {...(needsHoming(status) || isResetAlarm(status)
              ? { variant: 'primary' as const }
              : {})}
            icon={<Icon name="home" />}
            disabled={gates.home !== null || busy('run.machine.home')}
            {...(gates.home === null ? {} : { 'aria-describedby': ids.home })}
            // a real machine not yet homed moves to its corner: confirmed once (run.md § Safety 3)
            // DF88: unless "Don't ask again" was checked for this library machine
            onClick={() => {
              const ask =
                !advanced &&
                serial &&
                !status.homed &&
                (machineKey === undefined || !skipHome.includes(machineKey))
              if (!ask) return void a.home()
              setDontAsk(false)
              setHomeOpen(true)
            }}
          >
            {m.home}
          </Button>
          <Button
            size="lg"
            disabled={gates.unlock !== null || !status.state.startsWith('Alarm')}
            onClick={() => (advanced ? void a.unlock() : setUnlockOpen(true))}
          >
            {m.unlock}
          </Button>
          {connected ? (
            <StatusChip
              tone={status.homed && status.positionUnverified !== true ? 'success' : 'warning'}
            >
              {!status.homed
                ? m.notHomed
                : status.positionUnverified === true
                  ? m.unverified
                  : m.homed}
            </StatusChip>
          ) : null}
        </div>
        {/* v0.5 RV7: the work area, marked after homing (run.md#work-area-rv7) */}
        {connected ? (
          <div className={styles['buttons']}>
            <Button
              disabled={activeJob(status) !== undefined}
              onClick={() => a.setWorkAreaOpen(true)}
            >
              {runMessages.workArea.button}
            </Button>
            {/* v0.5 RV8: homing repeatability (run-machine.md#homing-repeatability-rv8) */}
            <Button
              disabled={activeJob(status) !== undefined}
              onClick={() => a.setRepeatOpen(true)}
            >
              {runMessages.repeat.button}
            </Button>
            {/* v0.5 RV9: calibration cuts on the plan's stock (run-calibration.md) */}
            {!manual ? (
              <Button
                disabled={activeJob(status) !== undefined}
                onClick={() => a.setCalibrationOpen(true)}
              >
                {runMessages.calibration.button}
              </Button>
            ) : null}
          </div>
        ) : null}
        <ConfirmDialog
          open={homeOpen}
          onOpenChange={setHomeOpen}
          title={runMessages.homeConfirm.title}
          description={runMessages.homeConfirm.description}
          {...(machineKey === undefined
            ? {}
            : {
                extra: (
                  <Checkbox
                    label={runMessages.homeConfirm.dontAsk}
                    checked={dontAsk}
                    onCheckedChange={(c) => setDontAsk(c === true)}
                  />
                ),
              })}
          confirmLabel={runMessages.homeConfirm.confirm}
          onConfirm={() => {
            if (dontAsk && machineKey !== undefined && !skipHome.includes(machineKey))
              updateSettings({ skipHomeConfirm: [...skipHome, machineKey] })
            void a.home()
          }}
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

      <Section
        title={m.jog}
        menu={
          <JogMenu
            gate={goToOpenGate(status)}
            onGoTo={(opener) => a.openGoTo({ frame: 'work', axis: 'x', opener })}
            {...(guardSetup === undefined
              ? {}
              : { guard: { on: !guardOff, toggle: () => a.setGuardOff(!guardOff) } })}
          />
        }
      >
        <JogPad controls={jog} disabledReason={gates.jog} reasonId={ids.jog} reasonShown={false} />
        {/* v0.5 RV1: under the pad, so nothing above it moves (DF34) */}
        <SpindleControl
          status={status}
          machine={spindleMachine}
          onSpindle={a.spindle}
          sharedReason={reasonId}
          confirmStart={!advanced}
        />
      </Section>

      {/* DF88: the zero buttons moved to the Position table; Probe Z is what is left */}
      <Section title={m.probing}>
        <ProbeZButton
          doc={doc}
          input={ids.probe}
          thickness={plate}
          gate={gates.workZero}
          reasonId={ids.zero}
          units={units}
          busy={busy('run.machine.probeZ')}
          onProbe={(t) => void a.probeZ(t)}
        />
        {plate === undefined ? <p className={styles['hint']}>{m.noPlate}</p> : null}
        {/* v0.5 RV5: Set X/Y zero (run-probing.md#set-xy-zero-rv5) and the undo of its last set */}
        <div className={styles['buttons']}>
          <Button
            disabled={xyZeroGate !== null}
            {...(gates.workZero === null ? {} : { 'aria-describedby': ids.zero })}
            onClick={() => a.setXyZeroOpen(true)}
          >
            {runMessages.xyZero.button}
          </Button>
          {/* v0.5 RV6: Check alignment (alignment.md#check-alignment-rv6), after the X/Y zero */}
          <Button
            disabled={checkGate !== null}
            {...(checkGate === null
              ? {}
              : { 'aria-describedby': xyZeroGate === null ? ids.check : ids.zero })}
            onClick={() => a.setCheckAlignOpen(true)}
          >
            {runMessages.checkAlign.button}
          </Button>
          {/* v0.5 RV10: Map stock surface (run-surface.md#probing-a-map) */}
          {!manual ? (
            <Button disabled={xyZeroGate !== null} onClick={() => a.setSurfaceMapOpen(true)}>
              {runMessages.surface.button}
            </Button>
          ) : null}
          {zeroUndo === undefined ? null : (
            <Button
              variant="ghost"
              icon={<Icon name="undo" />}
              disabled={gates.workZero !== null}
              title={runMessages.xyZero.undoHint(
                formatLength(zeroUndo.before[0], units),
                formatLength(zeroUndo.before[1], units),
                runMessages.dro.units[units],
              )}
              onClick={() => void a.undoXyZero()}
            >
              {runMessages.xyZero.undo}
            </Button>
          )}
        </div>
        {xyZeroGate === null && checkGate !== null ? (
          <p id={ids.check} className={styles['hint']}>
            {checkGate}
          </p>
        ) : null}
        {/* v0.5 RV3 Test probe, DF143 the probe check: the input live from `Pn:P` (run-probing.md) */}
        <ProbeInput doc={doc} id={ids.probe} />
      </Section>

      {/* at the end: an alarm, a lost connection or a refusal never moves the controls (DF34) */}
      <AlarmPanel
        status={status}
        {...(advanced
          ? {
              backOff: {
                distance: backOffMm,
                units,
                busy: busy('run.machine.backOff'),
                onBackOff: () => void a.backOff(backOffMm),
              },
            }
          : {})}
      />
      <DoorPanel status={status} />
      <LostConnectionWarning status={status} />
      <ReconnectStatus status={status} onStop={() => void a.reconnect('cancel')} />
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
      </div>
      {reasonShown ? <Why id={reasonId} reason={gate} /> : null}
    </>
  )
}
