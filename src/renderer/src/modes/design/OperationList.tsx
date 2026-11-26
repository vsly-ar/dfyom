// The design navigator's operation list (task 3.6; v0.4 task U1): units in design order – plain
// operation rows and feature rows (`FeatureRow`: chevron, feature icon, name, read-out, rolled-up
// badge, failed marker). A hole's owned operations nest one indent step in; a Clones row nests
// its Source (the nested operations or source feature, editable as before) and its Clones (one
// row per instance number from 2, skipped ones muted). Feature rows are collapsed by default (per
// window, ui store `expandedFeatures`). Plain rows and feature rows reorder by dragging their grip
// (D45) and by Alt+↑/↓, over whole neighbouring spans, and remove (row menu, Delete) with an undo
// toast; a refused move says why under the list and every move is announced. Rows show names,
// never ids (the name ellipsizes in the row's width; DF25 re-report). The grip sits before the
// row icon (DF24). Owned and nested rows have no move or remove (Alt+↑/↓ there moves the outer
// feature). ↑/↓ walk the visible rows, → expands or enters, ← collapses or goes to the parent row.
// Every row with an applicable action has the row menu (DF16: Chamfer, Make Clones…, Remove):
// right-click, Shift+F10 / the Menu key; rows have no action buttons (DF70, ui.md decision 27), so
// badges and markers never move on hover, and such rows are described by the list's hint.
// Doc: docs/conventions/ui.md#feature-rows-and-add, #clones-in-the-navigator,
// #reordering-lists-d45, #panels-and-inspectors, #confirmations, row menu in #feature-rows-and-add;
// docs/modes/design.md#ordering-and-composition
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { isDisabled, type DisabledState } from '../../../../core/design/disabled'
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
  isContextMenuKey,
  openContextMenu,
  ReorderStatus,
  useReorder,
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
  operationMoveIndex,
  rolledUpCount,
  roleLabel,
  unitDropIndex,
  unitDropRefusal,
  type CloneInstanceRow,
  type FeatureUnit,
  type OperationRowUnit,
  type OperationUnit,
} from './feature-view'
import { axisNames, disabledOf, surfaceDirection, type DesignPart } from './model'
import { useCommand } from './useDesign'
import { useRowActions } from './row-actions'
import { useSkipToggle } from './ClonesInspector'
import { instanceId } from './clones-view'
import { featureIcon, partOperationIconProps } from './operation-icon'
import { roughingToolText } from './roughing-view'

export { featureIcon, operationIcon } from './operation-icon'

const m = designMessages
const f = m.features
const r = m.reorder
const c = f.clones

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
  if (unit.kind === 'operation') {
    // DF122: a pocket's roughing row nests under it (roughing.md § UI)
    if (unit.roughing === undefined) return [{ id: unit.id, unit: outer, parent }]
    const self: VisibleRow = { id: unit.id, unit: outer, parent, expands: unit.id }
    if (!expanded.has(unit.id)) return [self]
    return [self, { id: unit.roughing.id, unit: outer, parent: unit.id }]
  }
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
  /** The id of the list's row menu hint ("Right-click or Shift+F10 for actions."; DF70). */
  readonly hintId: string
  /**
   * A split piece (split parts 4a): rows select only; no grip, row menu, Delete, Alt+↑/↓ or Skip
   * (the core refuses them with `derivedPart`; the source is edited).
   */
  readonly readOnly: boolean
  /** What is off in the part (DF106): those rows are muted with an "Off" marker. */
  readonly off: DisabledState
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
  const hintId = useId()
  const readOnly = part.dto.derivedFrom !== undefined

  // a selected owned or nested operation (viewport click, breadcrumb, undo) shows inside its open
  // feature(s)
  const openFor = units
    .flatMap((u) => {
      // DF122: a selected roughing pocket shows inside its open pocket row
      if (u.kind === 'operation') return u.roughing?.id === selected ? [u.id] : []
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
        : await call('design.operation.move', {
            partId,
            operationId: unit.id,
            toIndex: operationMoveIndex(unit, toIndex),
          })
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
    // a piece's rows only select and walk (split parts 4a)
    if (readOnly && (e.altKey || e.key === 'Delete' || e.key === 'Backspace')) {
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) e.preventDefault()
      return
    }
    // Shift+F10 / the Menu key: the row's menu, at the row (DF16)
    if (isContextMenuKey(e)) {
      const el = e.currentTarget.closest('[data-row-menu]')
      if (el === null) return
      e.preventDefault()
      return openContextMenu(el)
    }
    // Delete / Backspace on a top-level row: remove it, with the undo toast (DF70: the row menu's
    // Remove; refused silently while blocked, the reason shows under the row)
    if ((e.key === 'Delete' || e.key === 'Backspace') && row.id === unit.id) {
      e.preventDefault()
      if (unit.kind === 'feature' && featureRemoveBlocked(part, unit.id) !== undefined) return
      return void remove(unit)
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
    off: disabledOf(part),
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
    rowMenu: (id) => (readOnly ? [] : rowActions(id)),
    hintId,
    readOnly,
  }

  return (
    <>
      <ol
        ref={attachList}
        className={
          readOnly ? styles['ops'] : `${styles['ops']} ${styles['opsGrip']} ${reorder.listClass}`
        }
        aria-label={m.navigator.listLabel}
        {...(readOnly ? {} : reorder.listProps)}
      >
        {units.map((unit, i) => {
          const name = unitName(unit)
          const blocked = unit.kind === 'feature' ? featureRemoveBlocked(part, unit.id) : undefined
          const actions: RowActions = readOnly
            ? { item: undefined, grip: undefined, menu: [] }
            : {
                item: reorder.itemProps(i),
                grip: units.length > 1 ? reorder.gripProps(i) : undefined,
                menu: rowActions(unit.id, { name, onRemove: () => void remove(unit), blocked }),
              }
          return unit.kind === 'operation' ? (
            <OperationRow
              key={unit.id}
              ctx={ctx}
              op={unit.op}
              actions={actions}
              roughing={unit.roughing}
            />
          ) : (
            <FeatureRow key={unit.id} ctx={ctx} unit={unit} actions={actions} />
          )
        })}
      </ol>
      {readOnly ? null : (
        <p id={hintId} className={styles['srOnly']}>
          {m.navigator.rowMenuHint}
        </p>
      )}
      <ReorderStatus refusal={reorder.refusal ?? refusal} announcement={announcement} />
    </>
  )
}

interface RowActions {
  /** The row's reorder props (its `<li>`) and its grip's. */
  readonly item: ReturnType<Reorder['itemProps']> | undefined
  readonly grip: ReturnType<Reorder['gripProps']> | undefined
  /** The row menu (DF16): right-click, Shift+F10 / the Menu key; Remove last. */
  readonly menu: readonly MenuEntry[]
}

/**
 * The row button's keyboard props (DF70): its keys, with Shift+F10 when it has a menu and Delete
 * on top-level rows, and the list's hint (plus `reasonId`) as its description.
 */
function rowKeys(
  ctx: ListContext,
  keys: string,
  menu: readonly MenuEntry[],
  top: boolean,
  reasonId?: string,
): { 'aria-keyshortcuts': string; 'aria-describedby'?: string } {
  const moves = ctx.readOnly ? keys.replace(/Alt\+\S+ ?/g, '').trim() : keys
  const all = [moves, menu.length > 0 ? 'Shift+F10' : '', top && !ctx.readOnly ? 'Delete' : '']
  const described = [menu.length > 0 ? ctx.hintId : '', reasonId ?? ''].filter((x) => x !== '')
  return {
    'aria-keyshortcuts': all.filter((x) => x !== '').join(' '),
    ...(described.length > 0 ? { 'aria-describedby': described.join(' ') } : {}),
  }
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

/** The "Off" marker of a disabled row (DF106); its tooltip says whether it follows another item. */
function OffMarker({ ctx, id }: { ctx: ListContext; id: string }): React.JSX.Element | null {
  if (!isDisabled(ctx.off, id)) return null
  const title = ctx.off.dependants.has(id) ? m.navigator.offFollows : m.navigator.offTitle
  return (
    <span className={styles['opOff']} title={title}>
      {m.navigator.off}
      <span className={styles['srOnly']}>{`: ${title}`}</span>
    </span>
  )
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
        <span className={styles['opBadge']} title={m.navigator.warnings(count)}>
          <Icon name="warning" />
          <span aria-hidden="true">{count}</span>
          <span className={styles['srOnly']}>{m.navigator.warnings(count)}</span>
        </span>
      ) : null}
    </>
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
  roughing,
}: {
  ctx: ListContext
  op: OperationDTO
  actions?: RowActions
  /** DF122: the pocket's roughing pocket, nested under the row. */
  roughing?: OperationDTO | undefined
}): React.JSX.Element {
  if (roughing !== undefined)
    return <RoughingOwnerRow ctx={ctx} op={op} roughing={roughing} actions={actions} />
  const n = rolledUpCount({ kind: 'operation', id: op.id, op, start: 0, end: 1 }, ctx.warnings)
  const menu = actions?.menu ?? ctx.rowMenu(op.id)
  return (
    <RowMenu ctx={ctx} id={op.id} name={op.name} items={menu}>
      <li
        {...actions?.item}
        className={styles['op']}
        data-nested={actions === undefined ? '' : undefined}
        data-off={isDisabled(ctx.off, op.id) ? '' : undefined}
        data-row-menu={menu.length > 0 ? '' : undefined}
        data-selected={ctx.selected === op.id ? '' : undefined}
      >
        <RowGrip actions={actions} />
        <button
          type="button"
          ref={ctx.rowRef(op.id)}
          className={styles['opSelect']}
          aria-pressed={ctx.selected === op.id}
          {...rowKeys(ctx, 'Alt+ArrowUp Alt+ArrowDown', menu, actions !== undefined)}
          onClick={() => ctx.select(op.id)}
          onKeyDown={(e) => ctx.key(e, op.id)}
        >
          <Icon {...partOperationIconProps(ctx.part.dto, op)} />
          <span className={styles['opName']} title={op.name}>
            {op.name}
          </span>
          <OffMarker ctx={ctx} id={op.id} />
          <RowMarkers failed={ctx.failedAt === op.id} count={n} />
        </button>
      </li>
    </RowMenu>
  )
}

/**
 * DF122: a pocket with a roughing pass, as a feature row (roughing.md § UI): chevron, its own icon
 * and name, the rolled-up badge (its own and its roughing pocket's findings); open, the roughing
 * row one indent step in ("roughing", the roughing mark and its tool). It moves and removes as one
 * operation (the roughing pocket follows it).
 */
function RoughingOwnerRow({
  ctx,
  op,
  roughing,
  actions,
}: {
  ctx: ListContext
  op: OperationDTO
  roughing: OperationDTO
  actions?: RowActions | undefined
}): React.JSX.Element {
  const unit: OperationRowUnit = { kind: 'operation', id: op.id, op, roughing, start: 0, end: 2 }
  const count = rolledUpCount(unit, ctx.warnings)
  const open = ctx.expanded.has(op.id)
  const menu = actions?.menu ?? ctx.rowMenu(op.id)
  const childrenId = `${op.id}-children`
  const failed = ctx.failedAt === op.id || ctx.failedAt === roughing.id
  const off = isDisabled(ctx.off, op.id)
  return (
    <li
      {...actions?.item}
      className={styles['featureItem']}
      data-nested={actions === undefined ? '' : undefined}
      data-open={open || undefined}
    >
      <RowMenu ctx={ctx} id={op.id} name={op.name} items={menu}>
        <div
          className={styles['op']}
          data-off={off ? '' : undefined}
          data-row-menu={menu.length > 0 ? '' : undefined}
          data-selected={ctx.selected === op.id ? '' : undefined}
        >
          <RowGrip actions={actions} />
          <button
            type="button"
            ref={ctx.rowRef(op.id)}
            className={`${styles['opSelect']} ${styles['featureSelect']}`}
            aria-pressed={ctx.selected === op.id}
            aria-expanded={open}
            aria-controls={childrenId}
            {...rowKeys(
              ctx,
              'Alt+ArrowUp Alt+ArrowDown ArrowRight ArrowLeft',
              menu,
              actions !== undefined,
            )}
            aria-label={`${m.navigator.withRoughing(op.name)}${off ? `, ${m.navigator.off}` : ''}`}
            onClick={() => ctx.select(op.id)}
            onKeyDown={(e) => ctx.key(e, op.id)}
          >
            <Chevron open={open} name={op.name} onToggle={() => ctx.toggle(op.id)} />
            <Icon {...partOperationIconProps(ctx.part.dto, op)} />
            <span className={styles['opName']} title={op.name}>
              {op.name}
            </span>
            <OffMarker ctx={ctx} id={op.id} />
            <RowMarkers failed={failed} count={count} />
          </button>
        </div>
      </RowMenu>
      {/* closed: inert (out of the tab order and the accessibility tree) while it slides shut */}
      <div className={styles['ownedWrap']} data-open={open || undefined} inert={!open}>
        <div id={childrenId} className={styles['owned']}>
          <ol className={styles['ownedList']} aria-label={op.name}>
            <OwnedRow ctx={ctx} op={roughing} featureName={op.name} roughing />
          </ol>
        </div>
      </div>
    </li>
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
          data-off={isDisabled(ctx.off, feature.id) ? '' : undefined}
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
            {...rowKeys(
              ctx,
              'Alt+ArrowUp Alt+ArrowDown ArrowRight ArrowLeft',
              menu,
              actions !== undefined,
              blocked !== undefined ? reasonId : undefined,
            )}
            aria-label={isDisabled(ctx.off, feature.id) ? `${name}, ${m.navigator.off}` : name}
            onClick={() => ctx.select(feature.id)}
            onKeyDown={(e) => ctx.key(e, feature.id)}
          >
            <Chevron open={open} name={feature.name} onToggle={() => ctx.toggle(feature.id)} />
            <Icon name={featureIcon(feature)} />
            <span className={styles['featureText']}>
              <span className={styles['opName']} title={feature.name}>
                {feature.name}
              </span>
              {readout.length > 0 ? (
                <span className={styles['featureReadout']}>{readout}</span>
              ) : null}
            </span>
            <OffMarker ctx={ctx} id={feature.id} />
            <RowMarkers failed={failed} count={count} />
          </button>
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

/** An owned operation of a hole: role name, its own badge; no id, no move or remove. */
function OwnedRow({
  ctx,
  op,
  featureName,
  roughing = false,
}: {
  ctx: ListContext
  op: OperationDTO
  featureName: string
  /** DF122: a pocket's roughing pocket (no row menu: it is edited through its pocket). */
  roughing?: boolean
}): React.JSX.Element {
  const n = rolledUpCount({ kind: 'operation', id: op.id, op, start: 0, end: 1 }, ctx.warnings)
  const menu = roughing ? [] : ctx.rowMenu(op.id)
  // DF122: a roughing row carries its tool ("Ø 8 mm", roughing.md § UI)
  const tool =
    (op.kind === 'pocket' || op.kind === 'profile') && op.roughing === true
      ? roughingToolText(ctx.part, op)
      : undefined
  return (
    <RowMenu ctx={ctx} id={op.id} name={op.name} items={menu}>
      <li
        className={styles['op']}
        data-owned=""
        data-off={isDisabled(ctx.off, op.id) ? '' : undefined}
        data-row-menu={menu.length > 0 ? '' : undefined}
        data-selected={ctx.selected === op.id ? '' : undefined}
      >
        <button
          type="button"
          ref={ctx.rowRef(op.id)}
          className={styles['opSelect']}
          aria-pressed={ctx.selected === op.id}
          aria-label={`${f.ownedName(op.name, featureName)}${isDisabled(ctx.off, op.id) ? `, ${m.navigator.off}` : ''}`}
          {...rowKeys(ctx, 'Alt+ArrowUp Alt+ArrowDown ArrowLeft', menu, false)}
          onClick={() => ctx.select(op.id)}
          onKeyDown={(e) => ctx.key(e, op.id)}
        >
          <Icon {...partOperationIconProps(ctx.part.dto, op)} />
          {tool === undefined ? (
            <span className={styles['opName']} title={roleLabel(featureName, op.name)}>
              {roleLabel(featureName, op.name)}
            </span>
          ) : (
            <span className={styles['featureText']}>
              <span className={styles['opName']} title={roleLabel(featureName, op.name)}>
                {roleLabel(featureName, op.name)}
              </span>
              <span className={styles['featureReadout']}>{tool}</span>
            </span>
          )}
          <OffMarker ctx={ctx} id={op.id} />
          <RowMarkers failed={ctx.failedAt === op.id} count={n} />
        </button>
      </li>
    </RowMenu>
  )
}

/**
 * "X 9.00 · Y 15.59 mm" or "u 0.354 · v 0.614 in": an instance's reference point, with its axes
 * (X/Y on the top face) and unit (DF44).
 */
function position(
  at: CloneInstanceRow['at'],
  units: UnitSystem,
  axes: { u: string; v: string },
): string {
  const inch = units === 'inch'
  const fmt = (mm: number) => (inch ? (mm / 25.4).toFixed(3) : mm.toFixed(2))
  return f.instanceAt(fmt(at.u), fmt(at.v), axes, inch ? 'in' : 'mm')
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
  const on = (unit.feature as { on?: unknown }).on
  const axes = axisNames(
    surfaceDirection(ctx.part.table, typeof on === 'string' ? on : 'stock.top'),
  )
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
        {f.clonesGroup(instances.length)}
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
                      ? position(x.at, ctx.part.units, axes)
                      : x.kind === 'skipped'
                        ? f.skipped
                        : f.duplicate}
                  </span>
                </button>
                {x.kind !== 'duplicate' && !ctx.readOnly ? (
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
