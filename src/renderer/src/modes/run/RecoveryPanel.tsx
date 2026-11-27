// The recovery panel (hardening DF129, RC5): after a run ended without DFYOM wanting it to (a
// lost connection, a controller reset, the machine's power), the Run inspector's run section shows
// a calm, step-by-step way back instead of "Start run": what happened and where the job was (each
// number with its source), then one open step at a time – make it safe (while the machine may
// still be moving; the live reconnect state with "Reconnect now"), check the machine, connect and
// home, check the work zero (with Go to the last position / the work zero, planned by
// core/run/goto.ts and confirmed here), choose how to continue (the RC3 pre-flight at the suggested
// resume point, the operation's start, a chosen line, or the beginning). Finished steps collapse
// with a tick; later ones stay visible, greyed, a click away. Neutral surface, an info icon, no red
// but the one safety line. RC6: the same panel for a run the last session left interrupted (the
// journal at launch, `interruption.launch`): where the run was from with "Open project" / "Open
// file" / "Locate…", and "Connect to …" (never by itself, Q158) in place of the reconnect line.
// Doc: docs/modes/run-recovery.md#the-recovery-panel, #implementation-rc5, #implementation-rc6,
// docs/conventions/ui.md#run-mode-safety-ui
import { useEffect, useId, useState } from 'react'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import { goToMoves, goToSafeZ, goToSeconds, type Vec3 } from '../../../../core/run/goto'
import type { Interruption, LaunchInfo } from '../../../../core/run/interruption'
import { programHash } from '../../../../core/run/recovery'
import type { LastRun, RunStatus } from '../../../../core/run/service'
import { runMessages } from '../../messages/run'
import { useShell } from '../../shell/ShellContext'
import { Button, Checkbox, ConfirmDialog, Dialog, DialogClose, Icon } from '../../ui'
import { AlarmPanel, inAlarm } from './AlarmPanel'
import { useJogControls, useMachineJog } from './JogPad'
import { formatFeed, formatLength, goToOpenGate, isConnected, runGates } from './machine-state'
import { resumeChanges, setupClearance } from './plan-info'
import { useRun, useRunStore, useRunUnits, type RecoveryUi } from './run-store'
import styles from './Run.module.css'

const m = runMessages.recovery

const pad = (n: number) => String(n).padStart(2, '0')

/** A clock time (local, HH:MM:SS) of an ISO time. */
export function clockTime(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** A duration in words: "40 s", "23 min", "1 h 5 min". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const min = Math.round(s / 60)
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`
}

/** What happened, in one sentence (docs/modes/run-recovery.md#step-2--what-happened). */
export function reasonText(i: Interruption): string {
  const time = clockTime(i.at)
  const into = duration(Date.parse(i.at) - Date.parse(i.startedAt))
  switch (i.reason) {
    case 'connectionLost':
      return m.happened.connectionLost(time, into)
    case 'hostExit':
      return m.happened.hostExit(time, into)
    case 'controllerReset':
      return m.happened.controllerReset(time, into)
    case 'machinePowerLost':
      return m.happened.machinePowerLost(time)
    case 'appCrashed':
      return m.happened.appCrashed(time)
  }
}

const xyz = (v: readonly number[], units: UnitSystem): string =>
  `X ${formatLength(v[0] ?? 0, units)} Y ${formatLength(v[1] ?? 0, units)} Z ${formatLength(v[2] ?? 0, units)}`

/**
 * A position as three unbreakable "X 120.400" pieces (RC6): a narrow inspector wraps between the
 * axes, never inside a number.
 */
function Xyz({ v, units }: { v: readonly number[]; units: UnitSystem }): React.JSX.Element {
  return (
    <span className={styles['mono']}>
      {(['X', 'Y', 'Z'] as const).map((a, k) => (
        <span key={a}>
          {k === 0 ? '' : ' '}
          <span className={styles['coord']}>
            {a} {formatLength(v[k] ?? 0, units)}
          </span>
        </span>
      ))}
    </span>
  )
}

/** Same G54 within 1 µm per axis. */
const sameZero = (a: readonly number[], b: readonly number[]): boolean =>
  a.every((v, k) => Math.abs(v - (b[k] ?? 0)) < 0.001)

/** Where the job was: the operation, the tool, the last position, feed and spindle, the lines. */
export function RecoveryFacts({
  interruption: i,
  last,
  units,
}: {
  interruption: Interruption
  last: LastRun
  units: UnitSystem
}): React.JSX.Element {
  const unit = runMessages.dro.units[units]
  const r = i.lastReport
  const ops = last.operations ?? []
  const opIndex =
    i.operation?.planOperationId === undefined ? -1 : ops.indexOf(i.operation.planOperationId)
  // a file's section is a tool run: the Tool row says it (no operation without a plan)
  const opLabel =
    i.operation?.planOperationId === undefined && i.tool !== undefined
      ? undefined
      : i.operation?.label
  const percent = i.lines > 0 ? Math.round((i.executing / i.lines) * 100) : 0
  return (
    <dl className={`${styles['facts']} ${styles['recoveryFacts']}`} aria-label={m.factsLabel}>
      {opLabel === undefined ? null : (
        <>
          <dt>{m.operation}</dt>
          <dd>{opIndex < 0 ? opLabel : m.operationOf(opLabel, opIndex + 1, ops.length)}</dd>
        </>
      )}
      {i.tool === undefined ? null : (
        <>
          <dt>{m.tool}</dt>
          <dd>{m.toolName(i.tool.n, i.tool.name)}</dd>
        </>
      )}
      {r === undefined ? null : (
        <>
          <dt>{m.lastSeen}</dt>
          <dd>
            <Xyz v={r.wpos} units={units} /> {unit} ({m.work})
            <br />
            <span className={styles['hint']}>
              <Xyz v={r.mpos} units={units} /> ({m.machine}) ·{' '}
              {m.seenBefore(Math.max(0, (Date.parse(i.at) - Date.parse(r.at)) / 1000).toFixed(1))}
            </span>
          </dd>
          <dt>{m.feedSpindle}</dt>
          <dd>
            {formatFeed(r.feed, units)} {runMessages.dro.feedUnits[units]} ·{' '}
            {r.spindle > 0 || i.spindle.dir !== 'off'
              ? m.spindleRpm(
                  Math.round(r.spindle > 0 ? r.spindle : i.spindle.rpm).toLocaleString('en-US'),
                )
              : m.spindleOff}
          </dd>
        </>
      )}
      <dt>{m.lines}</dt>
      <dd>
        {i.executing === 0 ? (
          m.notYet
        ) : (
          <>
            {m.range(i.executing, Math.max(i.executing, i.acknowledged))}
            {i.sent > i.acknowledged ? m.mayHaveContinued(i.sent) : '.'}
            <br />
            <span className={styles['hint']}>
              {m.percent(percent)} {m.from[i.executingFrom]}
            </span>
          </>
        )}
      </dd>
    </dl>
  )
}

type StepKey = 'safe' | 'check' | 'home' | 'zero' | 'choose'

/** The panel in the run section while `lastRun.interruption` exists and no run streams. */
export function RecoveryPanel({ doc }: { doc: ProjectDoc | undefined }): React.JSX.Element | null {
  const store = useRunStore()
  const status = useRun((s) => s.status)
  const ui = useRun((s) => s.recoveryUi)
  const units = useRunUnits(doc)
  const titleId = useId()
  const last = status.lastRun
  const i = last?.interruption
  if (last === undefined || i === undefined) return null
  const mine: RecoveryUi =
    ui?.jobId === last.jobId
      ? ui
      : { jobId: last.jobId, safe: false, ticks: [], checked: false, zeroOk: false }
  const set = (patch: Partial<Omit<RecoveryUi, 'jobId'>>) =>
    store.getState().setRecoveryUi(last.jobId, patch)
  const connected = isConnected(status)
  const launch = i.launch
  // the machine may still run its buffer only after a lost link, until a reset reached it; after
  // a crash (RC6) a real machine has stopped, but its spindle may still be on
  const mayMove =
    launch === undefined
      ? i.reason === 'connectionLost' || i.reason === 'hostExit'
      : launch.machine.target === 'serial'
  const connect =
    launch === undefined ? undefined : <LaunchConnect doc={doc} last={last} launch={launch} />
  const done: Record<StepKey, boolean> = {
    safe: connected || mine.safe,
    check: mine.checked,
    home: connected && status.homed,
    zero: mine.zeroOk,
    choose: false,
  }
  const keys: StepKey[] = mayMove
    ? ['safe', 'check', 'home', 'zero', 'choose']
    : ['check', 'home', 'zero', 'choose']
  const current = keys.find((k) => !done[k]) ?? 'choose'
  // the current step is open unless the user opened another one, or closed it ("none:<step>",
  // until the next step becomes current)
  const opened = mine.open
  const open =
    opened === undefined || (opened.startsWith('none:') && opened !== `none:${current}`)
      ? current
      : opened
  const state = (k: StepKey) => (done[k] ? 'done' : k === current ? 'current' : 'upcoming')
  const toggle = (k: StepKey) =>
    set({ open: open === k ? (k === current ? `none:${current}` : undefined) : k })
  const titles: Record<StepKey, string> = {
    safe: m.safe.title,
    check: m.check.title,
    home: m.home.title,
    zero: m.zero.title,
    choose: m.choose.title,
  }
  const summary: Record<StepKey, string | undefined> = {
    safe: connected ? m.safe.reconnected : m.safe.confirmed,
    check: m.check.summary(mine.ticks.length, CHECKS.length),
    home: m.home.homed,
    zero: undefined,
    choose: undefined,
  }
  return (
    <section className={styles['recovery']} aria-labelledby={titleId}>
      <header className={styles['recoveryHead']}>
        <Icon name="info" />
        <div>
          <h3 id={titleId} className={styles['recoveryTitle']}>
            {m.title}
          </h3>
          <p className={styles['hint']}>{m.subtitle}</p>
        </div>
      </header>
      <p className={styles['why']}>
        {reasonText(i)}
        {status.connection.target === 'virtual' || status.connection.lost?.target === 'virtual'
          ? ` ${m.practice}`
          : ''}
      </p>
      <RecoveryFacts interruption={i} last={last} units={units} />
      {launch === undefined ? null : (
        <LaunchSource doc={doc} last={last} interruption={i} launch={launch} />
      )}
      <ol className={styles['recoverySteps']} aria-label={m.steps}>
        {keys.map((k, n) => {
          const st = state(k)
          const expanded = open === k
          return (
            <li key={k} className={styles['recoveryStep']} data-state={st}>
              <h4 className={styles['stepHead']}>
                <button type="button" aria-expanded={expanded} onClick={() => toggle(k)}>
                  <span className={styles['stepMarker']} aria-hidden="true">
                    {st === 'done' ? <Icon name="check" /> : n + 1}
                  </span>
                  <span>{titles[k]}</span>
                  <span className={styles['srOnly']}> ({m.stepState[st]})</span>
                </button>
              </h4>
              {expanded ? (
                <div className={styles['stepBody']}>
                  {k === 'safe' ? (
                    <SafeStep
                      status={status}
                      done={done.safe}
                      onStopped={() => set({ safe: true })}
                      connect={connect}
                    />
                  ) : k === 'check' ? (
                    <CheckStep ui={mine} set={set} />
                  ) : k === 'home' ? (
                    <HomeStep status={status} interruption={i} connect={connect} />
                  ) : k === 'zero' ? (
                    <ZeroStep
                      doc={doc}
                      status={status}
                      interruption={i}
                      units={units}
                      stockMoved={mine.checked && !mine.ticks.includes('stock')}
                      onOk={() => set({ zeroOk: true, open: undefined })}
                    />
                  ) : (
                    <ChooseStep doc={doc} status={status} last={last} interruption={i} />
                  )}
                </div>
              ) : st === 'done' && summary[k] !== undefined ? (
                <p className={`${styles['hint']} ${styles['stepSummary']}`}>{summary[k]}</p>
              ) : null}
            </li>
          )
        })}
      </ol>
      <RecoveryFooter />
    </section>
  )
}

/** Auto-reconnect's state, with "Reconnect now" / "Stop trying" / "Try again" (RC4's `nextAt`). */
function ReconnectLine({ status }: { status: RunStatus }): React.JSX.Element | null {
  const store = useRunStore()
  const rc = status.connection.reconnect
  const [now, setNow] = useState(() => Date.now())
  const waiting = rc?.phase === 'waiting' && rc.nextAt !== undefined
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [waiting])
  if (isConnected(status)) return null
  const a = store.getState()
  const r = m.reconnect
  if (rc?.phase === 'waiting' || rc?.phase === 'connecting') {
    const seconds = Math.max(0, Math.ceil(((rc.nextAt ?? now) - now) / 1000))
    return (
      <div className={styles['reconnectLine']}>
        <p className={styles['why']}>
          {rc.phase === 'waiting' ? r.waiting(rc.attempt, seconds) : r.connecting(rc.attempt)}
        </p>
        <div className={styles['buttons']}>
          <Button
            size="sm"
            disabled={rc.phase === 'connecting'}
            onClick={() => void a.recovery('reconnectNow')}
          >
            {r.now}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void a.reconnect('cancel')}>
            {r.stop}
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className={styles['reconnectLine']}>
      <p className={styles['why']}>{rc?.phase === 'gaveUp' ? r.gaveUp : r.closed}</p>
      {rc?.phase === 'gaveUp' ? <p className={styles['hint']}>{r.gaveUpHint}</p> : null}
      <div className={styles['buttons']}>
        <Button
          size="sm"
          icon={<Icon name="connect" />}
          onClick={() => void a.recovery('reconnectNow')}
        >
          {rc?.phase === 'gaveUp' ? r.again : r.connect}
        </Button>
      </div>
    </div>
  )
}

function SafeStep({
  status,
  done,
  onStopped,
  connect,
}: {
  status: RunStatus
  done: boolean
  onStopped: () => void
  /** RC6: "Connect to …" after a crash, in place of the reconnect line. */
  connect?: React.ReactNode
}): React.JSX.Element {
  if (isConnected(status))
    return (
      <p className={styles['why']}>{connect === undefined ? m.safe.reconnected : m.safe.reset}</p>
    )
  return (
    <>
      {/* the one safety line, while the machine may still be moving (run-machine.md M2) */}
      {done ? (
        <p className={styles['why']}>{m.safe.confirmed}</p>
      ) : (
        <div className={styles['notice']} data-tone="warning" role="note">
          <Icon name="warning" />
          <div>
            <p className={styles['why']}>
              {connect === undefined ? m.safe.moving : m.launch.moving}
            </p>
          </div>
        </div>
      )}
      {connect ?? <ReconnectLine status={status} />}
      {done ? null : (
        <div className={styles['buttons']}>
          <Button size="sm" onClick={onStopped}>
            {m.safe.stopped}
          </Button>
        </div>
      )}
    </>
  )
}

const CHECKS = ['bit', 'stock', 'chips'] as const

function CheckStep({
  ui,
  set,
}: {
  ui: RecoveryUi
  set: (patch: Partial<Omit<RecoveryUi, 'jobId'>>) => void
}): React.JSX.Element {
  return (
    <>
      <p className={styles['hint']}>{m.check.intro}</p>
      <div className={styles['checklist']}>
        {CHECKS.map((c) => (
          <Checkbox
            key={c}
            label={m.check.items[c]}
            checked={ui.ticks.includes(c)}
            onCheckedChange={(v) =>
              set({ ticks: v === true ? [...ui.ticks, c] : ui.ticks.filter((t) => t !== c) })
            }
          />
        ))}
      </div>
      <p className={styles['hint']}>{m.check.gantry}</p>
      <div className={styles['buttons']}>
        <Button size="sm" onClick={() => set({ checked: true, open: undefined })}>
          {m.check.done}
        </Button>
      </div>
    </>
  )
}

function HomeStep({
  status,
  interruption,
  connect,
}: {
  status: RunStatus
  interruption: Interruption
  /** RC6: "Connect to …" after a crash, in place of the reconnect line. */
  connect?: React.ReactNode
}): React.JSX.Element {
  const store = useRunStore()
  const pending = useRun((s) => s.pending)
  const [ask, setAsk] = useState(false)
  const a = store.getState()
  if (!isConnected(status)) return <>{connect ?? <ReconnectLine status={status} />}</>
  if (status.homed) return <p className={styles['why']}>{m.home.homed}</p>
  const gate = runGates(status, { planChosen: true }).home
  const lock = status.state.startsWith('Alarm') && status.alarm === undefined
  const serial = status.connection.target === 'serial'
  return (
    <>
      <p className={styles['why']}>
        {interruption.reason === 'machinePowerLost' ? m.home.whyPower : m.home.why}
      </p>
      {inAlarm(status) && !lock ? <AlarmPanel status={status} /> : null}
      <div className={styles['buttons']}>
        <Button
          variant="primary"
          icon={<Icon name="home" />}
          disabled={gate !== null || pending.includes('run.machine.home')}
          onClick={() => (serial ? setAsk(true) : void a.home())}
        >
          {m.home.button}
        </Button>
      </div>
      {gate === null ? null : <p className={styles['hint']}>{gate}</p>}
      <ConfirmDialog
        open={ask}
        onOpenChange={setAsk}
        destructive={false}
        title={runMessages.homeConfirm.title}
        description={runMessages.homeConfirm.description}
        confirmLabel={runMessages.homeConfirm.confirm}
        onConfirm={() => void a.home()}
      />
    </>
  )
}

function ZeroStep({
  doc,
  status,
  interruption: i,
  units,
  stockMoved,
  onOk,
}: {
  doc: ProjectDoc | undefined
  status: RunStatus
  interruption: Interruption
  units: UnitSystem
  stockMoved: boolean
  onOk: () => void
}): React.JSX.Element {
  const store = useRunStore()
  const [restore, setRestore] = useState(false)
  const [goTo, setGoTo] = useState<'last' | 'zero' | undefined>()
  const known = isConnected(status) && status.homed
  const run = i.workZero.last
  const same = sameZero(status.workZero, run)
  const unit = runMessages.dro.units[units]
  const gate = goToOpenGate(status)
  const last = i.lastReport
  return (
    <>
      {!known ? (
        <p className={styles['hint']}>{m.zero.unknown}</p>
      ) : same ? (
        <p className={styles['why']}>{m.zero.same(`${xyz(status.workZero, units)} ${unit}`)}</p>
      ) : (
        <div className={styles['notice']} data-tone="warning" role="note">
          <Icon name="warning" />
          <div>
            <p className={styles['why']}>
              {m.zero.differs(`${xyz(status.workZero, units)}`, `${xyz(run, units)} ${unit}`)}
            </p>
            <div className={styles['buttons']}>
              <Button size="sm" onClick={() => setRestore(true)}>
                {m.zero.restore}
              </Button>
            </div>
          </div>
        </div>
      )}
      {stockMoved ? <p className={styles['why']}>{m.zero.moved}</p> : null}
      {known && !same && i.launch?.machine.target === 'virtual' ? (
        <p className={styles['hint']}>{m.launch.virtualNote}</p>
      ) : null}
      <div className={styles['recoveryGoTo']}>
        {last === undefined ? null : (
          <div>
            <Button
              size="sm"
              icon={<Icon name="move-to" />}
              disabled={gate !== null}
              onClick={() => setGoTo('last')}
            >
              {m.zero.goLast}
            </Button>
            <p className={styles['hint']}>{m.zero.goLastHint}</p>
          </div>
        )}
        <div>
          <Button
            size="sm"
            icon={<Icon name="work-zero" />}
            disabled={gate !== null}
            onClick={() => setGoTo('zero')}
          >
            {m.zero.goZero}
          </Button>
          <p className={styles['hint']}>{m.zero.goZeroHint}</p>
        </div>
      </div>
      {gate === null || !known ? null : <p className={styles['hint']}>{gate}</p>}
      <p className={styles['hint']}>{m.zero.zNote}</p>
      <div className={styles['buttons']}>
        <Button size="sm" onClick={onOk}>
          {m.zero.next}
        </Button>
      </div>
      <ConfirmDialog
        open={restore}
        onOpenChange={setRestore}
        destructive={false}
        title={m.zero.restoreTitle}
        description={m.zero.restoreDescription(`${xyz(run, units)} ${unit}`)}
        confirmLabel={m.zero.restore}
        onConfirm={() => void store.getState().restoreWorkZero(run as unknown as Vec3)}
      />
      {goTo === undefined ? null : (
        <RecoveryGoTo
          doc={doc}
          what={goTo === 'last' ? m.zero.goLast : m.zero.goZero}
          // machine X/Y: the last seen position (homing re-referenced it), or the work zero
          xy={
            goTo === 'last' && last !== undefined
              ? [last.mpos[0], last.mpos[1]]
              : [status.workZero[0], status.workZero[1]]
          }
          units={units}
          onClose={() => setGoTo(undefined)}
        />
      )}
    </>
  )
}

/**
 * Go to a machine X/Y at the safe height above the stock, in GoTo's safe order (DF128,
 * core/run/goto.ts), confirmed here before anything moves.
 */
function RecoveryGoTo({
  doc,
  what,
  xy,
  units,
  onClose,
}: {
  doc: ProjectDoc | undefined
  what: string
  xy: readonly [number, number]
  units: UnitSystem
  onClose: () => void
}): React.JSX.Element {
  const store = useRunStore()
  const status = useRun((s) => s.status)
  const planId = useRun((s) => s.planId)
  const setupId = useRun((s) => s.setupId)
  const controls = useJogControls(doc)
  const machine = useMachineJog(doc)
  const feed = {
    xy: controls.feed,
    z: machine.maxZ === undefined ? controls.feed : Math.min(controls.feed, machine.maxZ),
  }
  const plan = planId === undefined ? undefined : doc?.plans[planId]
  const clearance = plan === undefined ? undefined : setupClearance(plan, setupId)
  const wco: Vec3 = [
    status.mpos[0] - status.wpos[0],
    status.mpos[1] - status.wpos[1],
    status.mpos[2] - status.wpos[2],
  ]
  const envelope = status.envelope
  const safeZ = goToSafeZ({ wcoZ: wco[2], zeroLevel: status.zeroLevel, clearance, envelope })
  const from: Vec3 = [status.mpos[0], status.mpos[1], status.mpos[2]]
  const planned = goToMoves({
    from,
    wco,
    target: [xy[0], xy[1], safeZ],
    frame: 'machine',
    mode: 'absolute',
    safeZ,
    liftToTop: false,
    envelope,
  })
  const steps = planned.isOk() ? planned.unwrap() : undefined
  const unit = runMessages.dro.units[units]
  const work = (v: number, k: number) => formatLength(v - (wco[k] ?? 0), units)
  const g = m.goTo
  const xyText = `X ${work(xy[0], 0)} Y ${work(xy[1], 1)} ${unit}`
  const safeText = `${formatLength(safeZ - wco[2], units)} ${unit}`
  return (
    <Dialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={g.title(what)}
      description={g.description(xyText, safeText)}
      footer={
        <>
          <DialogClose>
            <Button autoFocus>{runMessages.preflight.cancel}</Button>
          </DialogClose>
          <Button
            variant="primary"
            icon={<Icon name="move-to" />}
            disabled={steps === undefined || steps.length === 0}
            onClick={() => {
              const todo = steps ?? []
              onClose()
              void store
                .getState()
                .moveTo(todo.map((s) => ({ to: s.to, feed: s.axis === 'z' ? feed.z : feed.xy })))
            }}
          >
            {g.move}
          </Button>
        </>
      }
    >
      {planned.isErr() ? (
        <p className={styles['why']}>{planned.unwrapErr().message}</p>
      ) : steps === undefined || steps.length === 0 ? (
        <p className={styles['why']}>{g.already}</p>
      ) : (
        <>
          <ol className={styles['steps']}>
            {steps.map((s, k) => (
              <li key={k}>
                {s.axis === 'xy'
                  ? g.across(`X ${work(s.to[0], 0)} Y ${work(s.to[1], 1)} ${unit}`)
                  : s.to[2] >= (k === 0 ? from[2] : (steps[k - 1]?.to[2] ?? from[2]))
                    ? g.up(`${work(s.to[2], 2)} ${unit}`)
                    : g.down(`${work(s.to[2], 2)} ${unit}`)}
              </li>
            ))}
          </ol>
          <p className={styles['hint']}>{g.seconds(goToSeconds(from, steps, feed))}</p>
        </>
      )}
    </Dialog>
  )
}

function ChooseStep({
  doc,
  status,
  last,
  interruption: i,
}: {
  doc: ProjectDoc | undefined
  status: RunStatus
  last: LastRun
  interruption: Interruption
}): React.JSX.Element {
  const store = useRunStore()
  const file = useRun((s) => s.file)
  const pending = useRun((s) => s.pending)
  const a = store.getState()
  const plan = last.planId === undefined ? undefined : doc?.plans[last.planId]
  const located = useLocatedFile(last, i)
  // the program the run was from must be in this window to resume it (RC6: a located file with
  // the run's content too)
  const haveProgram =
    plan !== undefined ||
    (last.file !== undefined &&
      file?.state === 'ready' &&
      (file.path === last.file.path || located))
  const changed = plan !== undefined && resumeChanges(last, plan, last.setupId).changed
  const gate =
    runGates(status, { planChosen: true }).start ?? (haveProgram ? null : m.choose.noProgram)
  const disabled = gate !== null || pending.includes('run.job.start')
  const c = m.choose
  const s = i.suggestion
  const safest = i.safest
  const hash = i.programHash
  const options: {
    key: string
    title: string
    text: string
    onClick: () => void
    recommended?: boolean
  }[] = []
  // RC6: a file changed since the run resumes from the beginning only (Q170)
  const fileChanged =
    i.launch?.file === 'changed' && file?.state === 'ready' && file.path === last.file?.path
  if (fileChanged) {
    // nothing by line: the pre-flight would refuse it
  } else if (changed) {
    options.push({
      key: 'resume',
      title: runMessages.progress.resumeFrom,
      text: c.changed,
      onClick: () => a.openResume(),
      recommended: true,
    })
  } else {
    if (s !== undefined)
      options.push({
        key: 'near',
        title: c.near,
        text:
          i.executing <= s.line
            ? c.nearStart(s.line)
            : c.nearText(
                s.line,
                s.kind === 'operation' ? s.label : undefined,
                Math.max(s.line, i.executing),
              ),
        onClick: () => a.openRecoveryStart({ kind: 'point', line: s.line }, hash),
        recommended: true,
      })
    if (safest !== undefined && safest.line !== s?.line)
      options.push({
        key: 'operation',
        title: c.operation,
        text: c.operationText(safest.line, safest.label),
        onClick: () => a.openRecoveryStart({ kind: 'point', line: safest.line }, hash),
      })
    options.push({
      key: 'line',
      title: c.line,
      text: c.lineText,
      onClick: () => a.openRecoveryStart({ kind: 'line', line: s?.line }, hash),
    })
  }
  options.push({
    key: 'again',
    title: c.again,
    text: c.againText,
    onClick: () => a.openRecoveryStart({ kind: 'beginning' }, undefined),
  })
  return (
    <>
      <ul className={styles['optionCards']}>
        {options.map((o) => (
          <li key={o.key}>
            <button
              type="button"
              className={styles['optionCard']}
              data-recommended={o.recommended === true ? '' : undefined}
              disabled={disabled}
              onClick={o.onClick}
            >
              <span className={styles['optionTitle']}>
                {o.title}
                {o.recommended === true ? (
                  <span className={styles['optionChip']}>{c.recommended}</span>
                ) : null}
              </span>
              <span className={styles['optionText']}>{o.text}</span>
            </button>
          </li>
        ))}
      </ul>
      {fileChanged ? <p className={styles['hint']}>{c.fileChanged}</p> : null}
      {gate === null ? (
        <p className={styles['hint']}>{c.after}</p>
      ) : (
        <p className={styles['hint']}>{gate}</p>
      )}
    </>
  )
}

/**
 * RC6: whether the window's loaded gCode file is not at the run's path but has the run's content
 * (a file the user located after it moved): its program hashes as the run's.
 */
function useLocatedFile(last: LastRun, i: Interruption): boolean {
  const file = useRun((s) => s.file)
  const lines =
    file?.state === 'ready' && last.file !== undefined && file.path !== last.file.path
      ? file.prepared.lines
      : undefined
  const [hashed, setHashed] = useState<{ lines: readonly string[]; hash: string } | undefined>()
  useEffect(() => {
    if (lines === undefined) return
    let live = true
    void programHash(lines).then((hash) => {
      if (live) setHashed({ lines, hash })
    })
    return () => {
      live = false
    }
  }, [lines])
  return (
    lines !== undefined &&
    hashed?.lines === lines &&
    i.programHash !== undefined &&
    hashed.hash === i.programHash
  )
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

/**
 * RC6: where a run the last session left interrupted was from: the plan and setup with "Open
 * project" (or "Locate project…" when its file is gone), or the file with "Open file" (only while
 * its content is the run's, Q170; else "Locate file…"); and a note when the kept program copy
 * was not found (no suggestion then).
 */
function LaunchSource({
  doc,
  last,
  interruption: i,
  launch,
}: {
  doc: ProjectDoc | undefined
  last: LastRun
  interruption: Interruption
  launch: LaunchInfo
}): React.JSX.Element {
  const { files, bridge } = useShell()
  const store = useRunStore()
  const file = useRun((s) => s.file)
  const located = useLocatedFile(last, i)
  const l = m.launch
  const project = launch.project
  const projectPath = project?.path
  const planHere = last.planId !== undefined && doc?.plans[last.planId] !== undefined
  const runFile = last.file
  const fileHere =
    runFile !== undefined && file?.state === 'ready' && (file.path === runFile.path || located)
  return (
    <div className={styles['launchSource']}>
      <dl className={`${styles['facts']} ${styles['recoveryFacts']}`} aria-label={l.source}>
        <dt>{l.source}</dt>
        <dd>
          {launch.plan === undefined ? null : (
            <>
              {l.plan(
                launch.plan.planName,
                launch.plan.setup,
                launch.plan.setups,
                launch.plan.setupName,
              )}
              {projectPath === undefined ? null : (
                <>
                  <br />
                  <span className={styles['hint']} title={projectPath}>
                    {l.project(baseName(projectPath))}
                  </span>
                </>
              )}
            </>
          )}
          {runFile === undefined ? null : <span title={runFile.path}>{l.file(runFile.name)}</span>}
        </dd>
      </dl>
      {launch.plan !== undefined && !planHere ? (
        projectPath === undefined ? (
          <p className={styles['hint']}>{l.untitled}</p>
        ) : project?.missing === true ? (
          <>
            <p className={styles['why']}>{l.projectMissing}</p>
            <div className={styles['buttons']}>
              <Button
                size="sm"
                icon={<Icon name="open" />}
                onClick={() => void files.getState().open()}
              >
                {l.locateProject}
              </Button>
            </div>
          </>
        ) : (
          <div className={styles['buttons']}>
            <Button
              size="sm"
              variant="primary"
              icon={<Icon name="open" />}
              onClick={() => void files.getState().openFile(projectPath)}
            >
              {l.openProject}
            </Button>
          </div>
        )
      ) : null}
      {runFile !== undefined && !fileHere ? (
        launch.file === 'same' ? (
          <div className={styles['buttons']}>
            <Button
              size="sm"
              variant="primary"
              icon={<Icon name="open" />}
              onClick={() => void store.getState().loadFile(runFile.path)}
            >
              {l.openFile}
            </Button>
          </div>
        ) : (
          <>
            <p className={styles['why']}>
              {launch.file === 'changed' ? l.fileChanged : l.fileMissing}
            </p>
            <div className={styles['buttons']}>
              <Button
                size="sm"
                icon={<Icon name="open" />}
                onClick={() => void bridge.run.openFile()}
              >
                {l.locateFile}
              </Button>
            </div>
          </>
        )
      ) : null}
      {located ? <p className={styles['hint']}>{l.located}</p> : null}
      {launch.program || i.suggestion !== undefined ? null : (
        <p className={styles['hint']}>{l.notKept}</p>
      )}
    </div>
  )
}

/**
 * RC6: "Connect to /dev/cu.usbmodem1101" (the journal's port, or the port with its USB serial
 * number when the OS gave it another path) or "Connect to the virtual machine": the user's own
 * click, never automatic after a restart (Q158).
 */
function LaunchConnect({
  doc,
  last,
  launch,
}: {
  doc: ProjectDoc | undefined
  last: LastRun
  launch: LaunchInfo
}): React.JSX.Element {
  const store = useRunStore()
  const status = useRun((s) => s.status)
  const [missing, setMissing] = useState(false)
  const l = m.launch
  const port = launch.machine.port?.path
  const planId = last.planId !== undefined && doc?.plans[last.planId] ? last.planId : undefined
  return (
    <div className={styles['reconnectLine']}>
      <div className={styles['buttons']}>
        <Button
          size="sm"
          variant="primary"
          icon={<Icon name="connect" />}
          disabled={status.connection.state === 'connecting'}
          onClick={() =>
            void store
              .getState()
              .connectRecovery(launch.machine, planId)
              .then((ok) => setMissing(!ok))
          }
        >
          {launch.machine.target === 'serial' && port !== undefined
            ? l.connect(port)
            : l.connectVirtual}
        </Button>
      </div>
      {missing && port !== undefined ? (
        <p className={styles['why']} role="status">
          {l.portMissing(port)}
        </p>
      ) : null}
      <p className={styles['hint']}>{l.connectHint}</p>
    </div>
  )
}

/** "Dismiss…" (asked once, inline) and "Why does this happen?". */
function RecoveryFooter(): React.JSX.Element {
  const store = useRunStore()
  const [asking, setAsking] = useState(false)
  return (
    <div className={styles['recoveryFooter']}>
      <details className={styles['recoveryWhy']}>
        <summary>{m.why}</summary>
        <ul>
          {m.causes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </details>
      {asking ? (
        <div className={styles['notice']} role="group" aria-label={m.dismiss}>
          <Icon name="info" />
          <div>
            <p className={styles['why']}>{m.dismissAsk}</p>
            <div className={styles['buttons']}>
              <Button size="sm" onClick={() => void store.getState().recovery('dismiss')}>
                {m.dismissConfirm}
              </Button>
              <Button size="sm" variant="ghost" autoFocus onClick={() => setAsking(false)}>
                {m.keep}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className={styles['buttons']}>
          <Button size="sm" variant="ghost" onClick={() => setAsking(true)}>
            {m.dismiss}
          </Button>
        </div>
      )}
    </div>
  )
}
