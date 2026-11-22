// The Library window's item editor: every field of the selected item's kind (ToolFields /
// MachineFields / StockFields, `full`), validated as typed by the core models (L3), the draft's
// "Unsaved" state, a conflict note with Reload / Overwrite, and the actions Duplicate, Remove…,
// Revert and Save. Doc: docs/conventions/ui-library-window.md#layout, #behaviour-with-projects
import { Copy, RotateCcw, Save, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import type { LibraryItemKind } from '../../../core/library/item'
import { libraryMessages } from '../messages/library'
import { sentence } from '../messages/plan'
import { Button, ConfirmDialog, ErrorMessage, StatusChip } from '../ui'
import { useStore } from 'zustand'
import {
  draftIssues,
  unmatchedIssues,
  type MachineDraft,
  type StockDraft,
  type ToolDraft,
} from './form'
import { issueMessages } from './LibraryForm'
import type { LibraryStore } from './library-store'
import { MACHINE_FIELDS, MachineFields } from './MachineFields'
import { STOCK_FIELDS, StockFields } from './StockFields'
import { TOOL_FIELDS, ToolFields } from './ToolFields'
import styles from './LibraryWindow.module.css'

const w = libraryMessages.window
const FIELDS: Record<LibraryItemKind, readonly string[]> = {
  tool: TOOL_FIELDS,
  machine: MACHINE_FIELDS,
  stock: STOCK_FIELDS,
}

export function ItemEditor({
  store,
  used,
  projectName,
}: {
  store: LibraryStore
  used: ReadonlySet<string>
  projectName: string | undefined
}): React.JSX.Element {
  const s = useStore(store)
  const ref = useRef<HTMLDivElement>(null)
  const d = s.draft
  const units = s.units()
  const dirty = s.isDirty()
  const live = useMemo(() => (d === null ? [] : draftIssues(d.values, d.autoName)), [d])
  // the last failed command's issues while the draft is unchanged, else the live ones
  const issues = s.error !== undefined && s.error.issues.length > 0 ? s.error.issues : live
  const messages = (field: string) => issueMessages(issues, field)

  useEffect(() => {
    if (s.failures === 0) return
    ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [s.failures])

  if (d === null)
    return (
      <div className={styles['noSelection']}>
        <p>{w.noSelection}</p>
      </div>
    )

  const name = s.draftName()
  const rest = s.error === undefined ? [] : unmatchedIssues(s.error.issues, FIELDS[d.kind])
  const showError = s.error !== undefined && (s.error.issues.length === 0 || rest.length > 0)
  const form = {
    units,
    messages,
    variant: 'full' as const,
  }

  return (
    <div className={styles['editor']} ref={ref}>
      <div className={styles['editorHead']}>
        <h2 className={styles['editorTitle']}>{name}</h2>
        {dirty ? <StatusChip tone="warning">{w.unsaved}</StatusChip> : null}
        {d.id !== null && used.has(d.id) ? (
          <span title={projectName === undefined ? undefined : w.usedHint(projectName)}>
            <StatusChip tone="neutral">{w.used}</StatusChip>
          </span>
        ) : null}
      </div>
      {s.conflict !== null ? (
        <div role="alert" className={styles['conflict']}>
          <p>{s.conflict === 'stale' ? w.conflictStale : w.conflictRemoved}</p>
          <div className={styles['conflictActions']}>
            {s.conflict === 'stale' ? (
              <Button size="sm" onClick={() => void s.reload()}>
                {w.reload}
              </Button>
            ) : (
              <Button size="sm" onClick={() => s.revert()}>
                {w.discard}
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              icon={<Save aria-hidden="true" />}
              onClick={() => void s.overwrite()}
            >
              {w.overwrite}
            </Button>
          </div>
        </div>
      ) : null}
      {showError ? (
        <ErrorMessage
          error={{ ...s.error!, issues: rest }}
          message={
            rest.length > 0
              ? `${libraryMessages.saveFailed} ${rest.map((i) => sentence(i.message)).join(' ')}`
              : libraryMessages.saveFailed
          }
        />
      ) : null}
      <div className={styles['fieldsScroll']}>
        <div className={styles['formBody']}>
          {d.values.kind === 'tool' ? (
            <ToolFields
              {...form}
              values={d.values}
              onChange={(v: ToolDraft) => s.edit(v)}
              autoName={d.autoName}
              onNameTyped={() => s.edit(d.values, { nameTyped: true })}
            />
          ) : d.values.kind === 'machine' ? (
            <MachineFields {...form} values={d.values} onChange={(v: MachineDraft) => s.edit(v)} />
          ) : (
            <StockFields {...form} values={d.values} onChange={(v: StockDraft) => s.edit(v)} />
          )}
        </div>
      </div>
      <div role="group" className={styles['editorActions']} aria-label={w.actions}>
        <Button
          size="sm"
          variant="ghost"
          icon={<Copy aria-hidden="true" />}
          disabled={d.id === null}
          onClick={() => s.duplicate()}
        >
          {w.duplicate}
        </Button>
        <ConfirmDialog
          title={w.removeTitle(name)}
          description={w.removeDescription}
          confirmLabel={w.removeConfirm(d.kind)}
          destructive
          open={s.removing}
          onOpenChange={(o) => s.setRemoving(o)}
          onConfirm={() => void s.remove()}
          trigger={
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 aria-hidden="true" />}
              disabled={d.id === null}
            >
              {w.remove}
            </Button>
          }
        />
        <span className={styles['spacer']} />
        <Button
          size="sm"
          icon={<RotateCcw aria-hidden="true" />}
          disabled={!dirty || s.saving}
          onClick={() => s.revert()}
        >
          {w.revert}
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Save aria-hidden="true" />}
          disabled={!dirty || s.saving}
          onClick={() => void s.save()}
        >
          {w.save}
        </Button>
      </div>
    </div>
  )
}
