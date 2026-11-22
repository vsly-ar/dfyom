// The navigator's "Shapes" group (task U1), above the operations: one row per named shape as
// `design.shape.list` gives it (shape icon, name, "used by n", the failed marker when it does not
// resolve), in the operation-row pattern without move actions (shapes have no order). Remove is
// disabled while an operation uses the shape, with the reason as tooltip and visible text. "Add
// shape" offers the primitives, a path and Import SVG… (disabled until `design.shape.import`).
// Adding a shape selects it, which opens the Shape Editor.
// Doc: docs/conventions/ui.md#navigator-and-add, docs/modes/design-v0.3.md#what-a-shape-is
import { CircleAlert, Plus, Shapes, Trash2 } from 'lucide-react'
import type { ShapeItemKind } from '../../../../core/design/shape.dto'
import { shapeMessages } from '../../messages/shape'
import { useShell } from '../../shell/ShellContext'
import { IconButton, Menu, PanelHeader, type MenuEntry } from '../../ui'
import styles from './Design.module.css'
import type { DesignPart } from './model'
import { newItemArgs } from './shape-model'
import { ShapeKindIcon } from './ShapeKindIcon'
import { useCommand, useDesignSelection } from './useDesign'
import { useShapeList } from './useShapes'

const m = shapeMessages.navigator
export const SHAPE_KINDS: readonly ShapeItemKind[] = ['rectangle', 'circle', 'obround', 'polygon', 'path']

/** The "Add shape" entries: the kinds, then Import SVG… (disabled: `design.shape.import` is not built yet). */
export function addShapeEntries(onAdd: (kind: ShapeItemKind) => void): MenuEntry[] {
  return [
    ...SHAPE_KINDS.map((k) => ({
      label: m.addKind(k),
      icon: <ShapeKindIcon kind={k} />,
      onSelect: () => onAdd(k),
    })),
    'separator',
    { label: m.importSvg, onSelect: () => undefined, disabled: true },
  ]
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
          <Menu label={m.add} items={addShapeEntries((k) => void add(k))}>
            <IconButton label={m.add} icon={<Plus aria-hidden="true" />} />
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
                  <Shapes aria-hidden="true" />
                  <span className={styles['opName']}>{row.name}</span>
                  <span className={styles['shapeUse']}>{m.usedBy(row.usedBy.length)}</span>
                  {failed ? (
                    <span className={styles['opFailed']} title={m.failed}>
                      <CircleAlert aria-hidden="true" />
                      <span className={styles['srOnly']}>{m.failed}</span>
                    </span>
                  ) : null}
                </button>
                <span className={styles['opActions']}>
                  <IconButton
                    label={m.remove(row.name)}
                    icon={<Trash2 aria-hidden="true" />}
                    aria-disabled={used || undefined}
                    {...(reason ? { 'aria-describedby': `${row.id}-reason` } : {})}
                    onClick={() => (used ? undefined : void remove(row.id, row.name))}
                  />
                </span>
                {reason ? <p id={`${row.id}-reason`} className={styles['shapeReason']}>
                    {reason}
                  </p> : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
