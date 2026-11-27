// Run an external gCode file (hardening DF93): the inspector's file section ("Run gCode file…",
// the recent files, the loaded file's card with its tool changes, extent, warnings and refusals)
// and the file's pre-flight dialog. The run is `run.job.start { file }` (run-store `startRun`).
// Doc: docs/modes/run.md#run-an-external-g-code-file-df93, docs/conventions/ui.md#run-mode-safety-ui
import { useEffect, useId, useRef } from 'react'
import type { UnitSystem } from '../../../../core/project/document'
import type { FileIssue, PreparedGcodeFile } from '../../../../core/run/gcode-file'
import { runMessages } from '../../messages/run'
import { Button, Dialog, DialogClose, ErrorMessage, Icon } from '../../ui'
import { formatLength, runGates } from './machine-state'
import { useRun, useRunStore, useRunUnits, type RunFileView } from './run-store'
import { SoftLimitResult } from './RunDialogs'
import { RunDialogFooter } from './RunStop'
import { StartAtSection, usePreflightStart } from './StartAt'
import styles from './Run.module.css'

const m = runMessages.file
/** Issues listed per kind before "and n more". */
const SHOWN_ISSUES = 5

/** The inspector's file section: the open button and recent files, or the loaded file's card. */
export function RunFileSection({ idle }: { idle: boolean }): React.JSX.Element {
  const store = useRunStore()
  const file = useRun((s) => s.file)
  const recent = useRun((s) => s.recentFiles)
  const a = store.getState()
  useEffect(() => {
    void store.getState().refreshRecentFiles()
  }, [store])
  return (
    <div className={styles['fileSection']}>
      {file === undefined ? null : <FileCard file={file} idle={idle} />}
      {file === undefined && idle ? (
        <>
          <Button icon={<Icon name="open" />} onClick={() => void a.openFile()}>
            {m.open}
          </Button>
          <p className={styles['hint']}>{m.openHint}</p>
          {recent.length === 0 ? null : (
            <nav aria-label={m.recent}>
              <h4 className={styles['sectionTitle']}>{m.recent}</h4>
              <ul className={styles['recentFiles']}>
                {recent.map((path) => (
                  <li key={path}>
                    <Button
                      size="sm"
                      variant="ghost"
                      title={path}
                      onClick={() => void a.openFile(path)}
                    >
                      {path.split(/[\\/]/).pop()}
                    </Button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </>
      ) : null}
    </div>
  )
}

function FileCard({ file, idle }: { file: RunFileView; idle: boolean }): React.JSX.Element {
  const store = useRunStore()
  const units = useRunUnits(undefined)
  const a = store.getState()
  return (
    <div className={styles['fileCard']} data-state={file.state}>
      <p className={styles['runOf']} title={file.path}>
        {m.runOf(file.name)}
      </p>
      {file.state === 'loading' ? <p className={styles['hint']}>{m.loading(file.name)}</p> : null}
      {file.state === 'failed' ? (
        <div className={styles['notice']} data-tone="danger" role="alert">
          <Icon name="warning" />
          <div>
            <p className={styles['why']}>{m.failed(file.name)}</p>
            <ErrorMessage error={file.error} />
          </div>
        </div>
      ) : null}
      {file.state === 'ready' ? <FileFacts prepared={file.prepared} units={units} /> : null}
      {idle ? (
        <Button
          size="sm"
          variant="ghost"
          icon={<Icon name="close" />}
          onClick={() => a.closeFile()}
        >
          {m.close}
        </Button>
      ) : null}
    </div>
  )
}

/** Lines, units, tool changes, extent, warnings and refusals of a prepared file. */
export function FileFacts({
  prepared,
  units,
}: {
  prepared: PreparedGcodeFile
  units: UnitSystem
}): React.JSX.Element {
  const unit = runMessages.dro.units[units]
  return (
    <>
      <dl className={styles['facts']}>
        <dt>{m.lines}</dt>
        <dd className={styles['mono']}>{prepared.lines.length.toLocaleString('en-GB')}</dd>
        <dt>{m.units}</dt>
        <dd>{m.unitNames[prepared.units ?? 'unknown']}</dd>
        <dt>{m.toolChanges}</dt>
        <dd>
          {prepared.toolChanges.length === 0 ? (
            m.noToolChanges
          ) : (
            <ol className={styles['tools']}>
              {prepared.toolChanges.map((t) => (
                <li key={t.line}>{m.toolChange(t.n, t.name)}</li>
              ))}
            </ol>
          )}
        </dd>
        <dt>{m.extent}</dt>
        <dd className={styles['mono']}>
          {prepared.extent.map((e, i) =>
            e === undefined ? null : (
              <div key={i}>
                {m.extentAxis(
                  'XYZ'[i] ?? '',
                  formatLength(e.min, units),
                  formatLength(e.max, units),
                  unit,
                )}
              </div>
            ),
          )}
        </dd>
      </dl>
      {prepared.refusalCount > 0 ? (
        <div className={styles['notice']} data-tone="danger" role="alert">
          <Icon name="warning" />
          <div>
            <p className={styles['why']}>{m.refusals(prepared.refusalCount)}</p>
            <IssueList issues={prepared.refusals} total={prepared.refusalCount} />
            <p className={styles['why']}>{m.refusalsFix}</p>
          </div>
        </div>
      ) : null}
      {prepared.warnings.length > 0 ? (
        <div className={styles['notice']} data-tone="warning" role="note">
          <Icon name="info" />
          <div>
            <p className={styles['why']}>{m.warnings}</p>
            <IssueList issues={prepared.warnings} total={prepared.warnings.length} />
          </div>
        </div>
      ) : null}
    </>
  )
}

function IssueList({
  issues,
  total,
}: {
  issues: readonly FileIssue[]
  total: number
}): React.JSX.Element {
  const shown = issues.slice(0, SHOWN_ISSUES)
  return (
    <ul className={styles['findings']}>
      {shown.map((i) => (
        <li key={`${i.line}-${i.rule}`}>{m.issue(i.line, i.message)}</li>
      ))}
      {total > shown.length ? <li>{m.more(total - shown.length)}</li> : null}
    </ul>
  )
}

/** The pre-flight of a file run: the file, target, work zero and the soft-limit check. */
export function FilePreflightDialog({
  file,
}: {
  file: Extract<RunFileView, { state: 'ready' }>
}): React.JSX.Element {
  const store = useRunStore()
  const open = useRun((s) => s.preflightOpen)
  const status = useRun((s) => s.status)
  const settingsCheck = useRun((s) => s.settingsCheck)
  const units = useRunUnits(undefined)
  const whyId = useId()
  const p = runMessages.preflight
  const serial = status.connection.target === 'serial'
  const realGate =
    serial && settingsCheck !== undefined && !settingsCheck.matches ? p.fileSettingsMismatch : null
  const refused = file.prepared.refusalCount > 0 ? m.refusals(file.prepared.refusalCount) : null
  const machineGate = runGates(status, { planChosen: true }).start ?? realGate ?? refused
  const checkKey = `file|${file.path}|${status.workZero.join(',')}`
  const canCheck = open && machineGate === null
  // DF129 RC3 (Q170): a file may start at a line too
  const start = usePreflightStart(checkKey, undefined, canCheck)
  const { current } = start
  const passed = current?.state === 'done' && current.findings.length === 0
  const gate =
    machineGate ??
    (current?.state === 'done' && current.findings.length > 0 ? p.softLimitsFix : null)
  const startable = gate === null && passed && start.ready
  const startRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const active = document.activeElement
    if (startable && (active === cancelRef.current || active === document.body))
      startRef.current?.focus()
  }, [startable])
  const a = store.getState()
  const timeScale = status.connection.timeScale
  return (
    <Dialog
      open={open}
      onOpenChange={a.setPreflightOpen}
      title={p.title}
      description={p.description}
      footer={
        <RunDialogFooter>
          <DialogClose>
            <Button ref={cancelRef} {...(startable ? {} : { autoFocus: true })}>
              {p.cancel}
            </Button>
          </DialogClose>
          <Button
            ref={startRef}
            variant="primary"
            icon={<Icon name="run" />}
            disabled={!startable}
            {...(startable
              ? { autoFocus: true }
              : gate === null
                ? {}
                : { 'aria-describedby': whyId })}
            onClick={() => void a.startRun(undefined, undefined, start.at)}
          >
            {start.at !== undefined
              ? serial
                ? runMessages.startAt.startMachineAtLine(start.at.fromLine)
                : runMessages.startAt.startAtLine(start.at.fromLine)
              : serial
                ? p.startMachine
                : p.start}
          </Button>
        </RunDialogFooter>
      }
    >
      <StartAtSection current={current} units={units} />
      {serial ? (
        <div className={styles['notice']} role="note">
          <Icon name="info" />
          <div>
            <p className={styles['why']}>{p.airCut}</p>
          </div>
        </div>
      ) : null}
      <dl className={styles['facts']}>
        <dt>{p.file}</dt>
        <dd title={file.path}>{file.name}</dd>
        <dt>{p.target}</dt>
        <dd>
          {serial && status.connection.port !== undefined
            ? p.serialTarget(status.connection.port.path, status.connection.port.baud)
            : p.virtualTarget(runMessages.timeScale(timeScale))}
        </dd>
        <dt>{p.workZero}</dt>
        <dd className={styles['mono']}>
          {status.workZero.map((v) => formatLength(v, units)).join(' · ')}{' '}
          {runMessages.dro.units[units]}
        </dd>
        <dt>{p.softLimits}</dt>
        <dd aria-live="polite">
          <SoftLimitResult check={current} units={units} />
        </dd>
      </dl>
      <FileFacts prepared={file.prepared} units={units} />
      {gate === null ? null : (
        <p id={whyId} className={styles['why']}>
          {gate}
        </p>
      )}
    </Dialog>
  )
}
