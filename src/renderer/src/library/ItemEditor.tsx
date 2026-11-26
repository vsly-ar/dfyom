// The Library window's item editor: every field of the selected item's kind (ToolFields /
// MachineFields / StockFields, `full`), validated as typed by the core models (L3), the draft's
// "Unsaved" state, a variant's parent (DF13), a conflict note with Reload / Overwrite, and the
// actions Duplicate, New variant (stock), Remove…,
// Import $$… (machines), Revert and Save. Doc: docs/conventions/ui-library-window.md#layout, #behaviour-with-projects
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryTabKind } from '../../../core/library/item'
import { libraryMessages } from '../messages/library'
import { sentence } from '../messages/plan'
import {
  Icon,
  Button,
  ConfirmDialog,
  ErrorMessage,
  StatusChip,
  revealInInspector,
  type FieldMessage,
} from '../ui'
import { useStore } from 'zustand'
import {
  draftIssues,
  nameTaken,
  unmatchedIssues,
  type MachineDraft,
  type StockDraft,
  type ToolDraft,
} from './form'
import { GrblImportDialog } from './GrblImportDialog'
import { issueMessages } from './LibraryForm'
import type { LibraryStore } from './library-store'
import { MACHINE_FIELDS, MachineFields } from './MachineFields'
import { STOCK_FIELDS, StockFields } from './StockFields'
import { TOOL_FIELDS, ToolFields } from './ToolFields'
import styles from './LibraryWindow.module.css'

const w = libraryMessages.window
const FIELDS: Record<LibraryTabKind, readonly string[]> = {
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
  const [scrolled, setScrolled] = useState(false)
  const d = s.draft
  const units = s.units()
  const dirty = s.isDirty()
  const live = useMemo(() => (d === null ? [] : draftIssues(d.values, d.autoName)), [d])
  // the last failed command's issues while the draft is unchanged, else the live ones
  const issues = s.error !== undefined && s.error.issues.length > 0 ? s.error.issues : live
  const taken = s.otherNames()
  // a name that repeats another item's is allowed, with a soft warning (DF47)
  const typedName = d === null || d.autoName ? '' : d.values.name
  const duplicate: FieldMessage[] =
    d !== null && nameTaken(typedName, taken)
      ? [
          {
            id: 'nameTaken',
            severity: 'soft',
            text: libraryMessages.nameTaken(d.kind, typedName.trim()),
          },
        ]
      : []
  const messages = (field: string) =>
    field === 'name'
      ? [...issueMessages(issues, field), ...duplicate]
      : issueMessages(issues, field)

  useEffect(() => {
    if (s.failures === 0) return
    // a field in another machine tab or a closed accordion is shown first (DF110)
    const invalid = ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
    if (invalid === null || invalid === undefined) return
    revealInInspector(invalid)
    invalid.focus()
    // from an effect the reveal's tab switch commits a frame later (as revealPlanField): again then
    if (document.activeElement !== invalid) requestAnimationFrame(() => invalid.focus())
  }, [s.failures])

  if (d === null) {
    // an empty list already says how to create the first item; the editor adds nothing
    const listing = s.lists[s.tab]
    const any = listing.items.length > 0 || listing.errors.length > 0
    return <div className={styles['noSelection']}>{any ? <p>{w.noSelection}</p> : null}</div>
  }

  const name = s.draftName()
  // stock variants (DF13): the parent's name, and the variants that block removing a parent
  const parent =
    d.parentId === undefined ? undefined : s.lists.stock.items.find((i) => i.id === d.parentId)
  const hasVariants =
    d.kind === 'stock' && d.id !== null && s.lists.stock.items.some((i) => i.parentId === d.id)
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
      {parent !== undefined ? (
        <p className={styles['variantOf']}>
          <button
            type="button"
            className={styles['variantLink']}
            onClick={() => s.select('stock', parent.id)}
          >
            {w.variantOf(parent.name)}
          </button>
        </p>
      ) : null}
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
              icon={<Icon name="save" />}
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
      <div
        className={styles['fieldsScroll']}
        data-scrolled={scrolled || undefined}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        <div className={styles['formBody']}>
          {d.values.kind === 'tool' ? (
            <ToolFields
              {...form}
              values={d.values}
              onChange={(v: ToolDraft) => s.edit(v)}
              autoName={d.autoName}
              takenNames={taken}
              onNameTyped={() => s.edit(d.values, { nameTyped: true })}
              detailsOpen={s.toolDetailsOpen}
              onDetailsOpenChange={(open) => s.setToolDetailsOpen(open)}
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
          icon={<Icon name="copy" />}
          disabled={d.id === null}
          onClick={() => s.duplicate()}
        >
          {w.duplicate}
        </Button>
        {d.kind === 'stock' ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon name="add" />}
            disabled={d.id === null}
            onClick={() => s.newVariant()}
          >
            {w.newVariant}
          </Button>
        ) : null}
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
              icon={<Icon name="delete" />}
              disabled={d.id === null || hasVariants}
              title={hasVariants ? w.hasVariants : undefined}
            >
              {w.remove}
            </Button>
          }
        />
        {d.kind === 'machine' ? (
          <GrblImportDialog
            id={d.id}
            revision={d.revision}
            disabled={d.id === null || dirty || s.saving}
            onImported={() => s.reload()}
          />
        ) : null}
        <span className={styles['spacer']} />
        <Button
          size="sm"
          icon={<Icon name="rotate-ccw" />}
          disabled={!dirty || s.saving}
          onClick={() => s.revert()}
        >
          {w.revert}
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Icon name="save" />}
          disabled={!dirty || s.saving}
          onClick={() => void s.save()}
        >
          {w.save}
        </Button>
      </div>
    </div>
  )
}
