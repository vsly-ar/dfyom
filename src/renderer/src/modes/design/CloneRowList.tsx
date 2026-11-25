// The Clones rows editor (v0.4 task U3, ui.md § Clones): the path rows in path order, each with
// its kind icon, a summary ("Arc · 5 positions"), its drag grip (D45; Alt+↑/↓) and remove; the
// selected row expands to its fields (QuantityInputs in project units, ° for angles; counts as
// whole numbers) and its Skipped chips (restore by number). Add row (Grid, Offset, Polar, Arc,
// Point, Along – Along disabled without a one-item path shape) appends a row placed a step from
// the last position. Shared by the draft (local rows) and the Clones inspector (each change one
// `design.clones.update`); the caller decides what a change does. The selected row's segment of
// the clone path is amber (ui store `clonesRow`). Each field names the face axis (X/Y on the top
// face, u/v elsewhere), has its own field illustration and a one-line hint (DF47).
// Doc: docs/conventions/ui.md#clones, #reordering-lists-d45
import { useState, type KeyboardEvent } from 'react'
import type { CloneRowKind } from '../../../../core/design/clones/clones'
import { fieldContext } from '../../../../core/design/operation'
import { quantityFromSource } from '../../../../core/expression/quantity'
import type { ReferenceResolver } from '../../../../core/expression/evaluate'
import type { ShapeDTO } from '../../../../core/design/shape.dto'
import type { UnitSystem } from '../../../../core/project/document'
import type { Quantity } from '../../../../core/quantity/quantity'
import { fail, None, Ok, type AppResult } from '../../../../shared/result'
import { designMessages } from '../../messages/design'
import { useUi } from '../../shell/ShellContext'
import {
  Button,
  DragGrip,
  Icon,
  IconButton,
  Menu,
  moveItem,
  ReorderStatus,
  useReorder,
  QuantityInput,
  SegmentedControl,
  Select,
  Field,
  FieldIcon,
  type FieldIconName,
  type FieldMessage,
} from '../../ui'
import type { ClonePathData } from '../../viewport/clone-path'
import styles from './Design.module.css'
import {
  alongShapes,
  countField,
  newRow,
  ROW_FIELD_ORDER,
  ROW_ICON,
  ROW_KINDS,
  rowPositions,
  skippedNumbers,
  type Readout,
  type RowArg,
} from './clones-view'
import type { FieldError } from './OperationFields'

const c = designMessages.features.clones
const r = designMessages.reorder

/** Names of the face's axes in labels and hints (`axisNames`: X/Y on the top face, else u/v). */
export interface AxisNames {
  readonly u: string
  readonly v: string
}

/** A row field's label, hint and illustration (DF47, ui.md § Clones). */
export interface RowFieldText {
  readonly label: string
  readonly hint: string
  readonly icon: FieldIconName
}

/**
 * The label, hint and illustration of a row field. Offset names its steps differently from a
 * grid's spacing (the same quantity, so the same drawing); a point's u/v are positions.
 */
export function rowFieldText(kind: CloneRowKind, key: string, axes: AxisNames): RowFieldText {
  const f = c.fields
  const h = c.hints
  switch (key) {
    case 'cols':
      return { label: f.cols, hint: h.cols(axes.u), icon: 'cloneColumns' }
    case 'rows':
      return { label: f.rows, hint: h.rows(axes.v), icon: 'cloneRows' }
    case 'du':
      return kind === 'offset'
        ? { label: f.stepU(axes.u), hint: h.stepU(axes.u), icon: 'cloneStepU' }
        : { label: f.du(axes.u), hint: h.du(axes.u), icon: 'cloneStepU' }
    case 'dv':
      return kind === 'offset'
        ? { label: f.stepV(axes.v), hint: h.stepV(axes.v), icon: 'cloneStepV' }
        : { label: f.dv(axes.v), hint: h.dv(axes.v), icon: 'cloneStepV' }
    case 'count':
      return kind === 'along'
        ? { label: f.count, hint: h.alongCount, icon: 'cloneCount' }
        : { label: f.count, hint: h.count, icon: 'cloneCount' }
    case 'angle':
      return kind === 'arc'
        ? { label: f.centreAngle, hint: h.centreAngle(axes.u), icon: 'cloneCentreAngle' }
        : { label: f.angle, hint: h.angle(axes.u), icon: 'cloneDirection' }
    case 'distance':
      return { label: f.distance, hint: h.distance, icon: 'cloneDistance' }
    case 'radius':
      return { label: f.radius, hint: h.radius, icon: 'cloneRadius' }
    case 'arc':
      return { label: f.arc, hint: h.arc, icon: 'cloneSweep' }
    case 'step':
      return { label: f.step, hint: h.step, icon: 'cloneStepAngle' }
    case 'u':
      return {
        label: designMessages.inspector.position('Position', axes.u),
        hint: h.point,
        icon: 'positionX',
      }
    case 'v':
      return {
        label: designMessages.inspector.position('Position', axes.v),
        hint: h.point,
        icon: 'positionY',
      }
    case 'shape':
      return { label: f.shape, hint: h.shape, icon: 'clonePath' }
    case 'start':
      return { label: f.start, hint: h.start, icon: 'cloneStart' }
    case 'spacing':
      return { label: f.spacing, hint: h.spacing, icon: 'cloneSpacing' }
    default:
      return { label: key, hint: '', icon: 'length' }
  }
}

/** The hint as the field's (i) tip (docs/conventions/inspector-layout.md#info-tips-df105). */
const infoOf = (t: RowFieldText): { info?: string } => (t.hint === '' ? {} : { info: t.hint })

const NO_REFERENCES: ReferenceResolver = { resolve: () => None }

const whole = (q: Quantity): AppResult<Quantity> =>
  Number.isInteger(q.canonical) && q.canonical >= 1 && q.canonical <= 100
    ? Ok(q)
    : fail('model.invariant', 'not a whole number from 1 to 100', {
        issues: [{ path: ['exact'], rule: 'wholeCount', message: c.countError }],
      })

/** The row's summary: "Arc · 5 positions", "Grid · 3 × 2 · 6 positions", "Along · Shape 1". */
export function rowSummary(
  row: RowArg,
  positions: number | undefined,
  shapes: readonly ShapeDTO[],
): string {
  const kind = c.kinds[row.kind] ?? row.kind
  const parts = [kind]
  if (row.kind === 'grid') parts.push(`${String(row['cols'])} × ${String(row['rows'])}`)
  if (row.kind === 'arc') parts.push(`R ${String(row['radius'])}`)
  if (row.kind === 'point') parts.push(`${String(row['u'])}, ${String(row['v'])}`)
  if (row.kind === 'along')
    parts.push(shapes.find((s) => s.id === row['shapeId'])?.name ?? String(row['shapeId']))
  if (positions !== undefined && row.kind !== 'point') parts.push(c.positions(positions))
  return parts.join(' · ')
}

export function CloneRowList({
  owner,
  rows,
  axes,
  units,
  shapes,
  resolver,
  data,
  errors,
  over,
  step,
  lastAt,
  onChange,
  onCancelGesture,
  onRestore,
}: {
  /** Whose rows these are (the ui store's row focus): a feature id, or `draft`. */
  owner: string
  rows: readonly RowArg[]
  /** The face's axis names (`axisNames` of the Clones' face). */
  axes: AxisNames
  units: UnitSystem
  shapes: readonly ShapeDTO[]
  resolver: ReferenceResolver | undefined
  /** The current path (positions per row, skipped chips); undefined while none is known. */
  data: ClonePathData | undefined
  /** Issues at `rows.<i>.<field>`. */
  errors: readonly FieldError[]
  /** Over the instance limit: the crossing row's count field carries the read-out's error. */
  over: Readout['over'] | undefined
  /** A new row's step (mm): the source's width plus the gap. */
  step: number
  /** The last position (face frame, mm): where a point row jumps from. */
  lastAt: { u: number; v: number }
  /** The rows after an edit; `path` is where its errors show, `gesture` a live step. */
  onChange(rows: readonly RowArg[], path: string, gesture?: string): void
  onCancelGesture(gesture: string): Promise<boolean>
  /** Restore a skipped position by its instance number. */
  onRestore(n: number): void
}): React.JSX.Element {
  const focus = useUi((s) => s.clonesRow)
  const setFocus = useUi((s) => s.setClonesRow)
  const selected = focus?.owner === owner ? Math.min(focus.row, rows.length - 1) : 0
  const select = (row: number) => setFocus({ owner, row })
  const paths = alongShapes(shapes)

  const change = (next: readonly RowArg[], path: string, gesture?: string) =>
    onChange(next, path, gesture)
  const setField = (i: number, key: string, value: unknown, gesture?: string) =>
    change(
      rows.map((r, k) => (k === i ? ({ ...r, [key]: value } as RowArg) : r)),
      `rows.${i}.${key}`,
      gesture,
    )
  const [announcement, setAnnouncement] = useState('')
  /** Row `i` to index `to`: one change; the moved row is selected. */
  const moveTo = (i: number, to: number) => {
    if (to < 0 || to >= rows.length || to === i) return false
    change(moveItem(rows, i, to), 'rows')
    select(to)
    setAnnouncement(r.moved(c.rowNamed(i), to + 1, rows.length))
    return true
  }
  const reorder = useReorder({
    count: rows.length,
    order: JSON.stringify(rows),
    onMove: moveTo,
  })
  const { attachList } = reorder
  const move = (i: number, by: -1 | 1) => {
    const to = i + by
    if (to < 0 || to >= rows.length) return
    reorder.glide(i, to)
    moveTo(i, to)
  }
  const remove = (i: number) => {
    if (rows.length <= 1) return
    change(
      rows.filter((_, k) => k !== i),
      'rows',
    )
    select(Math.max(0, Math.min(i, rows.length - 2)))
  }
  const add = (kind: CloneRowKind) => {
    const row = newRow(kind, step, units, lastAt, shapes)
    if (row === undefined) return
    change([...rows, row], 'rows')
    select(rows.length)
  }
  const onKey = (e: KeyboardEvent, i: number) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    move(i, e.key === 'ArrowUp' ? -1 : 1)
  }

  const messagesAt = (path: string): FieldMessage[] =>
    errors
      .filter((e) => e.path === path)
      .map((e, k) => ({ id: `${path}-${k}`, severity: 'error', text: e.text }))
  const overAt = (i: number, key: string): FieldMessage[] =>
    over !== undefined && over.row === i && countField(rows[i]!) === key
      ? [
          {
            id: `over-${i}`,
            severity: 'error',
            text: c.overLimit(over.actual, over.actual - over.excess, over.excess),
          },
        ]
      : []

  const quantity = (source: unknown, kind: 'length' | 'angle'): Quantity | undefined => {
    if (typeof source !== 'string') return undefined
    const q = quantityFromSource(source, fieldContext(kind, units), resolver ?? NO_REFERENCES)
    return q.isOk() ? q.unwrap() : undefined
  }
  const countValue = (n: unknown): Quantity | undefined => {
    if (typeof n !== 'number') return undefined
    const q = quantityFromSource(String(n), fieldContext('scalar', units), NO_REFERENCES)
    return q.isOk() ? q.unwrap() : undefined
  }

  const fields = (row: RowArg, i: number) => {
    const out: React.JSX.Element[] = []
    if (row.kind === 'along') {
      const by: 'spacing' | 'count' = row['count'] !== undefined ? 'count' : 'spacing'
      const shapeText = rowFieldText('along', 'shape', axes)
      const countText = rowFieldText('along', 'count', axes)
      const spacingText = rowFieldText('along', 'spacing', axes)
      out.push(
        <Field
          key="shape"
          label={shapeText.label}
          illustration={<FieldIcon name={shapeText.icon} />}
          messages={messagesAt(`rows.${i}.shapeId`)}
          {...infoOf(shapeText)}
        >
          <Select
            options={paths.map((s) => ({ value: s.id, label: s.name }))}
            value={String(row['shapeId'])}
            onValueChange={(id) => setField(i, 'shapeId', id)}
          />
        </Field>,
        <SegmentedControl
          key="by"
          label={c.fields.by}
          size="sm"
          options={[
            { value: 'spacing', label: c.fields.spacing },
            { value: 'count', label: c.fields.count },
          ]}
          value={by}
          onValueChange={(v) => {
            if (v === by) return
            const { spacing: _s, count: _c, ...rest } = row
            const next =
              v === 'count'
                ? { ...rest, count: 3 }
                : { ...rest, spacing: `${step} ${units === 'mm' ? 'mm' : 'in'}` }
            change(
              rows.map((r, k) => (k === i ? (next as RowArg) : r)),
              `rows.${i}.${v}`,
            )
          }}
        />,
      )
      out.push(
        by === 'count' ? (
          <QuantityInput
            key="count"
            label={countText.label}
            kind="scalar"
            defaultUnit="1"
            value={countValue(row['count'])}
            validate={whole}
            onCommit={(q) => setField(i, 'count', q.canonical)}
            stepKind="count"
            stepMax={100}
            {...infoOf(countText)}
            illustration={<FieldIcon name={countText.icon} />}
            messages={[...messagesAt(`rows.${i}.count`), ...overAt(i, 'count')]}
          />
        ) : (
          <QuantityInput
            key="spacing"
            label={spacingText.label}
            illustration={<FieldIcon name={spacingText.icon} />}
            kind="length"
            defaultUnit={fieldContext('length', units).defaultUnit}
            value={quantity(row['spacing'], 'length')}
            stepKind="xy"
            {...infoOf(spacingText)}
            onCommit={(q, gesture) => setField(i, 'spacing', q.source, gesture)}
            onCancelGesture={onCancelGesture}
            messages={[...messagesAt(`rows.${i}.spacing`), ...overAt(i, 'spacing')]}
            {...(resolver ? { resolver } : {})}
          />
        ),
      )
    }
    for (const f of ROW_FIELD_ORDER[row.kind]) {
      const text = rowFieldText(row.kind, f.key, axes)
      const label = text.label
      const illustration = <FieldIcon name={text.icon} />
      const path = `rows.${i}.${f.key}`
      const messages = [...messagesAt(path), ...overAt(i, f.key)]
      const info = infoOf(text)
      if (f.kind === 'count')
        out.push(
          <QuantityInput
            key={f.key}
            label={label}
            illustration={illustration}
            kind="scalar"
            defaultUnit="1"
            value={countValue(row[f.key])}
            validate={whole}
            onCommit={(q) => setField(i, f.key, q.canonical)}
            stepKind="count"
            stepMax={100}
            {...info}
            messages={messages}
          />,
        )
      else if (row.kind === 'along' && f.key === 'start')
        out.push(
          <QuantityInput
            key={f.key}
            label={label}
            illustration={illustration}
            kind="length"
            defaultUnit={fieldContext('length', units).defaultUnit}
            value={quantity(row['start'], 'length')}
            stepKind="xy"
            {...info}
            optional
            placeholder="0"
            onCommit={(q, gesture) => {
              if (q === undefined) {
                const { start: _, ...rest } = row
                change(
                  rows.map((r, k) => (k === i ? (rest as RowArg) : r)),
                  path,
                )
              } else setField(i, 'start', q.source, gesture)
            }}
            onCancelGesture={onCancelGesture}
            messages={messages}
            {...(resolver ? { resolver } : {})}
          />,
        )
      else
        out.push(
          <QuantityInput
            key={f.key}
            label={label}
            illustration={illustration}
            kind={f.kind}
            defaultUnit={fieldContext(f.kind, units).defaultUnit}
            value={quantity(row[f.key], f.kind)}
            stepKind={f.kind === 'angle' ? 'rotation' : 'xy'}
            {...info}
            onCommit={(q, gesture) => setField(i, f.key, q.source, gesture)}
            onCancelGesture={onCancelGesture}
            messages={messages}
            {...(resolver ? { resolver } : {})}
          />,
        )
    }
    return out
  }

  return (
    <div className={styles['cloneRows']}>
      <ol
        ref={attachList}
        className={`${styles['cloneRowList']} ${reorder.listClass}`}
        aria-label={c.rowList}
        {...reorder.listProps}
      >
        {rows.map((row, i) => {
          const open = i === selected
          const kind = c.kinds[row.kind] ?? row.kind
          const skipped = skippedNumbers(data, i)
          const rowErrors = errors.some((e) => e.path.startsWith(`rows.${i}.`)) || over?.row === i
          return (
            <li
              key={i}
              {...reorder.itemProps(i)}
              className={styles['cloneRow']}
              data-open={open || undefined}
              data-invalid={rowErrors || undefined}
            >
              <div className={styles['cloneRowHead']}>
                <button
                  type="button"
                  className={styles['cloneRowSelect']}
                  aria-expanded={open}
                  aria-label={`${c.rowName(i, kind)}, ${rowSummary(row, rowPositions(data, i), shapes)}`}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  onClick={() => select(i)}
                  onKeyDown={(e) => onKey(e, i)}
                >
                  <Icon name={ROW_ICON[row.kind]} />
                  <span className={styles['cloneRowText']}>
                    {rowSummary(row, rowPositions(data, i), shapes)}
                  </span>
                </button>
                <span className={styles['cloneRowActions']}>
                  {rows.length > 1 ? <DragGrip title={r.grip} {...reorder.gripProps(i)} /> : null}
                  <IconButton
                    label={c.remove(i)}
                    icon={<Icon name="delete" />}
                    {...(rows.length <= 1 ? { 'aria-disabled': true, title: c.removeLast } : {})}
                    onClick={() => remove(i)}
                  />
                </span>
              </div>
              {open ? (
                <div className={styles['cloneRowFields']}>
                  {fields(row, i)}
                  {skipped.length > 0 ? (
                    <div className={styles['cloneSkipped']}>
                      <span className={styles['muted']}>{c.skipped}</span>
                      <ul className={styles['cloneChips']}>
                        {skipped.map((n) => (
                          <li key={n}>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={c.restoreChip(n)}
                              onClick={() => onRestore(n)}
                            >
                              {n} ×
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ol>
      <ReorderStatus refusal={undefined} announcement={announcement} />
      <Menu
        label={c.addRow}
        items={ROW_KINDS.map((k) => ({
          label: c.kinds[k] ?? k,
          icon: <Icon name={ROW_ICON[k]} />,
          onSelect: () => add(k),
          disabledReason: k === 'along' && paths.length === 0 ? c.alongNoShape : undefined,
        }))}
      >
        <Button size="sm" icon={<Icon name="add" />}>
          {c.addRow}
        </Button>
      </Menu>
    </div>
  )
}
