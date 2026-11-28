// The Run inspector's "Machine settings" (v0.5 RV2, Q218/Q219): a collapsed group with the library
// machine's fields Run uses (the Library form, variant `run`), edited as a draft with Save / Revert
// (one `library.machine.update`; library edits are not undoable, Revert is the undo of an unsaved
// edit), and, while connected, the controller's `$$` read-only with names, units, the machine
// field each maps to and a `$n=value` line to copy where the machine differs. DFYOM never writes
// `$` settings. Doc: docs/conventions/ui.md#run-settings-v05-rv2
import { useEffect, useMemo, useState } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import type { HomingCorner, MachineValuesDTO } from '../../../../core/library/machine.dto'
import { itemUnitSystem } from '../../../../core/library/values-input'
import {
  controllerSettingsTable,
  type ControllerSettingRow,
} from '../../../../core/run/grbl/settings-catalog'
import type { AppErrorData, Issue } from '../../../../shared/errors/app-error'
import { MachineFields } from '../../library/MachineFields'
import { issueMessages } from '../../library/LibraryForm'
import { commandInput, draftIssues, itemValues, type MachineDraft } from '../../library/form'
import type { LibraryItemDTO } from '../../../../core/library/library-item'
import { libraryMessages } from '../../messages/library'
import { runMessages } from '../../messages/run'
import { useShell } from '../../shell/ShellContext'
import { Button, ErrorMessage, Icon, InspectorGroup, StatusChip } from '../../ui'
import { useLibraryItems } from '../plan/usePlan'
import { useMachineJog } from './JogPad'
import { isConnected } from './machine-state'
import { NO_PLAN, useRun, useRunUnits } from './run-store'
import styles from './Run.module.css'

const m = runMessages.machineSettings
const corners = libraryMessages.machine.homingCorners

export function MachineSettingsGroup({ doc }: { doc: ProjectDoc | undefined }): React.JSX.Element {
  const { bridge } = useShell()
  const key = useMachineJog(doc).key
  // read again after a save (the window's library broadcast may come later)
  const [saves, setSaves] = useState(0)
  const machines = useLibraryItems('machine', saves)
  const item = machines?.find((x) => x.id === key) as LibraryItemDTO | undefined
  const planId = useRun((s) => s.planId)
  const status = useRun((s) => s.status)
  const fallbackUnits = useRunUnits(doc)
  const [draft, setDraft] = useState<{ id: string; values: MachineDraft } | undefined>(undefined)
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const settings = useControllerSettings()

  const stored = useMemo(
    () => (item === undefined ? undefined : (itemValues(item) as MachineDraft)),
    [item],
  )
  // a draft belongs to its machine: another machine chosen drops it
  const values = draft !== undefined && draft.id === item?.id ? draft.values : stored
  const dirty = draft !== undefined && draft.id === item?.id
  const units = item === undefined ? fallbackUnits : itemUnitSystem(item, fallbackUnits)
  const live = useMemo<Issue[]>(() => (dirty && values ? draftIssues(values) : []), [dirty, values])
  const issues = error !== undefined && error.issues.length > 0 ? error.issues : live
  const rows = useMemo(
    () =>
      settings === undefined
        ? undefined
        : controllerSettingsTable(settings, stored as MachineValuesDTO | undefined),
    [settings, stored],
  )

  const save = async () => {
    if (item === undefined || values === undefined) return
    if (draftIssues(values).length > 0) return
    const input = commandInput(values, { units, base: item })
    setSaving(true)
    const r = await bridge.call('library.machine.update', {
      ...input,
      id: item.id,
      revision: item.revision,
    })
    setSaving(false)
    if (r.ok) {
      setSaves((n) => n + 1)
      setDraft(undefined)
      setError(undefined)
      setConflict(false)
    } else if (r.error.code === 'command.conflict') setConflict(true)
    else setError(r.error)
  }
  const revert = () => {
    setDraft(undefined)
    setError(undefined)
    setConflict(false)
  }

  return (
    <InspectorGroup
      title={m.title}
      collapsible
      defaultOpen={false}
      rememberKey="run.machineSettings"
      meta={dirty ? <StatusChip tone="warning">{m.unsaved}</StatusChip> : undefined}
    >
      {item === undefined || values === undefined ? (
        <p className={styles['hint']}>{m.noMachine}</p>
      ) : (
        <>
          <p className={styles['hint']}>{m.of(item.name)}</p>
          {planId !== undefined && planId !== NO_PLAN ? (
            <p className={styles['hint']}>{m.planCopy}</p>
          ) : null}
          <MachineFields
            variant="run"
            values={values}
            units={units}
            messages={(field) => issueMessages(issues, field)}
            onChange={(next) => {
              setDraft({ id: item.id, values: next })
              setError(undefined)
            }}
          />
          {conflict ? (
            <div className={styles['notice']} role="alert">
              <p className={styles['why']}>{m.conflict}</p>
              <Button size="sm" onClick={revert}>
                {m.reload}
              </Button>
            </div>
          ) : null}
          {error !== undefined && error.issues.length === 0 ? <ErrorMessage error={error} /> : null}
          <div className={styles['buttons']}>
            <Button size="sm" disabled={!dirty || saving} onClick={revert}>
              {m.revert}
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Icon name="save" />}
              disabled={!dirty || saving || live.length > 0}
              onClick={() => void save()}
            >
              {m.save}
            </Button>
          </div>
        </>
      )}
      {isConnected(status) && rows !== undefined ? <ControllerSettings rows={rows} /> : null}
    </InspectorGroup>
  )
}

/** The open connection's `$$` (`run.settings.check {}`), read once per connection. */
function useControllerSettings(): Readonly<Record<string, number>> | undefined {
  const { bridge } = useShell()
  const open = useRun((s) => s.status.connection.state === 'open')
  const [settings, setSettings] = useState<Readonly<Record<string, number>> | undefined>(undefined)
  useEffect(() => {
    if (!open) return
    let live = true
    void bridge.call('run.settings.check', {}).then((r) => {
      if (live && r.ok) setSettings((r.value as { settings?: Record<string, number> }).settings)
    })
    return () => {
      live = false
      setSettings(undefined)
    }
  }, [bridge, open])
  return open ? settings : undefined
}

function ControllerSettings({ rows }: { rows: readonly ControllerSettingRow[] }) {
  const [announce, setAnnounce] = useState('')
  const copy = (line: string) =>
    void (navigator.clipboard?.writeText(line) ?? Promise.reject(new Error('no clipboard')))
      .then(() => setAnnounce(m.copied(line)))
      .catch(() => setAnnounce(m.copyFailed))
  return (
    <section className={styles['controllerSettings']} aria-label={m.controller}>
      <h4 className={styles['controllerTitle']}>{m.controller}</h4>
      <p className={styles['hint']}>{m.controllerHint}</p>
      <table className={styles['settingsTable']} aria-label={m.controller}>
        <thead>
          <tr>
            <th scope="col">{m.columns.setting}</th>
            <th scope="col">{m.columns.controller}</th>
            <th scope="col">{m.columns.machine}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.n} data-differs={r.differs ? '' : undefined}>
              <th scope="row">
                <span className={styles['mono']}>{r.setting}</span>{' '}
                {r.name === undefined ? null : (
                  <span className={styles['settingName']}>{r.name}</span>
                )}
              </th>
              <td className={styles['mono']}>
                {r.controller}
                {r.unit === undefined || r.unit === 'mask' || r.unit === 'boolean'
                  ? ''
                  : ` ${r.unit}`}
              </td>
              <td>
                {r.field === 'homingCorner' && r.machine !== undefined
                  ? (corners[r.machine as HomingCorner] ?? r.machine)
                  : (r.machine ?? '—')}
                {r.differs ? <span className={styles['srOnly']}> ({m.differs})</span> : null}
                {r.copy === undefined ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={m.copy(r.copy)}
                    onClick={() => copy(r.copy!)}
                  >
                    <span className={styles['mono']}>{r.copy}</span>
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p role="status" className={styles['srOnly']}>
        {announce}
      </p>
    </section>
  )
}
