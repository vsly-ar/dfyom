// The Shapes dialog's body (task U1; the navigator's "Shapes" group until D45): one row per named shape as
// `design.shape.list` gives it (shape icon, name, "used by n", the failed marker when it does not
// resolve), in the operation-row pattern without move actions (shapes have no order). Remove is
// disabled while an operation uses the shape, with the reason in the menu and as visible text. "Add
// shape" offers the primitives and a path; "Import SVG…" is a button beside it (DF49; task U2: the
// file dialog, the options step of the import dialog, `design.shape.import`, then its report;
// "Edit shape" selects the first created shape). With no shapes the empty-state text comes first
// and the two buttons follow it. `useSvgImport` also serves the operation shape picker and the
// Shape Editor (DF49). Adding or choosing a shape selects it, which opens the Shape Editor, and closes
// the dialog (`onChosen`). Row actions are a context menu (DF70, ui.md decision 27): right-click,
// Shift+F10 / the Menu key on a row open "Actions for Shape 1" (Remove; the row has no action
// button). `Delete` (or `Backspace`) on a row removes an unused shape, and focus goes to the next
// row (else the previous one, else "Add shape"). Doc: docs/conventions/ui.md#navigator-and-add,
// docs/conventions/ui.md#import-svg-where-it-is-looked-for-df49,
// docs/conventions/ui.md#design-sidebar-and-setup-dialogs-v04-d45, docs/modes/design-v0.3.md#what-a-shape-is
import { useId, useRef, useState } from 'react'
import type { ShapeItemKind } from '../../../../core/design/shape.dto'
import { chainBounds } from '../../../../core/geometry/2d/model'
import type { SvgImportReport, SvgSplit, SvgUnit } from '../../../../core/import/svg'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { designMessages } from '../../messages/design'
import { shapeMessages } from '../../messages/shape'
import { useRegion2d, useShell } from '../../shell/ShellContext'
import {
  Button,
  ContextMenu,
  Icon,
  isContextMenuKey,
  Menu,
  newGestureId,
  openContextMenu,
  type MenuEntry,
} from '../../ui'
import styles from './Design.module.css'
import { ImportReportDialog, type ImportReportStep } from './ImportReportDialog'
import { itemName, type DesignPart } from './model'
import { shapeLoops } from './ShapePicker'
import { newItemArgs } from './shape-model'
import { ShapeKindIcon } from './ShapeKindIcon'
import { useCommand, useDesignSelection } from './useDesign'
import { useShapeList, type ShapeRow } from './useShapes'

const m = shapeMessages.navigator
const nav = designMessages.navigator
export const SHAPE_KINDS: readonly ShapeItemKind[] = [
  'rectangle',
  'circle',
  'obround',
  'polygon',
  'path',
]

/** The "Add shape" entries: the kinds ("Import SVG…" is a button of its own since DF49). */
export function addShapeEntries(onAdd: (kind: ShapeItemKind) => void): MenuEntry[] {
  return SHAPE_KINDS.map((k) => ({
    label: m.addKind(k),
    icon: <ShapeKindIcon kind={k} />,
    onSelect: () => onAdd(k),
  }))
}

/** The import dialog's state: closed, or a step with the chosen file. */
type ImportState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'options'; readonly path: string }
  | { readonly kind: 'refused'; readonly error: AppErrorData }
  | {
      readonly kind: 'report'
      readonly shapeIds: readonly string[]
      readonly report: SvgImportReport
      readonly note?: string
    }

/** What an entry point adds to the import flow (DF49). */
export interface SvgImportHooks {
  /** "Edit shape" chose a created shape (the Shapes dialog closes). */
  readonly onChosen?: () => void
  /**
   * The import landed: further commands sent with `gesture` join its undo step (a compound
   * gesture). Returns the report's note, if any.
   */
  readonly onImported?: (
    shapeIds: readonly string[],
    gesture: string,
  ) => Promise<string | undefined>
}

/**
 * The SVG import flow (task U2): file dialog → options → `design.shape.import` → report. Names
 * and the preview come from the part's shapes once the import has landed.
 */
export function useSvgImport(
  part: DesignPart,
  { onChosen, onImported }: SvgImportHooks = {},
): {
  start: () => void
  dialog: React.JSX.Element | null
} {
  const { bridge, ui } = useShell()
  const call = useCommand()
  const port = useRegion2d()
  const [, select] = useDesignSelection()
  const [state, setState] = useState<ImportState>({ kind: 'closed' })
  const close = () => setState({ kind: 'closed' })

  const start = () =>
    void (async () => {
      const path = await bridge.files.chooseSvg()
      if (path !== null) setState({ kind: 'options', path })
    })()
  const run = async (path: string, unit: SvgUnit, split: SvgSplit) => {
    const gesture = newGestureId()
    const r = await call(
      'design.shape.import',
      { partId: part.dto.id, path, unit, split },
      onImported === undefined ? undefined : { gesture },
    )
    if (!r.ok) return setState({ kind: 'refused', error: r.error })
    const { shapeIds, report } = r.value as { shapeIds: string[]; report: SvgImportReport }
    ui.getState().setLastImport({ shapeIds, report })
    const note = onImported === undefined ? undefined : await onImported(shapeIds, gesture)
    setState({ kind: 'report', shapeIds, report, ...(note === undefined ? {} : { note }) })
  }

  let step: ImportReportStep | undefined
  if (state.kind === 'options' || state.kind === 'refused') step = state
  else if (state.kind === 'report') {
    const shapes = state.shapeIds.map((id) => part.dto.shapes?.find((s) => s.id === id))
    const loops = shapes.flatMap((s) => (s === undefined ? [] : shapeLoops(port, s)))
    step = {
      kind: 'report',
      report: state.report,
      shapes: shapes.map((s, i) => s?.name ?? state.shapeIds[i]!),
      ...(state.note === undefined ? {} : { note: state.note }),
      ...(loops.length > 0
        ? { preview: { loops, bounds: chainBounds(loops.flatMap((l) => l.elements)) } }
        : {}),
    }
  }
  const dialog =
    step === undefined ? null : (
      <ImportReportDialog
        open
        onOpenChange={(o) => {
          if (!o) close()
        }}
        step={step}
        units={part.units}
        onImport={({ unit, split }) => {
          if (state.kind === 'options') void run(state.path, unit, split)
        }}
        onEdit={() => {
          const first = state.kind === 'report' ? state.shapeIds[0] : undefined
          close()
          if (first === undefined) return
          ui.getState().selectShapeItem(first, 0)
          select(first)
          onChosen?.()
        }}
      />
    )
  return { start, dialog }
}

export function ShapeList({
  part,
  onRemoved,
  onChosen,
}: {
  part: DesignPart
  onRemoved: (name: string) => void
  /** A shape was chosen or added and is selected: the dialog closes so its editor shows. */
  onChosen: () => void
}): React.JSX.Element {
  const call = useCommand()
  const { ui } = useShell()
  const [selected, select] = useDesignSelection()
  const rows = useShapeList(part)
  const svg = useSvgImport(part, { onChosen })
  const opName = (id: string) => itemName(part.dto, id)
  const rowButtons = useRef(new Map<string, HTMLButtonElement>())
  const addButton = useRef<HTMLButtonElement>(null)
  const hintId = useId()

  const add = async (kind: ShapeItemKind) => {
    const r = await call('design.shape.add', {
      partId: part.dto.id,
      items: [newItemArgs(kind, part.units)],
    })
    if (!r.ok) return
    const id = (r.value as { shapeId: string }).shapeId
    ui.getState().selectShapeItem(id, 0)
    select(id)
    onChosen()
  }
  const remove = async (id: string, name: string) => {
    // the row focus lands on once this one is gone
    const ids = rows.map((r) => r.id)
    const at = ids.indexOf(id)
    const next = ids[at + 1] ?? ids[at - 1]
    const r = await call('design.shape.remove', { partId: part.dto.id, shapeId: id })
    if (!r.ok) return
    if (selected === id) select(null)
    onRemoved(name)
    const target = next === undefined ? addButton.current : rowButtons.current.get(next)
    target?.focus()
  }

  const empty = (part.dto.shapes?.length ?? 0) === 0
  /** A row's item kind (one item) and read-out "Path · 250 × 178" (DF48). */
  const rowLook = (row: ShapeRow): { single?: ShapeItemKind; readout: string } => {
    const items = part.dto.shapes?.find((s) => s.id === row.id)?.items ?? []
    const single = items.length === 1 ? items[0]?.kind : undefined
    const kind =
      single === 'path' && row.kind === 'path'
        ? m.openPath
        : single !== undefined
          ? shapeMessages.kinds[single]
          : m.items(items.length || row.items)
    const b = row.bounds
    const size = b === undefined ? undefined : ([b.max[0] - b.min[0], b.max[1] - b.min[1]] as const)
    return {
      ...(single === undefined ? {} : { single }),
      readout: m.readout(kind, size, part.units),
    }
  }
  // with no shapes the explanation comes first and its actions follow it (DF49); else the
  // actions head the list
  const actions = (
    <div className={styles['setupActions']}>
      <Menu label={m.add} items={addShapeEntries((k) => void add(k))}>
        <Button ref={addButton} size="sm" icon={<Icon name="add" />}>
          {m.add}
        </Button>
      </Menu>
      <Button size="sm" icon={<Icon name="shape-import" />} onClick={svg.start}>
        {m.importSvg}
      </Button>
    </div>
  )

  return (
    <div className={styles['setupList']}>
      {/* the actions keep their place in the tree, so "Add shape" keeps focus across the switch */}
      {empty ? <p className={styles['setupEmpty']}>{m.empty}</p> : null}
      {actions}
      {empty ? null : (
        <ul className={styles['ops']} aria-label={m.listLabel}>
          {rows.map((listed) => {
            const row = { ...listed, ...rowLook(listed) }
            const used = row.usedBy.length > 0
            const failed = row.kind === undefined
            const reason = used ? m.referenced(row.usedBy.map(opName)) : undefined
            const reasonId = `${row.id}-reason`
            const menu: MenuEntry[] = [
              {
                label: nav.removeItem,
                icon: <Icon name="delete" />,
                shortcut: 'Delete',
                danger: true,
                disabledReason: reason,
                onSelect: () => void remove(row.id, row.name),
              },
            ]
            return (
              <ContextMenu
                key={row.id}
                label={nav.actions(row.name)}
                items={menu}
                onCloseAutoFocus={(e) => {
                  e.preventDefault()
                  rowButtons.current.get(row.id)?.focus()
                }}
              >
                <li
                  className={styles['op']}
                  data-row-menu=""
                  data-selected={selected === row.id ? '' : undefined}
                >
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) rowButtons.current.set(row.id, el)
                      else rowButtons.current.delete(row.id)
                    }}
                    className={styles['opSelect']}
                    aria-pressed={selected === row.id}
                    aria-keyshortcuts="Shift+F10 Delete"
                    aria-describedby={reason ? `${hintId} ${reasonId}` : hintId}
                    onKeyDown={(e) => {
                      // Shift+F10 / the Menu key: the row's menu, at the row (DF70)
                      if (isContextMenuKey(e)) {
                        const el = e.currentTarget.closest('[data-row-menu]')
                        if (el === null) return
                        e.preventDefault()
                        return openContextMenu(el)
                      }
                      if (e.key !== 'Delete' && e.key !== 'Backspace') return
                      e.preventDefault()
                      if (!used) void remove(row.id, row.name)
                    }}
                    onClick={() => {
                      if (selected !== row.id) {
                        ui.getState().selectShapeItem(row.id, 0)
                        select(row.id)
                      }
                      onChosen()
                    }}
                  >
                    {/* the kind's icon and a read-out tell shapes apart (DF48) */}
                    {row.single !== undefined ? (
                      <ShapeKindIcon kind={row.single} />
                    ) : (
                      <Icon name="shapes" />
                    )}
                    <span className={styles['featureText']}>
                      <span className={styles['opName']} title={row.name}>
                        {row.name}
                      </span>
                      <span className={styles['featureReadout']}>
                        <span className={styles['srOnly']}>{', '}</span>
                        {row.readout}
                      </span>
                    </span>
                    {used ? (
                      <span className={styles['shapeUse']}>{m.usedBy(row.usedBy.length)}</span>
                    ) : null}
                    {failed ? (
                      <span className={styles['opFailed']} title={m.failed}>
                        <Icon name="error" />
                        <span className={styles['srOnly']}>{m.failed}</span>
                      </span>
                    ) : null}
                  </button>
                  {reason ? (
                    <p id={reasonId} className={styles['shapeReason']}>
                      {reason}
                    </p>
                  ) : null}
                </li>
              </ContextMenu>
            )
          })}
        </ul>
      )}
      {empty ? null : (
        <p id={hintId} className={styles['srOnly']}>
          {nav.rowMenuHint}
        </p>
      )}
      {svg.dialog}
    </div>
  )
}
