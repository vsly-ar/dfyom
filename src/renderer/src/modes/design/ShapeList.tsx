// The Shapes dialog's body (task U1; the navigator's "Shapes" group until D45): one row per named shape as
// `design.shape.list` gives it (shape icon, name, "used by n", the failed marker when it does not
// resolve), in the operation-row pattern without move actions (shapes have no order). Remove is
// disabled while an operation uses the shape, with the reason as tooltip and visible text. "Add
// shape" offers the primitives, a path and Import SVG… (task U2: the file dialog, the options step
// of the import dialog, `design.shape.import`, then its report; "Edit shape" selects the first
// created shape). Adding or choosing a shape selects it, which opens the Shape Editor, and closes
// the dialog (`onChosen`). Keyboard (hardening U2): Remove is the row's next tab stop and shows
// while the row has focus; `Delete` (or `Backspace`) on a row removes an unused shape, and focus
// goes to the next row (else the previous one, else "Add shape"). Doc: docs/conventions/ui.md#navigator-and-add,
// docs/conventions/ui.md#design-sidebar-and-setup-dialogs-v04-d45, docs/modes/design-v0.3.md#what-a-shape-is
import { useRef, useState } from 'react'
import type { ShapeItemKind } from '../../../../core/design/shape.dto'
import { chainBounds } from '../../../../core/geometry/2d/model'
import type { SvgImportReport, SvgSplit, SvgUnit } from '../../../../core/import/svg'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { shapeMessages } from '../../messages/shape'
import { useRegion2d, useShell } from '../../shell/ShellContext'
import { Button, Icon, IconButton, Menu, type MenuEntry } from '../../ui'
import styles from './Design.module.css'
import { ImportReportDialog, type ImportReportStep } from './ImportReportDialog'
import { itemName, type DesignPart } from './model'
import { shapeLoops } from './ShapePicker'
import { newItemArgs } from './shape-model'
import { ShapeKindIcon } from './ShapeKindIcon'
import { useCommand, useDesignSelection } from './useDesign'
import { useShapeList } from './useShapes'

const m = shapeMessages.navigator
export const SHAPE_KINDS: readonly ShapeItemKind[] = [
  'rectangle',
  'circle',
  'obround',
  'polygon',
  'path',
]

/** The "Add shape" entries: the kinds, then Import SVG… when `onImport` is given. */
export function addShapeEntries(
  onAdd: (kind: ShapeItemKind) => void,
  onImport?: () => void,
): MenuEntry[] {
  return [
    ...SHAPE_KINDS.map((k) => ({
      label: m.addKind(k),
      icon: <ShapeKindIcon kind={k} />,
      onSelect: () => onAdd(k),
    })),
    ...(onImport ? (['separator', { label: m.importSvg, onSelect: onImport }] as const) : []),
  ]
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
    }

/**
 * The SVG import flow (task U2): file dialog → options → `design.shape.import` → report. Names
 * and the preview come from the part's shapes once the import has landed.
 */
export function useSvgImport(
  part: DesignPart,
  /** "Edit shape" chose a created shape (the Shapes dialog closes). */
  onChosen?: () => void,
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
    const r = await call('design.shape.import', { partId: part.dto.id, path, unit, split })
    if (!r.ok) return setState({ kind: 'refused', error: r.error })
    const { shapeIds, report } = r.value as { shapeIds: string[]; report: SvgImportReport }
    ui.getState().setLastImport({ shapeIds, report })
    setState({ kind: 'report', shapeIds, report })
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
  const svg = useSvgImport(part, onChosen)
  const opName = (id: string) => itemName(part.dto, id)
  const rowButtons = useRef(new Map<string, HTMLButtonElement>())
  const addButton = useRef<HTMLButtonElement>(null)

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

  return (
    <div className={styles['setupList']}>
      <div className={styles['setupActions']}>
        <Menu label={m.add} items={addShapeEntries((k) => void add(k), svg.start)}>
          <Button ref={addButton} size="sm" icon={<Icon name="add" />}>
            {m.add}
          </Button>
        </Menu>
      </div>
      {(part.dto.shapes?.length ?? 0) === 0 ? (
        <p className={styles['setupEmpty']}>{m.empty}</p>
      ) : (
        <ul className={styles['ops']} aria-label={m.listLabel}>
          {rows.map((row) => {
            const used = row.usedBy.length > 0
            const failed = row.kind === undefined
            const reason = used ? m.referenced(row.usedBy.map(opName)) : undefined
            return (
              <li
                key={row.id}
                className={styles['op']}
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
                  aria-keyshortcuts="Delete"
                  {...(reason ? { 'aria-describedby': `${row.id}-reason` } : {})}
                  onKeyDown={(e) => {
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
                  <Icon name="shapes" />
                  <span className={styles['opName']}>{row.name}</span>
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
                <span className={styles['opActions']}>
                  <IconButton
                    label={m.remove(row.name)}
                    icon={<Icon name="delete" />}
                    aria-disabled={used || undefined}
                    {...(reason ? { 'aria-describedby': `${row.id}-reason` } : {})}
                    onClick={() => (used ? undefined : void remove(row.id, row.name))}
                  />
                </span>
                {reason ? (
                  <p id={`${row.id}-reason`} className={styles['shapeReason']}>
                    {reason}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {svg.dialog}
    </div>
  )
}
