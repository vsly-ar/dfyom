// The design navigator's operation list (task 3.6; v0.4 task U1): units in design order – plain
// operation rows and feature rows (`FeatureRow`: chevron, feature icon, name, read-out, rolled-up
// badge, failed marker). A hole's owned operations nest one indent step in; a Clones row nests
// its Source (the nested operations or source feature, editable as before) and its Clones (one
// row per instance number from 2, skipped ones muted). Feature rows are collapsed by default (per
// window, ui store `expandedFeatures`). Plain rows and feature rows reorder by dragging their grip
// (D45) and by Alt+↑/↓, over whole neighbouring spans, and remove with an undo toast; a refused
// move says why under the list and every move is announced. Rows show names, never ids (the
// name ellipsizes in the row's width; DF25 re-report). The grip sits before the row icon
// (DF24). Owned and nested rows have no actions (Alt+↑/↓ there moves the outer feature). ↑/↓ walk
// the visible rows, → expands or enters, ← collapses or goes to the parent row. Every row with an
// applicable action has the row menu (DF16: Chamfer, Make Clones…, Remove): right-click,
// Shift+F10 / the Menu key, and on top-level rows the actions (…) button.
// Doc: docs/conventions/ui.md#feature-rows-and-add, #clones-in-the-navigator,
// #reordering-lists-d45, #panels-and-inspectors, #confirmations, row menu in #feature-rows-and-add;
// docs/modes/design.md#ordering-and-composition
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import type { OperationDTO } from '../../../../core/design/part.dto'
import type { UnitSystem } from '../../../../core/project/document'
import type { DfmWarning } from '../../../../core/geometry/model'
import { designMessages } from '../../messages/design'
import { useUi } from '../../shell/ShellContext'
import {
  Button,
  ContextMenu,
  DragGrip,
  Icon,
  IconButton,
  isContextMenuKey,
  Menu,
  openContextMenu,
  ReorderStatus,
  useReorder,
  type IconName,
  type MenuEntry,
  type Reorder,
} from '../../ui'
import styles from './Design.module.css'
import {
  cloneInstances,
  featureReadout,
  featureRemoveBlocked,
  operationUnits,
  moveRefusal,
  rolledUpCount,
  roleLabel,
  unitDropIndex,
  unitDropRefusal,
  type CloneInstanceRow,
  type FeatureUnit,
  type OperationUnit,
} from './feature-view'
import type { DesignPart } from './model'
import { useCommand } from './useDesign'
import { useRowActions } from './row-actions'
import { useSkipToggle } from './ClonesInspector'
import { instanceId } from './clones-view'

const m = designMessages
const f = m.features
const r = m.reorder
const c = f.clones

const ICON: Record<OperationDTO['kind'], IconName> = {
  facing: 'facing',
  pocket: 'pocket',
  drilling: 'drilling',
  profile: 'profile',
  chamfer: 'chamfer',
}

/** A profile cut on its line is a groove (B22-5: the bent slot). */
export function operationIcon(op: OperationDTO): IconName {
  return op.kind === 'profile' && op.side === 'on' ? 'groove' : ICON[op.kind]
}

/** A feature's icon (L1, ui.md § Icons (v0.4)): the hole type, or Clones. */
export function featureIcon(feature: Pick<FeatureDTO, 'kind'> & Record<string, unknown>): IconName {
  if (feature.kind === 'clones') return 'clones'
  if (feature.kind !== 'hole') return 'design'
  return feature['type'] === 'counterbore'
    ? 'hole-counterbore'
    : feature['type'] === 'countersink'
      ? 'hole-countersink'
      : 'hole-simple'
}

/** The disclosure key of a Clones row's instance group (ui store `expandedFeatures`). */
export const instancesKey = (featureId: string): string => `${featureId}#instances`

/** A row of the visible list: what ↑/↓ walk and what → / ← act on. */
interface VisibleRow {
  readonly id: string
  /** The outermost unit (what Alt+↑/↓ moves). */
  readonly unit: string
  /** The row ← goes to. */
  readonly parent?: string | undefined
  /** The disclosure this row opens and closes (a feature id, or a Clones instance group). */
  readonly expands?: string | undefined
}

/** The visible rows of a unit, depth first. */
function visibleRows(
  unit: OperationUnit,
  expanded: ReadonlySet<string>,
  instancesOf: (featureId: string) => readonly number[],
  outer: string = unit.id,
  parent?: string,
): VisibleRow[] {
  if (unit.kind === 'operation') return [{ id: unit.id, unit: outer, parent }]
  const instanceNumbers = unit.feature.kind === 'clones' ? instancesOf(unit.id) : []
  const self: VisibleRow = { id: unit.id, unit: outer, parent, expands: unit.id }
  if (!expanded.has(unit.id)) return [self]
  if (unit.feature.kind !== 'clones')
    return [self, ...unit.ops.map((o) => ({ id: o.id, unit: outer, parent: unit.id }))]
  const group = instancesKey(unit.id)
  return [
    self,
    ...unit.nested.flatMap((n) => visibleRows(n, expanded, instancesOf, outer, unit.id)),
    { id: group, unit: outer, parent: unit.id, expands: group },
    ...(expanded.has(group)
      ? instanceNumbers.map((n) => ({ id: instanceId(unit.id, n), unit: outer, parent: group }))
      : []),
  ]
}

/** What the rows share. */
interface ListContext {
  readonly part: DesignPart
  readonly warnings: readonly DfmWarning[]
  readonly failedAt: string | undefined
  readonly selected: string | null
  readonly expanded: ReadonlySet<string>
  toggle(key: string): void
  select(id: string): void
  key(e: KeyboardEvent, rowId: string): void
  rowRef(id: string): (el: HTMLButtonElement | null) => void
  /** Focus row `id`'s button. */
  focus(id: string): void
  /** Skip or restore a clone instance (v0.4 task U3). */
  toggleSkip(feature: FeatureDTO, n: number): void
  /** The row menu of an owned or nested row (no Remove; DF16). */
  rowMenu(id: string): MenuEntry[]
}

export function OperationList({
  part,
  warnings,
  failedAt,
  selected,
  select,
  onRemoved,
}: {
  part: DesignPart
  warnings: readonly DfmWarning[]
  /** The operation an evaluation failure names. */
  failedAt: string | undefined
  selected: string | null
  select: (id: string | null) => void
  onRemoved: (message: string) => void
}): React.JSX.Element {
  const call = useCommand()
  const toggleSkip = useSkipToggle(part)
  const rowActions = useRowActions(part)
  const expanded = useUi((s) => s.expandedFeatures)
  const setExpanded = useUi((s) => s.setFeatureExpanded)
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const units = operationUnits(part)
  const partId = part.dto.id

  // a selected owned or nested operation (viewport click, breadcrumb, undo) shows inside its open
  // feature(s)
  const openFor = units
    .filter((u): u is FeatureUnit => u.kind === 'feature')
    .flatMap((u) => {
      const inner = u.nested.find(
        (n) => n.id === selected || (n.kind === 'feature' && n.ops.some((o) => o.id === selected)),
      )
      if (inner !== undefined)
        return inner.kind === 'feature' && inner.id !== selected ? [u.id, inner.id] : [u.id]
      // a selected clone instance (viewport click, breadcrumb) shows in the open Clones group
      if (u.feature.kind === 'clones' && selected?.startsWith(`${u.id}_`) === true)
        return [u.id, instancesKey(u.id)]
      return u.ops.some((o) => o.id === selected) && u.feature.kind !== 'clones' ? [u.id] : []
    })
    .join(' ')
  useEffect(() => {
    for (const id of openFor.split(' ')) if (id.length > 0) setExpanded(id, true)
  }, [openFor, setExpanded])

  const visible = units.flatMap((u) =>
    visibleRows(u, expanded, (id) => cloneInstances(part, id).map((x) => x.n)),
  )
  const focusRow = (id: string) => rows.current.get(id)?.focus()

  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  const [announcement, setAnnouncement] = useState('')
  const unitName = (u: OperationUnit) => (u.kind === 'feature' ? u.feature.name : u.op.name)

  /** Moves a unit to unit position `to`; `keep` is the row that keeps focus. False: refused. */
  const moveTo = async (unit: OperationUnit, to: number, keep: string = unit.id) => {
    const toIndex = unitDropIndex(units, unit.id, to)
    if (toIndex === undefined) return false
    const res =
      unit.kind === 'feature'
        ? await call('design.feature.move', { partId, featureId: unit.id, toIndex })
        : await call('design.operation.move', { partId, operationId: unit.id, toIndex })
    if (!res.ok) {
      const why = moveRefusal(part, res.error)
      setRefusal(why)
      setAnnouncement(why)
      return false
    }
    setRefusal(undefined)
    setAnnouncement(r.moved(unitName(unit), to + 1, units.length))
    focusRow(keep)
    return true
  }
  const reorder = useReorder({
    count: units.length,
    order: units.map((u) => u.id).join(' '),
    refusal: (from, to) => {
      const e = unitDropRefusal(part, units, units[from]!.id, to)
      return e === undefined ? undefined : moveRefusal(part, e)
    },
    onMove: (from, to) => moveTo(units[from]!, to),
    onRefused: (why) => {
      setRefusal(why)
      setAnnouncement(why)
    },
  })
  const { attachList } = reorder
  /** Alt+↑/↓: one step over the neighbouring unit, gliding; a refusal shakes the row. */
  const move = async (unit: OperationUnit, by: -1 | 1, keep: string = unit.id) => {
    const from = units.indexOf(unit)
    const to = from + by
    if (to < 0 || to >= units.length) return
    reorder.glide(from, to)
    if (!(await moveTo(unit, to, keep))) reorder.shake(from)
  }
  const remove = async (unit: OperationUnit) => {
    if (unit.kind === 'feature') {
      const r = await call('design.feature.remove', { partId, featureId: unit.id })
      if (!r.ok) return
      if (selected === unit.id || unit.ops.some((o) => o.id === selected)) select(null)
      onRemoved(f.removed(unit.feature.name, unit.ops.length))
      return
    }
    const r = await call('design.operation.remove', { partId, operationId: unit.id })
    if (!r.ok) return
    if (selected === unit.id) select(null)
    onRemoved(m.navigator.removed(unit.op.name))
  }

  const onKey = (e: KeyboardEvent, rowId: string) => {
    const row = visible.find((v) => v.id === rowId)
    const unit = units.find((u) => u.id === row?.unit)
    if (row === undefined || unit === undefined) return
    // Shift+F10 / the Menu key: the row's menu, at the row (DF16)
    if (isContextMenuKey(e)) {
      const el = e.currentTarget.closest('[data-row-menu]')
      if (el === null) return
      e.preventDefault()
      return openContextMenu(el)
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const by = e.key === 'ArrowUp' ? -1 : 1
      if (e.altKey) return void move(unit, by, row.id)
      const next = visible[visible.indexOf(row) + by]
      if (next) focusRow(next.id)
      return
    }
    if (e.altKey) return
    if (e.key === 'ArrowRight' && row.expands !== undefined) {
      e.preventDefault()
      if (!expanded.has(row.expands)) setExpanded(row.expands, true)
      else {
        const next = visible[visible.indexOf(row) + 1]
        if (next?.parent === row.id) focusRow(next.id)
      }
    } else if (e.key === 'ArrowLeft') {
      if (row.expands !== undefined && expanded.has(row.expands)) {
        e.preventDefault()
        setExpanded(row.expands, false)
      } else if (row.parent !== undefined) {
        e.preventDefault()
        focusRow(row.parent)
      }
    }
  }

  const ctx: ListContext = {
    part,
    warnings,
    failedAt,
    selected,
    expanded,
    toggle: (key) => setExpanded(key, !expanded.has(key)),
    select: (id) => select(selected === id ? null : id),
    key: onKey,
    focus: focusRow,
    rowRef: (id) => (el) => {
      if (el) rows.current.set(id, el)
      else rows.current.delete(id)
    },
    toggleSkip,
    rowMenu: (id) => rowActions(id),
  }

  return (
    <>
      <ol
        ref={attachList}
        className={`${styles['ops']} ${styles['opsGrip']} ${reorder.listClass}`}
        aria-label={m.navigator.listLabel}
        {...reorder.listProps}
      >
        {units.map((unit, i) => {
          const name = unitName(unit)
          const blocked = unit.kind === 'feature' ? featureRemoveBlocked(part, unit.id) : undefined
          const actions: RowActions = {
            item: reorder.itemProps(i),
            grip: units.length > 1 ? reorder.gripProps(i) : undefined,
            onRemove: () => void remove(unit),
            menu: rowActions(unit.id, { name, onRemove: () => void remove(unit), blocked }),
          }
          return unit.kind === 'operation' ? (
            <OperationRow key={unit.id} ctx={ctx} op={unit.op} actions={actions} />
          ) : (
            <FeatureRow key={unit.id} ctx={ctx} unit={unit} actions={actions} />
          )
        })}
      </ol>
      <ReorderStatus refusal={reorder.refusal ?? refusal} announcement={announcement} />
    </>
  )
}

interface RowActions {
  /** The row's reorder props (its `<li>`) and its grip's. */
  readonly item: ReturnType<Reorder['itemProps']>
  readonly grip: ReturnType<Reorder['gripProps']> | undefined
  onRemove(): void
  /** The row menu (DF16): the … button and right-click. */
  readonly menu: readonly MenuEntry[]
}

/**
 * A row's right-click menu (DF16) around its `.op` element, marked `data-row-menu` for the
 * Shift+F10 path; none without entries. Focus goes back to the row's button when it closes.
 */
function RowMenu({
  ctx,
  id,
  name,
  items,
  children,
}: {
  ctx: ListContext
  id: string
  name: string
  items: readonly MenuEntry[]
  children: React.JSX.Element
}): React.JSX.Element {
  if (items.length === 0) return children
  return (
    <ContextMenu
      label={m.navigator.actions(name)}
      items={items}
      onCloseAutoFocus={(e) => {
        e.preventDefault()
        ctx.focus(id)
      }}
    >
      {children}
    </ContextMenu>
  )
}

/** The grip before the row icon (DF24); a row of a one-row list keeps the empty slot. */
function RowGrip({ actions }: { actions: RowActions | undefined }): React.JSX.Element | null {
  if (actions === undefined) return null
  return actions.grip ? (
    <DragGrip title={r.grip} className={styles['rowGrip']} {...actions.grip} />
  ) : null
}

function RowMarkers({ failed, count }: { failed: boolean; count: number }): React.JSX.Element {
  return (
    <>
      {failed ? (
        <span className={styles['opFailed']} title={m.navigator.failed}>
          <Icon name="error" />
          <span className={styles['srOnly']}>{m.navigator.failed}</span>
        </span>
      ) : null}
      {count > 0 ? (
        <span className={styles['opBadge']}>
          <Icon name="warning" />
          <span aria-hidden="true">{count}</span>
          <span className={styles['srOnly']}>{m.navigator.warnings(count)}</span>
        </span>
      ) : null}
    </>
  )
}

function MoveRemove({
  name,
  actions,
  removeBlocked,
  reasonId,
}: {
  name: string
  actions: RowActions
  /** Why remove is refused (`aria-disabled`, the reason as visible text under the row). */
  removeBlocked?: string | undefined
  reasonId?: string
}): React.JSX.Element {
  return (
    <span className={styles['opActions']}>
      <Menu label={m.navigator.actions(name)} align="end" items={actions.menu}>
        <IconButton label={m.navigator.actions(name)} icon={<Icon name="more" />} />
      </Menu>
      <IconButton
        label={m.navigator.remove(name)}
        icon={<Icon name="delete" />}
        {...(removeBlocked !== undefined ? { 'aria-disabled': true } : {})}
        {...(removeBlocked !== undefined && reasonId ? { 'aria-describedby': reasonId } : {})}
        onClick={() => (removeBlocked !== undefined ? undefined : actions.onRemove())}
      />
    </span>
  )
}

/**
 * A plain operation row: top level with move and remove, or nested in a Clones' source (no
 * actions: it moves with the Clones).
 */
function OperationRow({
  ctx,
  op,
  actions,
}: {
  ctx: ListContext
  op: OperationDTO
  actions?: RowActions
}): React.JSX.Element {
  const n = rolledUpCount({ kind: 'operation', id: op.id, op, start: 0, end: 1 }, ctx.warnings)
  const menu = actions?.menu ?? ctx.rowMenu(op.id)
  return (
    <RowMenu ctx={ctx} id={op.id} name={op.name} items={menu}>
      <li
        {...actions?.item}
        className={styles['op']}
        data-nested={actions === undefined ? '' : undefined}
        data-top={actions !== undefined ? '' : undefined}
        data-row-menu={menu.length > 0 ? '' : undefined}
        data-selected={ctx.selected === op.id ? '' : undefined}
      >
        <RowGrip actions={actions} />
        <button
          type="button"
          ref={ctx.rowRef(op.id)}
          className={styles['opSelect']}
          aria-pressed={ctx.selected === op.id}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          onClick={() => ctx.select(op.id)}
          onKeyDown={(e) => ctx.key(e, op.id)}
        >
          <Icon name={operationIcon(op)} />
          <span className={styles['opName']}>{op.name}</span>
          <RowMarkers failed={ctx.failedAt === op.id} count={n} />
        </button>
        {actions ? <MoveRemove name={op.name} actions={actions} /> : null}
      </li>
    </RowMenu>
  )
}

/**
 * A feature row and, while open, its children one indent step in (ui.md § Feature rows): a hole's
 * owned operations, a Clones' Source and Clones groups. Without `actions` it is nested (a Clones'
 * source feature): no move or remove.
 */
function FeatureRow({
  ctx,
  unit,
  actions,
}: {
  ctx: ListContext
  unit: FeatureUnit
  actions?: RowActions
}): React.JSX.Element {
  const { part, selected } = ctx
  const feature = unit.feature
  const clones = feature.kind === 'clones'
  const instances = clones ? cloneInstances(part, feature.id) : []
  const readout = featureReadout(
    feature,
    clones ? 1 + instances.filter((x) => x.kind === 'clone').length : undefined,
  )
  const count = rolledUpCount(unit, ctx.warnings)
  const failed = ctx.failedAt !== undefined && unit.ops.some((o) => o.id === ctx.failedAt)
  const open = ctx.expanded.has(feature.id)
  const blocked = actions ? featureRemoveBlocked(part, feature.id) : undefined
  const menu = actions?.menu ?? ctx.rowMenu(feature.id)
  const reasonId = `${feature.id}-remove-reason`
  const childrenId = `${feature.id}-children`
  const name = f.rowName({
    name: feature.name,
    readout,
    operations: unit.ops.length,
    warnings: count,
  })
  return (
    <li
      {...actions?.item}
      className={styles['featureItem']}
      data-nested={actions === undefined ? '' : undefined}
      data-open={open || undefined}
    >
      <RowMenu ctx={ctx} id={feature.id} name={feature.name} items={menu}>
        <div
          className={styles['op']}
          data-top={actions !== undefined ? '' : undefined}
          data-row-menu={menu.length > 0 ? '' : undefined}
          data-selected={selected === feature.id ? '' : undefined}
        >
          <RowGrip actions={actions} />
          <button
            type="button"
            ref={ctx.rowRef(feature.id)}
            className={`${styles['opSelect']} ${styles['featureSelect']}`}
            aria-pressed={selected === feature.id}
            aria-expanded={open}
            aria-controls={childrenId}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown ArrowRight ArrowLeft"
            aria-label={name}
            onClick={() => ctx.select(feature.id)}
            onKeyDown={(e) => ctx.key(e, feature.id)}
          >
            <Chevron open={open} name={feature.name} onToggle={() => ctx.toggle(feature.id)} />
            <Icon name={featureIcon(feature)} />
            <span className={styles['featureText']}>
              <span className={styles['opName']}>{feature.name}</span>
              {readout.length > 0 ? (
                <span className={styles['featureReadout']}>{readout}</span>
              ) : null}
            </span>
            <RowMarkers failed={failed} count={count} />
          </button>
          {actions ? (
            <MoveRemove
              name={feature.name}
              actions={actions}
              removeBlocked={blocked}
              reasonId={reasonId}
            />
          ) : null}
          {blocked !== undefined ? (
            <p id={reasonId} className={styles['shapeReason']}>
              {blocked}
            </p>
          ) : null}
        </div>
      </RowMenu>
      {/* closed: inert (out of the tab order and the accessibility tree) while it slides shut */}
      <div className={styles['ownedWrap']} data-open={open || undefined} inert={!open}>
        <div id={childrenId} className={styles['owned']}>
          {clones ? (
            <ClonesChildren ctx={ctx} unit={unit} instances={instances} />
          ) : (
            <ol className={styles['ownedList']} aria-label={feature.name}>
              {unit.ops.map((op) => (
                <OwnedRow key={op.id} ctx={ctx} op={op} featureName={feature.name} />
              ))}
            </ol>
          )}
        </div>
      </div>
    </li>
  )
}

/** The chevron is part of the row's toggle (pointer), not a tab stop of its own (→ / ← keys). */
function Chevron({
  open,
  name,
  onToggle,
}: {
  open: boolean
  name: string
  onToggle: () => void
}): React.JSX.Element {
  return (
    <span
      className={styles['chevron']}
      data-open={open || undefined}
      title={open ? f.collapse(name) : f.expand(name)}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
    >
      <Icon name="chevron-down" />
    </span>
  )
}

/** An owned operation of a hole: role name, its own badge; no id, no actions, no action slot. */
function OwnedRow({
  ctx,
  op,
  featureName,
}: {
  ctx: ListContext
  op: OperationDTO
  featureName: string
}): React.JSX.Element {
  const n = rolledUpCount({ kind: 'operation', id: op.id, op, start: 0, end: 1 }, ctx.warnings)
  const menu = ctx.rowMenu(op.id)
  return (
    <RowMenu ctx={ctx} id={op.id} name={op.name} items={menu}>
      <li
        className={styles['op']}
        data-owned=""
        data-row-menu={menu.length > 0 ? '' : undefined}
        data-selected={ctx.selected === op.id ? '' : undefined}
      >
        <button
          type="button"
          ref={ctx.rowRef(op.id)}
          className={styles['opSelect']}
          aria-pressed={ctx.selected === op.id}
          aria-label={f.ownedName(op.name, featureName)}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown ArrowLeft"
          onClick={() => ctx.select(op.id)}
          onKeyDown={(e) => ctx.key(e, op.id)}
        >
          <Icon name={operationIcon(op)} />
          <span className={styles['opName']}>{roleLabel(featureName, op.name)}</span>
          <RowMarkers failed={ctx.failedAt === op.id} count={n} />
        </button>
      </li>
    </RowMenu>
  )
}

/** "9.00, 15.59" (mm) or "0.354, 0.614" (in): an instance's reference point. */
function position(at: CloneInstanceRow['at'], units: UnitSystem): string {
  const fmt = (mm: number) => (units === 'inch' ? (mm / 25.4).toFixed(3) : mm.toFixed(2))
  return `${fmt(at.u)}, ${fmt(at.v)}`
}

/**
 * A Clones row's children (ui.md § Clones in the navigator): Source, expanded (the nested
 * operations or source feature, editable in their own inspectors), and Clones, collapsed (one row
 * per instance number from 2; skipped and duplicate spots keep their numbered row, muted). An
 * instance row selects the instance; its action slot has Skip or Restore (U3: the keyboard path
 * of the viewport's click-to-skip).
 */
function ClonesChildren({
  ctx,
  unit,
  instances,
}: {
  ctx: ListContext
  unit: FeatureUnit
  instances: readonly CloneInstanceRow[]
}): React.JSX.Element {
  const key = instancesKey(unit.id)
  const open = ctx.expanded.has(key)
  const listId = `${unit.id}-instances`
  return (
    <>
      <p className={styles['subgroupTitle']}>{f.source}</p>
      <ol className={styles['ownedList']} aria-label={f.sourceOf(unit.feature.name)}>
        {unit.nested.map((n) =>
          n.kind === 'operation' ? (
            <OperationRow key={n.id} ctx={ctx} op={n.op} />
          ) : (
            <FeatureRow key={n.id} ctx={ctx} unit={n} />
          ),
        )}
      </ol>
      <button
        type="button"
        ref={ctx.rowRef(key)}
        className={styles['subgroupToggle']}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => ctx.toggle(key)}
        onKeyDown={(e) => ctx.key(e, key)}
      >
        <span className={styles['chevronInline']} data-open={open || undefined}>
          <Icon name="chevron-down" />
        </span>
        {f.clonesGroup}
        <span className={styles['featureReadout']}>{instances.length}</span>
      </button>
      <div className={styles['ownedWrap']} data-open={open || undefined} inert={!open}>
        <ol
          id={listId}
          className={styles['instances']}
          aria-label={f.instancesOf(unit.feature.name)}
        >
          {instances.map((x) => {
            const id = instanceId(unit.id, x.n)
            const selected = ctx.selected === id
            return (
              <li
                key={x.n}
                className={styles['instance']}
                data-muted={x.kind !== 'clone' || undefined}
                data-selected={selected ? '' : undefined}
              >
                <button
                  type="button"
                  ref={ctx.rowRef(id)}
                  className={styles['instanceSelect']}
                  aria-pressed={selected}
                  aria-label={c.instanceRow(x.n, x.kind)}
                  onClick={() => ctx.select(id)}
                  onKeyDown={(e) => ctx.key(e, id)}
                >
                  <span>{f.instance(x.n)}</span>
                  <span className={styles['featureReadout']}>
                    {x.kind === 'clone'
                      ? position(x.at, ctx.part.units)
                      : x.kind === 'skipped'
                        ? f.skipped
                        : f.duplicate}
                  </span>
                </button>
                {x.kind !== 'duplicate' ? (
                  <span className={styles['instanceActions']}>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={x.kind === 'skipped' ? c.restoreN(x.n) : c.skipN(x.n)}
                      onClick={() => ctx.toggleSkip(unit.feature, x.n)}
                    >
                      {x.kind === 'skipped' ? c.restoreLabel : c.skipLabel}
                    </Button>
                  </span>
                ) : null}
              </li>
            )
          })}
        </ol>
      </div>
    </>
  )
}
