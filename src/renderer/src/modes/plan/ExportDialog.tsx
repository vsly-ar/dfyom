// The gCode export's outcome (task 3.7): after the native "Export gCode" dialog and `plan.export`,
// a dialog with the file, lines, estimated time, tool changes, whether soft limits were checked
// and the export's machine warnings – or the error. Doc: docs/conventions/ui.md#plan-mode-task-37,
// docs/architecture/grbl.md#plan-export-command
import { planMessages, sentence } from '../../messages/plan'
import { Button, Dialog, DialogClose, ErrorMessage, WarningList } from '../../ui'
import { planWarningLabels } from './PlanInspector'
import { usePlanState, usePlanStore } from './plan-store'
import styles from './Plan.module.css'

const m = planMessages.export

export function ExportDialog(): React.JSX.Element | null {
  const store = usePlanStore()
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
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={m.doneTitle}
      description={m.doneDescription(r.filePath)}
      footer={close}
    >
      <ul className={styles['stats']}>
        <li>{m.lines(r.lines)}</li>
        <li>{m.time(r.stats.estimatedSeconds)}</li>
        <li>{m.toolChanges(r.stats.toolChanges)}</li>
        {r.regenerated.length > 0 ? <li>{m.regenerated(r.regenerated.length)}</li> : null}
        <li>{r.softLimitChecked ? m.softLimitChecked : m.softLimitNotChecked}</li>
      </ul>
      <section aria-label={m.warnings}>
        <WarningList
          labels={{ ...planWarningLabels, list: m.warnings }}
          items={r.warnings.map((w, i) => ({
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
