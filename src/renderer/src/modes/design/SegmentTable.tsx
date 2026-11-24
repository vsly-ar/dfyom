// The segment table of a path item (task U1): a dense keyboard grid, one row per segment – #, type
// (Line, Arc, Tangent arc), end X and Y, radius, CW/CCW, large arc and the fillet at the end vertex;
// a cell that does not apply to the type is empty. In a narrow inspector each segment takes two
// lines (type, X, Y; radius, direction, large arc, fillet) so realistic numbers fit unscrolled. Arrows move between cells (roving focus),
// Enter edits a cell and Enter commits it (back to the cell), Escape leaves the cell's control,
// Alt+↑/↓ moves a row, Delete on # removes it with an undo toast (the navigator's). A row's actions
// (move up / down, remove) are its context menu: right-click on the row, Shift+F10 / the Menu key
// on a cell (DF70, ui.md decision 27; the # cell's "…"-style button until then). Every cell is a
// QuantityInput (or a choice); every commit is one `design.shape.item.update` of the segment (or
// fillet) list.
// Doc: docs/conventions/ui.md#shape-editor, docs/modes/design-v0.3.md#shape-definition
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ShapeSegment } from '../../../../core/design/shape.dto'
import { shapeMessages } from '../../messages/shape'
import { useShell } from '../../shell/ShellContext'
import {
  Icon,
  Button,
  Checkbox,
  ContextMenu,
  isContextMenuKey,
  openContextMenu,
  QuantityInput,
  SegmentedControl,
  Select,
  type MenuEntry,
} from '../../ui'
import { defaultUnit } from './model'
import styles from './Design.module.css'
import { ItemQuantity, type ItemEditContext } from './ShapeInspector'
import {
  endVertex,
  fieldUpdate,
  itemNumbers,
  itemSources,
  newSegment,
  retypeSegment,
} from './shape-model'

const t = shapeMessages.segments
const COLUMNS = ['number', 'type', 'x', 'y', 'radius', 'direction', 'large', 'fillet'] as const
type Column = (typeof COLUMNS)[number]
type Fillet = { vertex: number; radius: string }

export function SegmentTable({
  ctx,
  selected,
  onSelect,
}: {
  ctx: ItemEditContext
  /** The selected row (its handles highlight in the flat view), or null. */
  selected: number | null
  onSelect(k: number | null): void
}): React.JSX.Element | null {
  const { ui } = useShell()
  const [focus, setFocus] = useState<{ row: number; col: number }>({ row: 0, col: 0 })
  const cells = useRef(new Map<string, HTMLTableCellElement>())
  // the cell focus returns to when a row menu closes (its row follows a move or a removal)
  const menuReturn = useRef<{ row: number; col: number }>({ row: 0, col: 0 })
  const keyOpened = useRef(false)
  // a segment picked in the flat view: its row scrolls into view (long imported paths, L3-7)
  useEffect(() => {
    if (selected !== null)
      cells.current.get(`${selected}:0`)?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])
  const dto = ctx.dto
  const numbers = itemNumbers(dto)
  if (dto.kind !== 'path' || numbers?.kind !== 'path') return null
  const src = itemSources(dto) as Extract<ReturnType<typeof itemSources>, { kind: 'path' }>
  const segments = src.segments
  const fillets: Fillet[] = (src.fillets ?? []).map((f) => ({ ...f }))
  const n = segments.length
  const label = shapeMessages.inspector.itemLabel('path', ctx.index + 1)

  const cellKey = (row: number, col: number) => `${row}:${col}`
  const focusCell = (row: number, col: number) => {
    const r = Math.max(0, Math.min(n - 1, row))
    const c = Math.max(0, Math.min(COLUMNS.length - 1, col))
    setFocus({ row: r, col: c })
    cells.current.get(cellKey(r, c))?.focus()
  }

  const sendSegments = (next: ShapeSegment<string>[], nextFillets?: Fillet[]) =>
    ctx.send({ segments: next, ...(nextFillets === undefined ? {} : { fillets: nextFillets }) })

  /** The fillets after the segments' end vertices moved by `map` (old vertex → new, or undefined: dropped). */
  const remapFillets = (map: (v: number) => number | undefined): Fillet[] =>
    fillets.flatMap((f) => {
      const v = map(f.vertex)
      return v === undefined ? [] : [{ ...f, vertex: v }]
    })

  const moveRow = (k: number, by: -1 | 1) => {
    const to = k + by
    if (to < 0 || to >= n) return
    const next = [...segments]
    const [s] = next.splice(k, 1)
    next.splice(to, 0, s!)
    // the end vertices of the two rows swap with them
    const a = k + 1
    const b = to + 1
    sendSegments(
      next,
      remapFillets((v) => (v === a ? b : v === b ? a : v)),
    )
    onSelect(to)
    setFocus((f) => ({ ...f, row: to }))
    menuReturn.current = { ...menuReturn.current, row: to }
  }
  const removeRow = (k: number) => {
    if (n <= 1) return
    const next = segments.filter((_, i) => i !== k)
    sendSegments(
      next,
      remapFillets((v) => (v === k + 1 ? undefined : v > k + 1 ? v - 1 : v)),
    )
    // the navigator's undo toast (one toast region per mode)
    ui.getState().setRemovedToast(t.removed(k + 1))
    onSelect(null)
    setFocus((f) => ({ ...f, row: Math.max(0, Math.min(f.row, n - 2)) }))
    menuReturn.current = { ...menuReturn.current, row: Math.max(0, Math.min(k, n - 2)) }
  }
  /** Row `k`'s context menu (DF70): move up / down, remove. */
  const rowMenu = (k: number): MenuEntry[] => {
    const num = k + 1
    return [
      {
        label: t.moveUp(num),
        shortcut: 'Alt+↑',
        disabled: k === 0,
        onSelect: () => moveRow(k, -1),
      },
      {
        label: t.moveDown(num),
        shortcut: 'Alt+↓',
        disabled: k === n - 1,
        onSelect: () => moveRow(k, 1),
      },
      'separator',
      {
        label: t.remove(num),
        shortcut: 'Delete',
        danger: true,
        disabled: n <= 1,
        onSelect: () => removeRow(k),
      },
    ]
  }
  const addRow = () => {
    const after = selected ?? n - 1
    const next = [...segments]
    next.splice(after + 1, 0, newSegment(numbers, dto, after, ctx.part.units))
    sendSegments(
      next,
      remapFillets((v) => (v > after + 1 ? v + 1 : v)),
    )
    onSelect(after + 1)
  }
  const setFillet = (vertex: number, radius: string | undefined) => {
    const rest = fillets.filter((f) => f.vertex !== vertex)
    ctx.send({
      fillets:
        radius === undefined
          ? rest
          : [...rest, { vertex, radius }].sort((x, y) => x.vertex - y.vertex),
    })
  }

  const onCellKey = (e: KeyboardEvent<HTMLTableCellElement>, row: number, col: number) => {
    const onCell = e.target === e.currentTarget
    if (!onCell) {
      if (e.key === 'Escape') {
        // the control reverts itself; focus returns to the cell after it
        setTimeout(() => cells.current.get(cellKey(row, col))?.focus())
      } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
        setTimeout(() => cells.current.get(cellKey(row, col))?.focus())
      }
      return
    }
    // Shift+F10 / the Menu key: the row's menu, at the row; focus comes back to this cell
    if (isContextMenuKey(e)) {
      const tr = e.currentTarget.closest('tr')
      if (tr === null) return
      e.preventDefault()
      menuReturn.current = { row, col }
      keyOpened.current = true
      return openContextMenu(tr)
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      moveRow(row, e.key === 'ArrowUp' ? -1 : 1)
      return
    }
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    }
    const d = moves[e.key]
    if (d) {
      e.preventDefault()
      focusCell(row + d[0], col + d[1])
      return
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      focusCell(
        e.ctrlKey ? (e.key === 'Home' ? 0 : n - 1) : row,
        e.key === 'Home' ? 0 : COLUMNS.length - 1,
      )
      return
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && COLUMNS[col] === 'number') {
      e.preventDefault()
      removeRow(row)
      return
    }
    if (e.key === 'Enter' || e.key === 'F2') {
      const control = e.currentTarget.querySelector<HTMLElement>('input, button, [role="combobox"]')
      if (control) {
        e.preventDefault()
        control.focus()
      }
    }
  }

  const cell = (row: number, col: Column, content: React.ReactNode, name: string) => {
    const c = COLUMNS.indexOf(col)
    const active = focus.row === row && focus.col === c
    return (
      <td
        key={col}
        ref={(el) => {
          if (el) cells.current.set(cellKey(row, c), el)
          else cells.current.delete(cellKey(row, c))
        }}
        role="gridcell"
        tabIndex={active ? 0 : -1}
        aria-label={content === null ? `${name}: –` : undefined}
        className={styles['segCell']}
        data-column={col}
        onFocus={() => {
          if (focus.row !== row || focus.col !== c) setFocus({ row, col: c })
          if (selected !== row) onSelect(row)
        }}
        onKeyDown={(e) => onCellKey(e, row, c)}
      >
        {content}
      </td>
    )
  }

  return (
    <section className={styles['group']} aria-label={t.title}>
      <div className={styles['groupHead']}>
        <h3 className={styles['groupTitle']}>{t.title}</h3>
        <Button size="sm" variant="ghost" icon={<Icon name="add" />} onClick={addRow}>
          {t.add}
        </Button>
      </div>
      <div className={styles['segScroll']}>
        <table
          role="grid"
          aria-label={t.label(label)}
          className={styles['segTable']}
          aria-describedby={`${dto.kind}-${ctx.index}-keys`}
        >
          <thead>
            <tr role="row">
              <th role="columnheader" scope="col" data-column="number">
                {t.number}
              </th>
              <th role="columnheader" scope="col" data-column="type">
                {t.type}
              </th>
              <th role="columnheader" scope="col" data-column="x">
                {t.x}
              </th>
              <th role="columnheader" scope="col" data-column="y">
                {t.y}
              </th>
              <th role="columnheader" scope="col" data-column="radius">
                {t.radius}
              </th>
              <th role="columnheader" scope="col" data-column="direction">
                {t.direction}
              </th>
              <th role="columnheader" scope="col" data-column="large" aria-label={t.large}>
                {t.largeShort}
              </th>
              <th role="columnheader" scope="col" data-column="fillet">
                {t.fillet}
              </th>
            </tr>
          </thead>
          <tbody>
            {segments.map((s, k) => {
              const num = k + 1
              const vertex = endVertex(numbers, k)
              // an open path has no fillet at its ends
              const filletable = numbers.closed || k < n - 1
              const fi = fillets.findIndex((f) => f.vertex === vertex)
              const from = k === 0 ? numbers.start : numbers.segments[k - 1]!.to
              const to = numbers.segments[k]!.to
              const chord = Math.hypot(to[0] - from[0], to[1] - from[1])
              const bad =
                ctx.errors !== undefined &&
                [...ctx.errors.byField.keys()].some((f) => f.startsWith(`segments.${k}.`))
              return (
                <ContextMenu
                  key={k}
                  label={t.actions(num)}
                  items={rowMenu(k)}
                  onCloseAutoFocus={(e) => {
                    e.preventDefault()
                    focusCell(menuReturn.current.row, menuReturn.current.col)
                  }}
                >
                  <tr
                    role="row"
                    aria-selected={selected === k}
                    data-selected={selected === k ? '' : undefined}
                    data-invalid={bad ? '' : undefined}
                    onContextMenu={() => {
                      // the menu acts on this row: it is selected (its handles highlight); after a
                      // right-click focus comes back to its # cell, after Shift+F10 to the cell
                      if (selected !== k) onSelect(k)
                      if (!keyOpened.current) menuReturn.current = { row: k, col: 0 }
                      keyOpened.current = false
                    }}
                  >
                    {cell(
                      k,
                      'number',
                      <span className={styles['segNumber']}>{num}</span>,
                      t.row(num),
                    )}
                    {cell(
                      k,
                      'type',
                      <Select
                        aria-label={t.cell(num, t.type)}
                        className={styles['segSelect']}
                        options={(['line', 'arc', 'tangentArc'] as const).map((v) => ({
                          value: v,
                          label: t.types[v],
                        }))}
                        value={s.kind}
                        onValueChange={(kind) => {
                          if (kind === s.kind) return
                          const next = [...segments]
                          next[k] = retypeSegment(s, kind, chord, ctx.part.units)
                          sendSegments(next)
                        }}
                      />,
                      t.type,
                    )}
                    {cell(
                      k,
                      'x',
                      <ItemQuantity
                        ctx={ctx}
                        path={['segments', k, 'to', 0]}
                        label={t.cell(num, t.x)}
                        compact
                      />,
                      t.x,
                    )}
                    {cell(
                      k,
                      'y',
                      <ItemQuantity
                        ctx={ctx}
                        path={['segments', k, 'to', 1]}
                        label={t.cell(num, t.y)}
                        compact
                      />,
                      t.y,
                    )}
                    {cell(
                      k,
                      'radius',
                      s.kind === 'arc' ? (
                        <ItemQuantity
                          ctx={ctx}
                          path={['segments', k, 'radius']}
                          label={t.cell(num, t.radius)}
                          compact
                        />
                      ) : null,
                      t.radius,
                    )}
                    {cell(
                      k,
                      'direction',
                      s.kind === 'arc' ? (
                        <SegmentedControl
                          label={t.cell(num, t.direction)}
                          size="sm"
                          options={[
                            { value: 'ccw', label: t.ccw },
                            { value: 'cw', label: t.cw },
                          ]}
                          value={s.cw ? 'cw' : 'ccw'}
                          onValueChange={(v) =>
                            ctx.send(fieldUpdate(dto, ['segments', k, 'cw'], v === 'cw'))
                          }
                        />
                      ) : null,
                      t.direction,
                    )}
                    {cell(
                      k,
                      'large',
                      s.kind === 'arc' ? (
                        <Checkbox
                          label={t.cell(num, t.large)}
                          className={styles['segCheck']}
                          checked={Boolean(s.large)}
                          onCheckedChange={(v) =>
                            ctx.send(fieldUpdate(dto, ['segments', k, 'large'], v === true))
                          }
                        />
                      ) : null,
                      t.large,
                    )}
                    {cell(
                      k,
                      'fillet',
                      filletable ? (
                        fi >= 0 ? (
                          <ItemQuantity
                            ctx={ctx}
                            path={['fillets', fi, 'radius']}
                            label={t.cell(num, t.fillet)}
                            compact
                            optional
                          />
                        ) : (
                          <FilletCell
                            ctx={ctx}
                            label={t.cell(num, t.fillet)}
                            onCommit={(source) => setFillet(vertex, source)}
                          />
                        )
                      ) : null,
                      t.fillet,
                    )}
                  </tr>
                </ContextMenu>
              )
            })}
          </tbody>
        </table>
      </div>
      <p id={`${dto.kind}-${ctx.index}-keys`} className={styles['srOnly']}>
        {t.keys}
      </p>
    </section>
  )
}

/** An empty fillet cell: a value adds a fillet at the row's end vertex. */
function FilletCell({
  ctx,
  label,
  onCommit,
}: {
  ctx: ItemEditContext
  label: string
  onCommit(source: string | undefined): void
}): React.JSX.Element {
  return (
    <QuantityInput
      label={label}
      kind="length"
      defaultUnit={defaultUnit('length', ctx.part.units)}
      value={undefined}
      optional
      className={styles['cellInput']}
      dense
      onCommit={(v) => onCommit(v?.source)}
    />
  )
}
