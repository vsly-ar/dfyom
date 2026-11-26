// The Shape Editor's inspector (task U1): the shape's name, the item list (`ShapeItemList`: op,
// kind and label, drag grip (D45; Alt+↑/↓) and remove), the selected item's fields (every commit one
// `design.shape.item.update`, issues at their field), the path's segment table and the summary
// from `design.shape.get` (area, size, smallest inside radius). Item values come from the replica;
// the summary and the shape's users from the query. The header has "Import SVG…" (DF49: into new
// shapes, the report's "Edit shape" opens the first) and "Import report" for an imported shape.
// Doc: docs/conventions/ui.md#shape-editor, #reordering-lists-d45, #import-svg-where-it-is-looked-for-df49,
// docs/modes/design-v0.3.md#shape-definition
import { useRef, useState } from 'react'
import type { ShapeDTO, ShapeItemDTO, ShapeOp } from '../../../../core/design/shape.dto'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import type { QuantityKind } from '../../../../core/quantity/units'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { designMessages } from '../../messages/design'
import { shapeMessages } from '../../messages/shape'
import { useCancelGesture } from '../../shell/hooks'
import { useRegion2d, useShell, useUi } from '../../shell/ShellContext'
import { chainBounds } from '../../../../core/geometry/2d/model'
import {
  DragGrip,
  Icon,
  ErrorMessage,
  Field,
  FieldIcon,
  FieldInput,
  IconButton,
  Menu,
  moveItem,
  PanelHeader,
  QuantityInput,
  ReorderStatus,
  SegmentedControl,
  Switch,
  useReorder,
  type FieldIconName,
  type FieldMessage,
  type StepKind,
  InspectorGroup,
} from '../../ui'
import styles from './Design.module.css'
import { defaultUnit, quantityOf, type DesignPart } from './model'
import { NameField } from './NameField'
import { SegmentTable } from './SegmentTable'
import { ImportReportDialog } from './ImportReportDialog'
import { addShapeEntries, useSvgImport } from './ShapeList'
import { shapeLoops } from './ShapePicker'
import { ShapeKindIcon } from './ShapeKindIcon'
import {
  endVertex,
  fieldUpdate,
  issueField,
  itemNumbers,
  itemSources,
  newItemArgs,
  type DrawnItemKind,
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
  const svg = useSvgImport(part)
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
    return r.ok
  }
  const sources = () => shape.items.map((i) => itemSources(i) as unknown)
  /** Item `n` to index `to` (a drop or Alt+↑/↓): one `design.shape.update`; false: refused. */
  const move = async (n: number, to: number) => {
    if (to < 0 || to >= shape.items.length || to === n) return false
    const list = moveItem(sources(), n, to)
    // the first item always adds: one moved to the top becomes add, the one it displaces keeps its op
    ;(list[0] as { op: ShapeOp }).op = 'add'
    return sendItems(list, to)
  }
  const remove = async (n: number) => {
    if (shape.items.length <= 1) return false
    const list = sources()
    list.splice(n, 1)
    ;(list[0] as { op: ShapeOp }).op = 'add'
    return sendItems(list, Math.max(0, Math.min(index, list.length - 1)))
  }
  const addItem = (kind: DrawnItemKind) =>
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
        actions={
          <>
            <IconButton
              label={shapeMessages.navigator.importSvg}
              icon={<Icon name="shape-import" />}
              onClick={svg.start}
            />
            <LastImportButton part={part} shapeId={shape.id} />
          </>
        }
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
        <InspectorGroup
          title={t.items}
          actions={
            <Menu label={t.addItem} items={addShapeEntries(addItem)}>
              <IconButton label={t.addItem} icon={<Icon name="add" />} />
            </Menu>
          }
        >
          <ShapeItemList
            shape={shape}
            selected={index}
            units={part.units}
            onSelect={(n) => selectItem(n)}
            onOp={(n, op) => void sendItem(n, { op })}
            onMove={move}
            onRemove={remove}
          />
        </InspectorGroup>
        <InspectorGroup title={t.fields} heading={t.itemLabel(dto.kind, index + 1)}>
          <ItemFields ctx={ctx} />
        </InspectorGroup>
        {dto.kind === 'path' ? (
          <SegmentTable
            ctx={ctx}
            selected={editor?.shapeId === shape.id ? editor.segment : null}
            onSelect={(k) => selectItem(index, k)}
          />
        ) : null}
        <InspectorGroup title={t.summary}>
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
        </InspectorGroup>
      </div>
      {svg.dialog}
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
    case 'offset':
      return t.itemSummary(
        { kind: 'offset', distance: n.distance, direction: n.direction, source: n.shapeId },
        units,
      )
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
  /** Item `n` to index `to`; resolves false when refused. */
  onMove(n: number, to: number): Promise<boolean>
  /** Removes item `n`; resolves false when refused (or it is the last item). */
  onRemove(n: number): Promise<boolean>
}): React.JSX.Element {
  const count = shape.items.length
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  /** Delete on a row or its Remove button: focus stays on the row now at `n` (the last: before it). */
  const removeAt = async (n: number, refocus: boolean) => {
    const ok = await onRemove(n)
    if (ok && refocus) buttons.current[Math.min(n, count - 2)]?.focus()
  }
  const [announcement, setAnnouncement] = useState('')
  const moveTo = async (n: number, to: number) => {
    const label = t.itemLabel(shape.items[n]!.kind, n + 1)
    const ok = await onMove(n, to)
    if (ok) setAnnouncement(designMessages.reorder.moved(label, to + 1, count))
    return ok
  }
  const reorder = useReorder({
    count,
    order: JSON.stringify(shape.items),
    onMove: moveTo,
  })
  const { attachList } = reorder
  const step = (n: number, by: -1 | 1) => {
    const to = n + by
    if (to < 0 || to >= count) return
    reorder.glide(n, to)
    void moveTo(n, to).then((ok) => (ok ? undefined : reorder.shake(n)))
  }
  return (
    <>
      <ol
        ref={attachList}
        className={`${styles['items']} ${reorder.listClass}`}
        aria-label={t.itemsLabel}
        {...reorder.listProps}
      >
        {shape.items.map((item, n) => {
          const label = t.itemLabel(item.kind, n + 1)
          return (
            <li
              key={n}
              {...reorder.itemProps(n)}
              className={styles['item']}
              data-selected={n === selected ? '' : undefined}
            >
              <button
                type="button"
                className={styles['itemSelect']}
                aria-pressed={n === selected}
                aria-label={`${label}: ${itemSummaryText(item, units)}`}
                aria-keyshortcuts={
                  count > 1 ? 'Alt+ArrowUp Alt+ArrowDown Delete' : 'Alt+ArrowUp Alt+ArrowDown'
                }
                ref={(el) => {
                  buttons.current[n] = el
                }}
                onClick={() => onSelect(n)}
                onKeyDown={(e) => {
                  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                    e.preventDefault()
                    step(n, e.key === 'ArrowUp' ? -1 : 1)
                  } else if (e.key === 'Delete' || e.key === 'Backspace') {
                    e.preventDefault()
                    if (count > 1) void removeAt(n, true)
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
                {count > 1 ? (
                  <DragGrip title={designMessages.reorder.grip} {...reorder.gripProps(n)} />
                ) : null}
                <IconButton
                  label={count <= 1 ? `${t.removeItem(label)}. ${t.lastItem}` : t.removeItem(label)}
                  icon={<Icon name="delete" />}
                  disabled={count <= 1}
                  onClick={() => void removeAt(n, true)}
                />
              </span>
            </li>
          )
        })}
      </ol>
      <ReorderStatus refusal={undefined} announcement={announcement} />
    </>
  )
}

// ── fields ──────────────────────────────────────────────────────────────────────────────────

const KIND_OF: Record<string, QuantityKind> = { rotation: 'angle', sides: 'scalar' }

/** One quantity field of the selected item (`path` inside the item: `center.0`, `length`). */
export function ItemQuantity({
  ctx,
  path,
  stepKind,
  label,
  icon,
  optional = false,
  compact = false,
}: {
  ctx: ItemEditContext
  path: readonly (string | number)[]
  /** What the field measures (inspector-layout.md § Step assignment, Shape Editor rows). */
  stepKind: StepKind
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
    stepKind,
    ...(path[0] === 'sides' ? { stepMax: 12 } : {}),
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
      <ItemQuantity
        ctx={ctx}
        path={['center', 0]}
        stepKind="xy"
        label={t.centerX}
        icon="positionX"
      />
      <ItemQuantity
        ctx={ctx}
        path={['center', 1]}
        stepKind="xy"
        label={t.centerY}
        icon="positionY"
      />
    </div>
  )
  switch (item.kind) {
    case 'rectangle':
      return (
        <>
          {centre}
          <ItemQuantity ctx={ctx} path={['length']} stepKind="xy" label={t.length} icon="length" />
          <ItemQuantity ctx={ctx} path={['width']} stepKind="xy" label={t.width} icon="width" />
          <ItemQuantity
            ctx={ctx}
            path={['cornerRadius']}
            stepKind="small"
            label={t.cornerRadius}
            icon="corner"
          />
          <ItemQuantity
            ctx={ctx}
            path={['rotation']}
            stepKind="rotation"
            label={t.rotation}
            icon="rotation"
            optional
          />
        </>
      )
    case 'circle':
      return (
        <>
          {centre}
          <ItemQuantity
            ctx={ctx}
            path={['diameter']}
            stepKind="xy"
            label={t.diameter}
            icon="diameter"
          />
        </>
      )
    case 'obround':
      return (
        <>
          {centre}
          <ItemQuantity ctx={ctx} path={['length']} stepKind="xy" label={t.length} icon="length" />
          <ItemQuantity ctx={ctx} path={['width']} stepKind="xy" label={t.width} icon="width" />
          <ItemQuantity
            ctx={ctx}
            path={['rotation']}
            stepKind="rotation"
            label={t.rotation}
            icon="rotation"
            optional
          />
        </>
      )
    case 'polygon':
      return (
        <>
          {centre}
          <ItemQuantity ctx={ctx} path={['sides']} stepKind="count" label={t.sides} />
          <ItemQuantity
            ctx={ctx}
            path={['diameter']}
            stepKind="xy"
            label={t.diameter}
            icon="diameter"
          />
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
            stepKind="small"
            label={t.cornerRadius}
            icon="corner"
            optional
          />
          <ItemQuantity
            ctx={ctx}
            path={['rotation']}
            stepKind="rotation"
            label={t.rotation}
            icon="rotation"
            optional
          />
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
            <ItemQuantity
              ctx={ctx}
              path={['start', 0]}
              stepKind="xy"
              label={t.startX}
              icon="positionX"
            />
            <ItemQuantity
              ctx={ctx}
              path={['start', 1]}
              stepKind="xy"
              label={t.startY}
              icon="positionY"
            />
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
    case 'offset': {
      // the source is changed by replacing the item (design.shape.update); "Offset…" is task U3
      const source = ctx.part.dto.shapes?.find((s) => s.id === item.shapeId)
      return (
        <>
          <Field label={t.offsetSource} readOnly info={t.offsetSourceTip}>
            <FieldInput readOnly value={source?.name ?? item.shapeId} />
          </Field>
          <ItemQuantity
            ctx={ctx}
            path={['distance']}
            stepKind="small"
            label={t.distance}
            icon="length"
          />
          <Field label={t.direction} kind="toggle">
            <SegmentedControl
              label={t.direction}
              size="sm"
              options={[
                { value: 'outward', label: t.outward },
                { value: 'inward', label: t.inward },
              ]}
              value={item.direction}
              onValueChange={(direction) => ctx.send({ direction })}
            />
          </Field>
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
        stepKind="small"
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
    <ItemQuantity
      ctx={ctx}
      path={['fillets', at, 'radius']}
      stepKind="small"
      label={t.startFillet}
      icon="corner"
    />
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
