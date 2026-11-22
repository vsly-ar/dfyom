// The navigator's "Shapes" group (task U1), above the operations: one row per named shape as
// `design.shape.list` gives it (shape icon, name, "used by n", the failed marker when it does not
// resolve), in the operation-row pattern without move actions (shapes have no order). Remove is
// disabled while an operation uses the shape, with the reason as tooltip and visible text. "Add
// shape" offers the primitives, a path and Import SVG… (task U2: the file dialog, the options step
// of the import dialog, `design.shape.import`, then its report; "Edit shape" selects the first
// created shape). Adding a shape selects it, which opens the Shape Editor.
// Doc: docs/conventions/ui.md#navigator-and-add, docs/modes/design-v0.3.md#what-a-shape-is
import { useState } from 'react'
import type { ShapeItemKind } from '../../../../core/design/shape.dto'
import { chainBounds } from '../../../../core/geometry/2d/model'
import type { SvgImportReport, SvgSplit, SvgUnit } from '../../../../core/import/svg'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { shapeMessages } from '../../messages/shape'
import { useRegion2d, useShell } from '../../shell/ShellContext'
import { Icon, IconButton, Menu, PanelHeader, type MenuEntry } from '../../ui'
import styles from './Design.module.css'
import { ImportReportDialog, type ImportReportStep } from './ImportReportDialog'
import type { DesignPart } from './model'
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
export function useSvgImport(part: DesignPart): {
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
        }}
      />
    )
  return { start, dialog }
}

export function ShapeList({
  part,
  onRemoved,
}: {
  part: DesignPart
  onRemoved: (name: string) => void
}): React.JSX.Element {
  const call = useCommand()
  const { ui } = useShell()
  const [selected, select] = useDesignSelection()
  const rows = useShapeList(part)
  const svg = useSvgImport(part)
  const opName = (id: string) => part.dto.operations.find((o) => o.id === id)?.name ?? id

  const add = async (kind: ShapeItemKind) => {
    const r = await call('design.shape.add', {
      partId: part.dto.id,
      items: [newItemArgs(kind, part.units)],
    })
    if (!r.ok) return
    const id = (r.value as { shapeId: string }).shapeId
    ui.getState().selectShapeItem(id, 0)
    select(id)
  }
  const remove = async (id: string, name: string) => {
    const r = await call('design.shape.remove', { partId: part.dto.id, shapeId: id })
    if (!r.ok) return
    if (selected === id) select(null)
    onRemoved(name)
  }

  return (
    <section aria-label={m.title}>
      <PanelHeader
        title={m.title}
        meta={rows.length > 0 ? String(rows.length) : undefined}
        actions={
          <Menu label={m.add} items={addShapeEntries((k) => void add(k), svg.start)}>
            <IconButton label={m.add} icon={<Icon name="add" />} />
          </Menu>
        }
      />
      {(part.dto.shapes?.length ?? 0) === 0 ? (
        <p className={styles['shapesEmpty']}>{m.empty}</p>
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
                  className={styles['opSelect']}
                  aria-pressed={selected === row.id}
                  onClick={() => {
                    if (selected === row.id) return select(null)
                    ui.getState().selectShapeItem(row.id, 0)
                    select(row.id)
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
    </section>
  )
}
