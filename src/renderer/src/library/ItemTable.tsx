// The Library window's item list: a sortable `grid` of the tab's items, filtered by the search
// (name and notes) and, for tools, by type. ↑/↓ (Home/End) select a row, Enter moves focus into
// the editor. A row the opening window's project uses has the "Used" chip (tooltip "Used in this project"), the
// row being drafted shows "Unsaved", and a file that does not load is listed with its error and
// cannot be selected for editing. Doc: docs/conventions/ui-library-window.md#layout, #accessibility
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { LibraryItemKind } from '../../../core/library/item'
import type { LibraryItemDTO } from '../../../core/library/library-item'
import { TOOL_TYPES, type ToolType } from '../../../core/library/tool.dto'
import type { QuantityDTO } from '../../../core/quantity/quantity.dto'
import { libraryMessages } from '../messages/library'
import { Select, StatusChip, ToolIcon } from '../ui'
import { quantityOf, quantityText } from './form'
import { NEW, type Listing } from './library-store'
import styles from './LibraryWindow.module.css'

const w = libraryMessages.window
const ALL = 'all'

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

const nameCol: Column = {
  key: 'name',
  label: w.columns.name,
  text: (i) => i.name,
  sort: (i) => i.name.toLocaleLowerCase(),
}

function columns(kind: LibraryItemKind): Column[] {
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

/** Items matching the search (name and notes, case-insensitive) and the type filter. */
export function filterItems(
  items: readonly LibraryItemDTO[],
  search: string,
  type: ToolType | typeof ALL = ALL,
): LibraryItemDTO[] {
  const q = search.trim().toLocaleLowerCase()
  return items.filter(
    (i) =>
      (type === ALL || (i.kind === 'tool' && i.type === type)) &&
      (q === '' ||
        i.name.toLocaleLowerCase().includes(q) ||
        (i.notes ?? '').toLocaleLowerCase().includes(q)),
  )
}

export function ItemTable({
  kind,
  listing,
  search,
  selected,
  used,
  unsavedId,
  newName,
  onSelect,
  onEnter,
}: {
  kind: LibraryItemKind
  listing: Listing
  search: string
  selected: string | null
  used: ReadonlySet<string>
  /** The row with a draft (a stored item's id, or NEW). */
  unsavedId: string | null
  /** The new item's row label while one is drafted. */
  newName: string
  onSelect: (id: string) => void
  onEnter: () => void
}): React.JSX.Element {
  const cols = useMemo(() => columns(kind), [kind])
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [type, setType] = useState<ToolType | typeof ALL>(ALL)
  const grid = useRef<HTMLDivElement>(null)
  const col = cols.find((c) => c.key === sort.key) ?? nameCol
  const rows = useMemo(() => {
    const list = filterItems(listing.items, search, kind === 'tool' ? type : ALL)
    return list.sort((a, b) => {
      const x = col.sort(a)
      const y = col.sort(b)
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir
    })
  }, [listing.items, search, type, kind, col, sort.dir])
  const errors = search.trim() === '' ? listing.errors : []
  const ids = [...(selected === NEW ? [NEW] : []), ...rows.map((r) => r.id)]

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
              aria-label={w.sortBy(c.label)}
              onClick={() => setSort({ key: c.key, dir: active ? (-sort.dir as 1 | -1) : 1 })}
            >
              {c.label}
              {active ? (
                sort.dir === 1 ? (
                  <ArrowUp aria-hidden="true" />
                ) : (
                  <ArrowDown aria-hidden="true" />
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
      <div
        ref={grid}
        role="grid"
        aria-label={w.list(kind)}
        aria-rowcount={ids.length + errors.length + 1}
        className={styles['grid']}
        data-kind={kind}
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
                <span className={styles['name']}>{newName}</span>
                <StatusChip tone="warning">{w.unsaved}</StatusChip>
              </div>
              {cols.slice(1).map((c) => (
                <div role="gridcell" key={c.key} />
              ))}
            </div>
          ) : null}
          {rows.map((i) => {
            const isSelected = i.id === selected
            return (
              <div
                key={i.id}
                role="row"
                aria-selected={isSelected}
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
                    {n === 0 && i.kind === 'tool' ? (
                      <span
                        className={styles['typeIcon']}
                        title={libraryMessages.tool.types[i.type]}
                      >
                        <ToolIcon name={i.type === 'drill' ? 'drill' : 'endmill'} />
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
                  </div>
                ))}
              </div>
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
