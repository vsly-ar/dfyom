// The Shape Editor's inspector (task U1): the shape's name, the item list (`ShapeItemList`: op,
// kind and label, move and remove), the selected item's fields (every commit one
// `design.shape.item.update`, issues at their field), the path's segment table and the summary
// from `design.shape.get` (area, size, smallest inside radius). Item values come from the replica;
// the summary and the shape's users from the query.
// Doc: docs/conventions/ui.md#shape-editor, docs/modes/design-v0.3.md#shape-definition
import { useState } from 'react'
import type {
  ShapeDTO,
  ShapeItemDTO,
  ShapeItemKind,
  ShapeOp,
} from '../../../../core/design/shape.dto'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import type { QuantityKind } from '../../../../core/quantity/units'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { shapeMessages } from '../../messages/shape'
import { useCancelGesture } from '../../shell/hooks'
import { useRegion2d, useShell, useUi } from '../../shell/ShellContext'
import { chainBounds } from '../../../../core/geometry/2d/model'
import {
  Icon,
  ErrorMessage,
  Field,
  FieldIcon,
  IconButton,
  Menu,
  PanelHeader,
  QuantityInput,
  SegmentedControl,
  Switch,
  type FieldIconName,
  type FieldMessage,
} from '../../ui'
import styles from './Design.module.css'
import { defaultUnit, quantityOf, type DesignPart } from './model'
import { NameField } from './NameField'
import { SegmentTable } from './SegmentTable'
import { ImportReportDialog } from './ImportReportDialog'
import { addShapeEntries } from './ShapeList'
import { shapeLoops } from './ShapePicker'
import { ShapeKindIcon } from './ShapeKindIcon'
import {
  endVertex,
  fieldUpdate,
  issueField,
  itemNumbers,
  itemSources,
  newItemArgs,
} from './shape-model'
import { useCommand } from './useDesign'
import { useShapeInfo } from './useShapes'

const t = shapeMessages.inspector
const sentence = (s: string) => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1))

/** A command error's issues by field of item `n` (`center.0`, `segments.2.radius`); the rest at the top. */
export interface ShapeFieldErrors {
  readonly index: number
  readonly byField: ReadonlyMap<string, string>
  readonly summary: AppErrorData | undefined
}

export function placeShapeErrors(error: AppErrorData, index: number): ShapeFieldErrors {
  const byField = new Map<string, string>()
  let rest = false
  for (const issue of error.issues) {
    const f = issueField(issue, index)
    if (f === undefined || f === '') rest = true
    else if (!byField.has(f)) byField.set(f, sentence(issue.message))
  }
  return { index, byField, summary: rest || byField.size === 0 ? error : undefined }
}

/** Sends one item edit; its errors show at the field. */
export interface ItemEditContext {
  readonly part: DesignPart
  readonly shape: ShapeDTO
  readonly index: number
  readonly dto: ShapeItemDTO
  readonly errors: ShapeFieldErrors | undefined
  send(fields: Record<string, unknown>, gesture?: string): void
  cancelGesture(gesture: string): Promise<boolean>
}

export function ShapeInspector({
  part,
  shape,
}: {
  part: DesignPart
  shape: ShapeDTO
}): React.JSX.Element {
  const call = useCommand()
  const cancelGesture = useCancelGesture()
  const { ui } = useShell()
  const info = useShapeInfo(part, shape.id)
  const editor = useUi((s) => s.shapeEditor)
  const [errors, setErrors] = useState<ShapeFieldErrors | undefined>(undefined)
  const [top, setTop] = useState<AppErrorData | undefined>(undefined)
  const index = Math.min(editor?.shapeId === shape.id ? editor.item : 0, shape.items.length - 1)
  const dto = shape.items[index]!
  const selectItem = (n: number, segment: number | null = null) =>
    ui.getState().selectShapeItem(shape.id, n, segment)

  const sendItem = async (n: number, fields: Record<string, unknown>, gesture?: string) => {
    const r = await call(
      'design.shape.item.update',
      { partId: part.dto.id, shapeId: shape.id, index: n, ...fields },
      gesture === undefined ? undefined : { gesture },
    )
    if (r.ok) {
      setErrors(undefined)
      ui.getState().setShapeIssues(null)
    } else {
      setErrors(placeShapeErrors(r.error, n))
      ui.getState().setShapeIssues({ shapeId: shape.id, issues: r.error.issues })
    }
  }
  /** Replaces the item list (move, remove, add): one `design.shape.update`. */
  const sendItems = async (items: unknown[], select?: number) => {
    const r = await call('design.shape.update', {
      partId: part.dto.id,
      shapeId: shape.id,
      items,
    })
    setTop(r.ok ? undefined : r.error)
    if (r.ok && select !== undefined) selectItem(select)
  }
  const sources = () => shape.items.map((i) => itemSources(i) as unknown)
  const move = (n: number, by: -1 | 1) => {
    const to = n + by
    if (to < 0 || to >= shape.items.length) return
    const list = sources()
    const [it] = list.splice(n, 1)
    list.splice(to, 0, it)
    // the first item always adds: one moved to the top becomes add, the one it displaces keeps its op
    ;(list[0] as { op: ShapeOp }).op = 'add'
    void sendItems(list, to)
  }
  const remove = (n: number) => {
    if (shape.items.length <= 1) return
    const list = sources()
    list.splice(n, 1)
    ;(list[0] as { op: ShapeOp }).op = 'add'
    void sendItems(list, Math.max(0, Math.min(index, list.length - 1)))
  }
  const addItem = (kind: ShapeItemKind) =>
    void sendItems([...sources(), newItemArgs(kind, part.units)], shape.items.length)

  const ctx: ItemEditContext = {
    part,
    shape,
    index,
    dto,
    errors: errors?.index === index ? errors : undefined,
    send: (fields, gesture) => void sendItem(index, fields, gesture),
    cancelGesture,
  }
  const resolved = info?.resolved
  const holes = resolved?.pieces?.reduce((s, p) => s + p.holes.length, 0) ?? 0

  return (
    <div className={styles['inspector']}>
      <PanelHeader
        title={shape.name}
        itemId={shape.id}
        actions={<LastImportButton part={part} shapeId={shape.id} />}
      />
      <div className={styles['fields']}>
        {top ? <ErrorMessage error={top} message={t.commandFailed} /> : null}
        {errors?.summary ? <ErrorMessage error={errors.summary} message={t.commandFailed} /> : null}
        <NameField
          label={t.name}
          name={shape.name}
          onCommit={(name) =>
            void call('design.shape.update', { partId: part.dto.id, shapeId: shape.id, name })
          }
        />
        <section className={styles['group']} aria-label={t.items}>
          <div className={styles['groupHead']}>
            <h3 className={styles['groupTitle']}>{t.items}</h3>
            <Menu
              label={t.addItem}
              items={addShapeEntries(addItem).filter((e) => e !== 'separator')}
            >
              <IconButton label={t.addItem} icon={<Icon name="add" />} />
            </Menu>
          </div>
          <ShapeItemList
            shape={shape}
            selected={index}
            units={part.units}
            onSelect={(n) => selectItem(n)}
            onOp={(n, op) => void sendItem(n, { op })}
            onMove={move}
            onRemove={remove}
          />
        </section>
        <section className={styles['group']} aria-label={t.fields}>
          <h3 className={styles['groupTitle']}>{t.itemLabel(dto.kind, index + 1)}</h3>
          <ItemFields ctx={ctx} />
        </section>
        {dto.kind === 'path' ? (
          <SegmentTable
            ctx={ctx}
            selected={editor?.shapeId === shape.id ? editor.segment : null}
            onSelect={(k) => selectItem(index, k)}
          />
        ) : null}
        <section className={styles['group']} aria-label={t.summary}>
          <h3 className={styles['groupTitle']}>{t.summary}</h3>
          {info?.issues !== undefined && info.issues.length > 0 ? (
            <p className={styles['shapeInvalid']} role="status">
              {t.invalid}
            </p>
          ) : null}
          {resolved !== undefined ? (
            <dl className={styles['facts']}>
              <dt>{resolved.kind === 'path' ? t.pathLength : t.area}</dt>
              <dd>
                {resolved.kind === 'path'
                  ? shapeMessages.view.chipLength('length', resolved.length, part.units).slice(2)
                  : t.areaText(resolved.area, part.units)}
              </dd>
              <dt>{t.size}</dt>
              <dd>
                {t.sizeText(
                  resolved.bounds.max[0] - resolved.bounds.min[0],
                  resolved.bounds.max[1] - resolved.bounds.min[1],
                  part.units,
                )}
              </dd>
              {resolved.kind === 'region' ? (
                <>
                  <dt>{t.insideRadius}</dt>
                  <dd>
                    {resolved.smallestInsideRadius === undefined
                      ? t.noInside
                      : resolved.smallestInsideRadius === 0
                        ? t.sharp
                        : shapeMessages.view
                            .chipLength('radius', resolved.smallestInsideRadius, part.units)
                            .slice(2)}
                  </dd>
                  <dt>{t.elements}</dt>
                  <dd>
                    {resolved.elements} · {t.loops(resolved.pieces?.length ?? 0, holes)}
                  </dd>
                </>
              ) : null}
            </dl>
          ) : null}
        </section>
      </div>
    </div>
  )
}

// ── item list ───────────────────────────────────────────────────────────────────────────────

export function itemSummaryText(dto: ShapeItemDTO, units: DesignPart['units']): string {
  const n = itemNumbers(dto)
  if (n === undefined) return shapeMessages.kinds[dto.kind]
  switch (n.kind) {
    case 'rectangle':
    case 'obround':
      return t.itemSummary({ kind: n.kind, length: n.length, width: n.width }, units)
    case 'circle':
      return t.itemSummary({ kind: 'circle', diameter: n.diameter }, units)
    case 'polygon':
      return t.itemSummary({ kind: 'polygon', sides: n.sides, diameter: n.diameter }, units)
    case 'path':
      return t.itemSummary({ kind: 'path', segments: n.segments.length, closed: n.closed }, units)
  }
}

export function ShapeItemList({
  shape,
  selected,
  units,
  onSelect,
  onOp,
  onMove,
  onRemove,
}: {
  shape: ShapeDTO
  selected: number
  units: DesignPart['units']
  onSelect(n: number): void
  onOp(n: number, op: ShapeOp): void
  onMove(n: number, by: -1 | 1): void
  onRemove(n: number): void
}): React.JSX.Element {
  const count = shape.items.length
  return (
    <ol className={styles['items']} aria-label={t.itemsLabel}>
      {shape.items.map((item, n) => {
        const label = t.itemLabel(item.kind, n + 1)
        return (
          <li key={n} className={styles['item']} data-selected={n === selected ? '' : undefined}>
            <button
              type="button"
              className={styles['itemSelect']}
              aria-pressed={n === selected}
              aria-label={`${label}: ${itemSummaryText(item, units)}`}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              onClick={() => onSelect(n)}
              onKeyDown={(e) => {
                if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                  e.preventDefault()
                  onMove(n, e.key === 'ArrowUp' ? -1 : 1)
                }
              }}
            >
              <ShapeKindIcon kind={item.kind} />
              <span className={styles['opName']}>{itemSummaryText(item, units)}</span>
            </button>
            <SegmentedControl
              label={`${t.op}: ${label}`}
              size="sm"
              className={styles['itemOp']}
              options={(['add', 'subtract', 'intersect'] as const).map((op) => ({
                value: op,
                label: t.ops[op],
                disabled: n === 0 && op !== 'add',
              }))}
              value={item.op}
              disabled={n === 0}
              onValueChange={(op) => onOp(n, op)}
            />
            <span className={styles['itemActions']}>
              <IconButton
                label={t.moveUp(label)}
                icon={<Icon name="arrow-up" />}
                shortcut="Alt+↑"
                disabled={n === 0}
                onClick={() => onMove(n, -1)}
              />
              <IconButton
                label={t.moveDown(label)}
                icon={<Icon name="arrow-down" />}
                shortcut="Alt+↓"
                disabled={n === count - 1}
                onClick={() => onMove(n, 1)}
              />
              <IconButton
                label={count <= 1 ? `${t.removeItem(label)}. ${t.lastItem}` : t.removeItem(label)}
                icon={<Icon name="delete" />}
                disabled={count <= 1}
                onClick={() => onRemove(n)}
              />
            </span>
          </li>
        )
      })}
    </ol>
  )
}

// ── fields ──────────────────────────────────────────────────────────────────────────────────

const KIND_OF: Record<string, QuantityKind> = { rotation: 'angle', sides: 'scalar' }

/** One quantity field of the selected item (`path` inside the item: `center.0`, `length`). */
export function ItemQuantity({
  ctx,
  path,
  label,
  icon,
  optional = false,
  compact = false,
}: {
  ctx: ItemEditContext
  path: readonly (string | number)[]
  label: string
  icon?: FieldIconName
  /** Absent means 0 (rotation, polygon corner radius): an emptied field commits 0. */
  optional?: boolean
  /** A segment table cell: no illustration, the label for screen readers only. */
  compact?: boolean
}): React.JSX.Element {
  const key = path.join('.')
  let q: unknown = ctx.dto
  for (const seg of path) q = (q as Record<string | number, unknown> | undefined)?.[seg]
  const dto = q as QuantityDTO | undefined
  const kind = KIND_OF[String(path[0])] ?? 'length'
  const unitKind = kind === 'angle' ? 'angle' : kind === 'scalar' ? 'scalar' : 'length'
  const error = ctx.errors?.byField.get(key)
  const messages: FieldMessage[] = error
    ? [{ id: `error:${key}`, severity: 'error', text: error }]
    : []
  const commit = (source: string, gesture?: string) =>
    ctx.send(fieldUpdate(ctx.dto, path, source), gesture)
  const common = {
    label,
    kind,
    defaultUnit: defaultUnit(unitKind, ctx.part.units),
    value: dto === undefined ? undefined : quantityOf(dto),
    onCancelGesture: ctx.cancelGesture,
    messages,
    ...(ctx.part.table ? { resolver: ctx.part.table.resolver(0) } : {}),
    ...(icon && !compact ? { illustration: <FieldIcon name={icon} /> } : {}),
    ...(compact ? { className: styles['cellInput'], dense: true } : {}),
  }
  return optional ? (
    <QuantityInput
      {...common}
      optional
      placeholder={t.noneZero}
      onCommit={(v, gesture) => commit(v?.source ?? '0', gesture)}
    />
  ) : (
    <QuantityInput {...common} onCommit={(v, gesture) => commit(v.source, gesture)} />
  )
}

function ItemFields({ ctx }: { ctx: ItemEditContext }): React.JSX.Element {
  const item = ctx.dto
  const centre = (
    <div className={styles['pair']}>
      <ItemQuantity ctx={ctx} path={['center', 0]} label={t.centerX} />
      <ItemQuantity ctx={ctx} path={['center', 1]} label={t.centerY} />
    </div>
  )
  switch (item.kind) {
    case 'rectangle':
      return (
        <>
          {centre}
          <ItemQuantity ctx={ctx} path={['length']} label={t.length} icon="length" />
          <ItemQuantity ctx={ctx} path={['width']} label={t.width} icon="width" />
          <ItemQuantity ctx={ctx} path={['cornerRadius']} label={t.cornerRadius} icon="corner" />
          <ItemQuantity ctx={ctx} path={['rotation']} label={t.rotation} optional />
        </>
      )
    case 'circle':
      return (
        <>
          {centre}
          <ItemQuantity ctx={ctx} path={['diameter']} label={t.diameter} icon="width" />
        </>
      )
    case 'obround':
      return (
        <>
          {centre}
          <ItemQuantity ctx={ctx} path={['length']} label={t.length} icon="length" />
          <ItemQuantity ctx={ctx} path={['width']} label={t.width} icon="width" />
          <ItemQuantity ctx={ctx} path={['rotation']} label={t.rotation} optional />
        </>
      )
    case 'polygon':
      return (
        <>
          {centre}
          <ItemQuantity ctx={ctx} path={['sides']} label={t.sides} />
          <ItemQuantity ctx={ctx} path={['diameter']} label={t.diameter} icon="width" />
          <Field label={t.across} kind="toggle">
            <SegmentedControl
              label={t.across}
              size="sm"
              options={[
                { value: 'corners', label: t.acrossCorners },
                { value: 'flats', label: t.acrossFlats },
              ]}
              value={item.across ?? 'corners'}
              onValueChange={(across) => ctx.send({ across })}
            />
          </Field>
          <ItemQuantity
            ctx={ctx}
            path={['cornerRadius']}
            label={t.cornerRadius}
            icon="corner"
            optional
          />
          <ItemQuantity ctx={ctx} path={['rotation']} label={t.rotation} optional />
        </>
      )
    case 'path': {
      const n = itemNumbers(item)
      const closingLine =
        n?.kind === 'path' && n.closed && endVertex(n, n.segments.length - 1) !== 0
      const error = ctx.errors?.byField.get('closed')
      return (
        <>
          <div className={styles['pair']}>
            <ItemQuantity ctx={ctx} path={['start', 0]} label={t.startX} />
            <ItemQuantity ctx={ctx} path={['start', 1]} label={t.startY} />
          </div>
          <Field
            label={t.closed}
            kind="toggle"
            messages={error ? [{ id: 'error:closed', severity: 'error', text: error }] : []}
          >
            <Switch
              label={t.closed}
              hideLabel
              checked={item.closed}
              onCheckedChange={(closed) => ctx.send({ closed })}
            />
          </Field>
          {closingLine ? <StartFillet ctx={ctx} /> : null}
        </>
      )
    }
  }
}

/** The fillet at vertex 0 of a closed path that closes with a line (no segment row ends there). */
function StartFillet({ ctx }: { ctx: ItemEditContext }): React.JSX.Element | null {
  const item = ctx.dto
  if (item.kind !== 'path') return null
  const at = (item.fillets ?? []).findIndex((f) => f.vertex === 0)
  if (at < 0)
    return (
      <QuantityInput
        label={t.startFillet}
        kind="length"
        defaultUnit={defaultUnit('length', ctx.part.units)}
        value={undefined}
        optional
        placeholder={t.noneZero}
        illustration={<FieldIcon name="corner" />}
        onCommit={(v) => {
          if (v === undefined) return
          ctx.send({
            fillets: [
              ...((itemSources(item) as { fillets?: unknown[] }).fillets ?? []),
              { vertex: 0, radius: v.source },
            ],
          })
        }}
      />
    )
  return (
    <ItemQuantity ctx={ctx} path={['fillets', at, 'radius']} label={t.startFillet} icon="corner" />
  )
}

/**
 * "Import report" while the window is open and the last import made this shape (ui.md#import-report,
 * "Later access"); reports are not persisted.
 */
function LastImportButton({
  part,
  shapeId,
}: {
  part: DesignPart
  shapeId: string
}): React.JSX.Element | null {
  const last = useUi((s) => s.lastImport)
  const port = useRegion2d()
  const [open, setOpen] = useState(false)
  if (last === null || !last.shapeIds.includes(shapeId)) return null
  const shapes = last.shapeIds.flatMap((id) => part.dto.shapes?.filter((s) => s.id === id) ?? [])
  const loops = shapes.flatMap((s) => shapeLoops(port, s))
  return (
    <>
      <IconButton
        label={shapeMessages.importReport.reopen}
        icon={<Icon name="report" />}
        onClick={() => setOpen(true)}
      />
      {open ? (
        <ImportReportDialog
          open
          onOpenChange={setOpen}
          units={part.units}
          step={{
            kind: 'report',
            report: last.report,
            shapes: shapes.map((s) => s.name),
            ...(loops.length > 0
              ? { preview: { loops, bounds: chainBounds(loops.flatMap((l) => l.elements)) } }
              : {}),
          }}
          onEdit={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}
