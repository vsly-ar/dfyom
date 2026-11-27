// The Library window's item list: a sortable `grid` of the tab's items, filtered by the search
// (name and notes) and, for tools, by type. ↑/↓ (Home/End) select a row, Enter moves focus into
// the editor. A row the opening window's project uses has the "Used" chip (tooltip "Used in this project"), the
// row being drafted shows "Unsaved", and a file that does not load is listed with its error and
// cannot be selected for editing. Stock variants follow their parent, indented (DF13). Workholding
// devices (WL3) are grouped by device type under a heading row, with a type filter, the L1 type
// icon, and the "Default" and "Built-in" chips; built-ins follow the user's items of their type.
// Doc: docs/conventions/ui-library-window.md#layout, #accessibility,
// docs/modes/workholding-library.md#library-window-tab
import { Fragment, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { LibraryTabKind } from '../../../core/library/item'
import type { LibraryItemDTO } from '../../../core/library/library-item'
import { TOOL_TYPES, type ToolType } from '../../../core/library/tool.dto'
import { WORKHOLDING_TYPES, type WorkholdingType } from '../../../core/library/workholding.dto'
import type { UnitSystem } from '../../../core/project/document'
import type { QuantityDTO } from '../../../core/quantity/quantity.dto'
import { libraryMessages } from '../messages/library'
import { Icon, Select, StatusChip } from '../ui'
import { TOOL_TYPE_ICON } from './toolTypeIcon'
import { quantityOf, quantityText, type WorkholdingDraft } from './form'
import {
  asWorkholding,
  detailsText,
  isBuiltIn,
  isDefaultRow,
  sizeText,
  WORKHOLDING_TYPE_ICON,
  workholdingIcon,
} from './workholding-view'
import { NEW, type Listing } from './library-store'
import styles from './LibraryWindow.module.css'

const w = libraryMessages.window
const wh = libraryMessages.workholding
const ALL = 'all'

/** A listing row as a workholding device's values (undefined for the other kinds). */
const device = (i: LibraryItemDTO) => asWorkholding(i) as WorkholdingDraft | undefined

/** A device's main size for sorting: its first length (strap width, jaw width, head Ø …). */
function mainSize(v: WorkholdingDraft): number {
  const q = v.width ?? v.jawWidth ?? v.headDiameter ?? v.length ?? v.thickness
  return num(q)
}

interface Column {
  readonly key: string
  readonly label: string
  readonly text: (i: LibraryItemDTO) => string
  /** Sort key: a number (quantities by their canonical value) or text. */
  readonly sort: (i: LibraryItemDTO) => number | string
  readonly numeric?: boolean
}

const num = (q: QuantityDTO | undefined): number =>
  q === undefined ? -Infinity : (quantityOf(q)?.canonical ?? -Infinity)

/** An angle as whole or decimal degrees: "90°", "82.5°". */
const degrees = (q: QuantityDTO): string => {
  const v = quantityOf(q)?.canonical
  return v === undefined ? q.source : `${Number(v.toFixed(2))}°`
}

const nameCol: Column = {
  key: 'name',
  label: w.columns.name,
  text: (i) => i.name,
  sort: (i) => i.name.toLocaleLowerCase(),
}

function columns(kind: LibraryTabKind, units: UnitSystem): Column[] {
  if (kind === 'workholding')
    return [
      nameCol,
      {
        key: 'deviceSize',
        label: w.columns.deviceSize,
        text: (i) => {
          const v = device(i)
          return v === undefined ? '' : sizeText(v, units)
        },
        sort: (i) => {
          const v = device(i)
          return v === undefined ? 0 : mainSize(v)
        },
      },
      {
        key: 'deviceDetails',
        label: w.columns.deviceDetails,
        text: (i) => {
          const v = device(i)
          return v === undefined ? '' : detailsText(v, units)
        },
        sort: (i) => {
          const v = device(i)
          return v === undefined ? '' : detailsText(v, units).toLocaleLowerCase()
        },
      },
    ]
  if (kind === 'tool')
    return [
      nameCol,
      ...(
        [
          ['diameter', w.columns.diameter],
          ['cornerRadius', w.columns.cornerRadius],
          ['fluteCount', w.columns.flutes],
          ['fluteLength', w.columns.fluteLength],
        ] as const
      ).map(([key, label]): Column => ({
        key,
        label,
        numeric: true,
        text: (i) => (i.kind === 'tool' ? quantityText(i[key]) : ''),
        sort: (i) => (i.kind === 'tool' ? num(i[key]) : 0),
      })),
      // a chamfer mill's included angle, a tapered ball's per side ("3.6°/side", DF124 T3, sorted
      // by its included angle); an empty cell for the other types (task U4)
      {
        key: 'angle',
        label: w.columns.angle,
        numeric: true,
        text: (i) =>
          i.kind !== 'tool'
            ? ''
            : i.angle !== undefined
              ? degrees(i.angle)
              : i.taperAngle !== undefined
                ? libraryMessages.tool.perSide(degrees(i.taperAngle).slice(0, -1))
                : '',
        sort: (i) =>
          i.kind !== 'tool' ? 0 : i.taperAngle !== undefined ? 2 * num(i.taperAngle) : num(i.angle),
      },
      {
        key: 'presets',
        label: w.columns.presets,
        numeric: true,
        text: (i) => (i.kind === 'tool' ? String(i.presets.length) : ''),
        sort: (i) => (i.kind === 'tool' ? i.presets.length : 0),
      },
    ]
  if (kind === 'machine')
    return [
      nameCol,
      {
        key: 'controller',
        label: w.columns.controller,
        text: (i) => (i.kind === 'machine' ? w.controllers[i.controller] : ''),
        sort: (i) => (i.kind === 'machine' ? i.controller : ''),
      },
      {
        key: 'travel',
        label: w.columns.travel,
        numeric: true,
        text: (i) =>
          i.kind === 'machine'
            ? [i.travel.x, i.travel.y, i.travel.z].map((q) => q.source.trim()).join(' × ') +
              (quantityText(i.travel.x).endsWith('"') ? '"' : ` ${i.travel.x.defaultUnit}`)
            : '',
        sort: (i) => (i.kind === 'machine' ? num(i.travel.x) * num(i.travel.y) : 0),
      },
      {
        key: 'spindle',
        label: w.columns.spindle,
        numeric: true,
        text: (i) =>
          i.kind === 'machine'
            ? w.spindleSummary(quantityText(i.spindle.maxSpeed), i.spindle.control)
            : '',
        sort: (i) => (i.kind === 'machine' ? num(i.spindle.maxSpeed) : 0),
      },
    ]
  return [
    nameCol,
    {
      key: 'shape',
      label: w.columns.shape,
      text: (i) => (i.kind === 'stock' ? w.shapes[i.shape] : ''),
      sort: (i) => (i.kind === 'stock' ? i.shape : ''),
    },
    {
      key: 'size',
      label: w.columns.size,
      numeric: true,
      text: (i) =>
        i.kind === 'stock'
          ? [i.length, i.width, i.thickness].map((q) => quantityText(q)).join(' × ')
          : '',
      sort: (i) => (i.kind === 'stock' ? num(i.length) * num(i.width) * num(i.thickness) : 0),
    },
    {
      key: 'material',
      label: w.columns.material,
      text: (i) => (i.kind === 'stock' ? i.material.name : ''),
      sort: (i) => (i.kind === 'stock' ? i.material.name.toLocaleLowerCase() : ''),
    },
  ]
}

/**
 * Items matching the search (name, notes and a tool type's aliases such as "V-bit",
 * case-insensitive) and the type filter.
 */
export function filterItems(
  items: readonly LibraryItemDTO[],
  search: string,
  type: ToolType | WorkholdingType | typeof ALL = ALL,
): LibraryItemDTO[] {
  const q = search.trim().toLocaleLowerCase()
  return items.filter(
    (i) =>
      (type === ALL ||
        (i.kind === 'tool' && i.type === type) ||
        (i.kind === 'workholding' && device(i)?.type === type)) &&
      (q === '' ||
        i.name.toLocaleLowerCase().includes(q) ||
        (i.notes ?? '').toLocaleLowerCase().includes(q) ||
        (i.kind === 'tool' &&
          q.length >= 2 &&
          (libraryMessages.tool.typeAliases[i.type] ?? []).some((a) => a.startsWith(q)))),
  )
}

/**
 * Stock variants under their parent (DF13, ui-library-window.md#stock-variants-df13): `sorted`
 * rows in the order of their roots, each root followed by its variants in the same order; a
 * variant whose parent is not listed counts as a root.
 */
export function withVariants(sorted: readonly LibraryItemDTO[]): LibraryItemDTO[] {
  const ids = new Set(sorted.map((i) => i.id))
  const isRoot = (i: LibraryItemDTO) => i.parentId === undefined || !ids.has(i.parentId)
  return sorted
    .filter(isRoot)
    .flatMap((r) => [r, ...sorted.filter((i) => !isRoot(i) && i.parentId === r.id)])
}

export function ItemTable({
  kind,
  listing,
  search,
  selected,
  used,
  unsavedId,
  newName,
  newType,
  newDevice,
  units,
  onSelect,
  onEnter,
}: {
  kind: LibraryTabKind
  listing: Listing
  search: string
  selected: string | null
  used: ReadonlySet<string>
  /** The row with a draft (a stored item's id, or NEW). */
  unsavedId: string | null
  /** The new item's row label while one is drafted. */
  newName: string
  /** A new tool draft's type: its row shows the type icon like a saved one (DF48). */
  newType?: ToolType | undefined
  /** A new workholding draft's device type: its row shows the type icon (WL3). */
  newDevice?: WorkholdingType | undefined
  /** The window's unit system (workholding sizes are shown in it). */
  units: UnitSystem
  onSelect: (id: string) => void
  onEnter: () => void
}): React.JSX.Element {
  const cols = useMemo(() => columns(kind, units), [kind, units])
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [type, setType] = useState<ToolType | WorkholdingType | typeof ALL>(ALL)
  const grouped = kind === 'workholding'
  const grid = useRef<HTMLDivElement>(null)
  const col = cols.find((c) => c.key === sort.key) ?? nameCol
  const rows = useMemo(() => {
    const list = filterItems(
      listing.items,
      search,
      kind === 'stock' || kind === 'machine' ? ALL : type,
    )
    // a search hit on a stock variant shows its parent too
    const parents = listing.items.filter(
      (p) => !list.includes(p) && list.some((i) => i.parentId === p.id),
    )
    const sorted = [...list, ...parents].sort((a, b) => {
      const x = col.sort(a)
      const y = col.sort(b)
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir
    })
    if (kind !== 'workholding') return withVariants(sorted)
    // workholding: by device type, the built-ins after the user's items of their type (WL3)
    const typeAt = (i: LibraryItemDTO) => WORKHOLDING_TYPES.indexOf(device(i)!.type)
    const builtins = listing.items.filter(isBuiltIn)
    return sorted.sort(
      (a, b) =>
        typeAt(a) - typeAt(b) ||
        Number(isBuiltIn(a)) - Number(isBuiltIn(b)) ||
        (isBuiltIn(a) ? builtins.indexOf(a) - builtins.indexOf(b) : 0),
    )
  }, [listing.items, search, type, kind, col, sort.dir])
  const nameOf = (id: string | undefined) => listing.items.find((i) => i.id === id)?.name
  const errors = search.trim() === '' ? listing.errors : []
  const ids = [...(selected === NEW ? [NEW] : []), ...rows.map((r) => r.id)]
  /** A workholding row that starts its device type's group (its heading row goes before it). */
  const groupStart = (i: LibraryItemDTO, n: number): WorkholdingType | undefined => {
    if (!grouped) return undefined
    const t = device(i)?.type
    return t !== undefined && (n === 0 || device(rows[n - 1]!)?.type !== t) ? t : undefined
  }
  const groupCount = grouped ? new Set(rows.map((i) => device(i)?.type)).size : 0

  const focusRow = (id: string) =>
    requestAnimationFrame(() =>
      grid.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`)?.focus(),
    )
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = selected === null ? -1 : ids.indexOf(selected)
    const go = (n: number) => {
      const id = ids[Math.max(0, Math.min(ids.length - 1, n))]
      if (id === undefined) return
      e.preventDefault()
      if (id !== selected) onSelect(id)
      focusRow(id)
    }
    if (e.key === 'ArrowDown') go(at + 1)
    else if (e.key === 'ArrowUp') go(at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(ids.length - 1)
    else if (e.key === 'Enter' && selected !== null) {
      e.preventDefault()
      onEnter()
    }
  }

  const header = (
    <div role="row" className={styles['headRow']} data-kind={kind}>
      {cols.map((c) => {
        const active = sort.key === c.key
        return (
          <div
            key={c.key}
            role="columnheader"
            aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
            className={styles['headCell']}
            data-numeric={c.numeric || undefined}
          >
            <button
              type="button"
              tabIndex={-1}
              className={styles['sortButton']}
              aria-label={w.sortBy(w.columnTips[c.key] ?? c.label)}
              title={w.columnTips[c.key]}
              onClick={() => setSort({ key: c.key, dir: active ? (-sort.dir as 1 | -1) : 1 })}
            >
              {c.label}
              {active ? (
                sort.dir === 1 ? (
                  <Icon name="arrow-up" />
                ) : (
                  <Icon name="arrow-down" />
                )
              ) : null}
            </button>
          </div>
        )
      })}
    </div>
  )

  const count = listing.items.length
  const empty = listing.loaded && rows.length === 0 && selected !== NEW && errors.length === 0

  return (
    <div className={styles['listPane']}>
      {kind === 'tool' ? (
        <div className={styles['filters']}>
          <Select<string>
            aria-label={w.typeFilter}
            options={[
              { value: ALL, label: w.allTypes },
              ...TOOL_TYPES.map((t) => ({ value: t, label: libraryMessages.tool.types[t] })),
            ]}
            value={type}
            onValueChange={(v) => setType(v as ToolType | typeof ALL)}
            className={styles['typeFilter']}
          />
        </div>
      ) : null}
      {grouped ? (
        <div className={styles['filters']}>
          <Select<string>
            aria-label={wh.typeFilter}
            options={[
              { value: ALL, label: w.allTypes },
              ...WORKHOLDING_TYPES.map((t) => ({ value: t, label: wh.types[t] })),
            ]}
            value={type}
            onValueChange={(v) => setType(v as WorkholdingType | typeof ALL)}
            className={styles['typeFilter']}
          />
        </div>
      ) : null}
      <div
        ref={grid}
        role="grid"
        aria-label={w.list(kind)}
        aria-rowcount={ids.length + errors.length + groupCount + 1}
        className={styles['grid']}
        data-kind={kind}
        data-empty={empty || undefined}
        onKeyDown={onKey}
      >
        <div role="rowgroup">{header}</div>
        <div role="rowgroup" className={styles['body']}>
          {selected === NEW ? (
            <div
              role="row"
              aria-selected="true"
              data-row={NEW}
              tabIndex={0}
              className={styles['row']}
              data-kind={kind}
            >
              <div role="gridcell" className={styles['nameCell']}>
                {newDevice !== undefined ? (
                  <span className={styles['typeIcon']} title={wh.types[newDevice]}>
                    <Icon name={WORKHOLDING_TYPE_ICON[newDevice]} />
                  </span>
                ) : null}
                {newType !== undefined ? (
                  <span className={styles['typeIcon']} title={libraryMessages.tool.types[newType]}>
                    <Icon name={TOOL_TYPE_ICON[newType]} />
                  </span>
                ) : null}
                <span className={styles['name']}>{newName}</span>
                <StatusChip tone="warning">{w.unsaved}</StatusChip>
              </div>
              {cols.slice(1).map((c) => (
                <div role="gridcell" key={c.key} />
              ))}
            </div>
          ) : null}
          {rows.map((i, rowAt) => {
            const isSelected = i.id === selected
            const parent = nameOf(i.parentId)
            const v = device(i)
            const start = groupStart(i, rowAt)
            return (
              <Fragment key={i.id}>
                {start === undefined ? null : (
                  <div
                    key={`group-${start}`}
                    role="row"
                    className={styles['groupRow']}
                    data-kind={kind}
                  >
                    <div role="gridcell" className={styles['groupCell']}>
                      {wh.groups[start]}
                    </div>
                  </div>
                )}
                <div
                  key={i.id}
                  role="row"
                  aria-selected={isSelected}
                  {...(parent === undefined
                    ? {}
                    : { 'aria-label': w.variantRow(i.name, parent), 'data-variant': '' })}
                  data-row={i.id}
                  tabIndex={isSelected || (selected === null && i === rows[0]) ? 0 : -1}
                  className={styles['row']}
                  data-kind={kind}
                  onClick={() => onSelect(i.id)}
                >
                  {cols.map((c, n) => (
                    <div
                      role="gridcell"
                      key={c.key}
                      className={n === 0 ? styles['nameCell'] : styles['cell']}
                      data-numeric={c.numeric || undefined}
                    >
                      {n === 0 && v !== undefined ? (
                        <span className={styles['typeIcon']} title={wh.types[v.type]}>
                          <Icon name={workholdingIcon(v)} />
                        </span>
                      ) : null}
                      {n === 0 && i.kind === 'tool' ? (
                        <span
                          className={styles['typeIcon']}
                          title={libraryMessages.tool.types[i.type]}
                        >
                          <Icon name={TOOL_TYPE_ICON[i.type]} />
                        </span>
                      ) : null}
                      {n === 0 ? (
                        <span className={styles['name']} title={c.text(i)}>
                          {c.text(i)}
                        </span>
                      ) : (
                        c.text(i)
                      )}
                      {n === 0 && unsavedId === i.id ? (
                        <span className={styles['chip']}>
                          <StatusChip tone="warning">{w.unsaved}</StatusChip>
                        </span>
                      ) : null}
                      {n === 0 && used.has(i.id) ? (
                        <span className={styles['chip']} title={w.used}>
                          <StatusChip tone="neutral">{w.usedShort}</StatusChip>
                        </span>
                      ) : null}
                      {n === 0 && isDefaultRow(i) ? (
                        <span className={styles['chip']}>
                          <StatusChip tone="neutral" icon={<Icon name="check" />}>
                            {wh.defaultChip}
                          </StatusChip>
                        </span>
                      ) : null}
                      {n === 0 && isBuiltIn(i) ? (
                        <span className={styles['chip']}>
                          <StatusChip tone="neutral">{wh.builtIn}</StatusChip>
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              </Fragment>
            )
          })}
          {errors.map((e) => (
            <div
              key={e.id}
              role="row"
              aria-disabled="true"
              className={styles['row']}
              data-kind={kind}
              data-unreadable=""
            >
              <div role="gridcell" className={styles['nameCell']}>
                <span className={styles['name']}>{e.id}</span>
                <StatusChip tone="danger">{w.unreadable}</StatusChip>
              </div>
              <div role="gridcell" className={styles['errorCell']}>
                {w.unreadableHint(e.message)}
              </div>
            </div>
          ))}
        </div>
      </div>
      {empty ? (
        <div className={styles['emptyList']}>
          {count === 0 ? (
            <>
              <p>{w.empty(kind)}</p>
              <p className={styles['hint']}>{w.emptyHint(kind)}</p>
            </>
          ) : (
            <p>{w.noMatch(search)}</p>
          )}
        </div>
      ) : null}
      <p className={styles['status']} role="status">
        {w.count(kind, count)}
        {rows.length !== count ? ` · ${w.shown(rows.length)}` : ''}
        {listing.errors.length > 0 ? ` · ${w.unreadableCount(listing.errors.length)}` : ''}
      </p>
    </div>
  )
}
