// The gCode export's outcome (task 3.7): after the native "Export gCode" dialog and `plan.export`,
// a dialog with the setup (v0.2 F6, plans with several setups), the file, lines, estimated time,
// tool changes, whether soft limits and the Z headroom (DF68) were checked and the export's
// machine warnings – or the error. Doc: docs/conventions/ui.md#plan-mode-task-37,
// docs/architecture/grbl.md#plan-export-command
import type { PlanWarning } from '../../../../core/plan/checks'
import { planMessages, sentence, zHeadroomNote } from '../../messages/plan'
import { useShell } from '../../shell/ShellContext'
import { IS_MAC } from '../../shell/shortcuts'
import { Button, Dialog, DialogClose, ErrorMessage, Icon, WarningList } from '../../ui'
import { planWarningLabels } from './PlanInspector'
import { usePlanState, usePlanStore } from './plan-store'
import styles from './Plan.module.css'

const m = planMessages.export

export function ExportDialog(): React.JSX.Element | null {
  const store = usePlanStore()
  const { bridge } = useShell()
  const exported = usePlanState((s) => s.exported)
  if (exported === undefined) return null
  const close = (
    <DialogClose>
      <Button>{m.close}</Button>
    </DialogClose>
  )
  const onOpenChange = (open: boolean) => {
    if (!open) store.getState().closeExport()
  }
  if (!exported.ok)
    return (
      <Dialog open onOpenChange={onOpenChange} title={m.failedTitle} footer={close}>
        <ErrorMessage error={exported.error} />
      </Dialog>
    )
  const r = exported.result
  // the file name in the description, its folder on one line (DF48: the full path wrapped)
  const cut = Math.max(r.filePath.lastIndexOf('/'), r.filePath.lastIndexOf('\\'))
  const name = cut < 0 ? r.filePath : r.filePath.slice(cut + 1)
  const folder = cut < 0 ? undefined : r.filePath.slice(0, cut)
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={m.doneTitle}
      description={m.doneDescription(name)}
      footer={
        <>
          <Button
            icon={<Icon name="open" />}
            onClick={() => void bridge.files.showInFolder(r.filePath)}
          >
            {m.showInFolder(IS_MAC)}
          </Button>
          {close}
        </>
      }
    >
      {folder !== undefined ? (
        <p className={styles['exportFolder']} title={r.filePath}>
          {m.folder(folder)}
        </p>
      ) : null}
      <ul className={styles['stats']}>
        {exported.setup !== undefined ? <li>{exported.setup}</li> : null}
        <li>{m.lines(r.lines)}</li>
        <li>{m.time(r.stats.estimatedSeconds)}</li>
        <li>{m.toolChanges(r.stats.toolChanges)}</li>
        {r.regenerated.length > 0 ? <li>{m.regenerated(r.regenerated.length)}</li> : null}
        <li>{r.softLimitChecked ? m.softLimitChecked : m.softLimitNotChecked}</li>
        <li>{zHeadroomLine(r.warnings)}</li>
        {r.linksNote !== undefined ? <li>{m.linksNote}</li> : null}
      </ul>
      <section aria-label={m.warnings}>
        <WarningList
          labels={{ ...planWarningLabels, list: m.warnings }}
          items={r.warnings.filter(notZNote).map((w, i) => ({
            id: `${w.code}:${w.rule}:${i}`,
            tier: w.severity === 'info' ? 'soft' : 'hard',
            text: sentence(w.message),
          }))}
          empty={m.noWarnings}
        />
      </section>
    </Dialog>
  )
}

/** DF68: the `zHeadroomUnknown` note is the Z headroom line, not a warning of the list. */
const notZNote = (w: PlanWarning) => !(w.code === 'plan.machine' && w.rule === 'zHeadroomUnknown')

/** DF68: whether the export checked the Z headroom, and what to enter when it did not. */
function zHeadroomLine(warnings: readonly PlanWarning[]): string {
  const note = zHeadroomNote(warnings)
  if (note === undefined) return m.zHeadroomChecked
  return note.partly ? m.zHeadroomPartly(note.missing) : m.zHeadroomNotChecked(note.missing)
}
