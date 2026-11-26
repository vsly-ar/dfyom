/**
 * Built-in workholding library items: read-only constants with today's defaults, listed beside
 * the user's files and never written to disk (Q134); the default rule per type (Q135).
 * Doc: docs/modes/workholding-library.md#built-in-items
 */
import { None, Some, type Option } from '../../shared/result'
import { Quantity } from '../quantity/quantity'
import type { UnitSystem } from '../project/document'
import { LibraryItem } from './library-item'
import type { Library } from './library'
import type { ItemLookup, ItemLookupResult } from './snapshot'
import { Workholding, type WorkholdingSize } from './workholding'
import type { BaseType, SurfaceType, WorkholdingType } from './workholding.dto'

/** Every built-in id starts with this; generated user ids (`workholding-<n>`) never do. */
export const BUILTIN_PREFIX = 'builtin-'
/** The built-ins' `updatedAt`; bump it when a later app version changes a built-in. */
export const BUILTIN_UPDATED_AT = '2026-11-26T00:00:00.000Z'

interface BuiltinDef {
  readonly id: string
  readonly name: { readonly mm: string; readonly inch: string }
  readonly type: WorkholdingType
  /** Size sources as entered, per unit system (bare numbers in mm or inch). */
  readonly sizes: Partial<Record<WorkholdingSize, { readonly mm: string; readonly inch: string }>>
  readonly soft?: boolean
  readonly baseType?: BaseType
  readonly sacrificial?: boolean
  readonly surfaceType?: SurfaceType
}

const same = (name: string) => ({ mm: name, inch: name })

/** In list order; the first of a type is that type's built-in default. */
const BUILTINS: readonly BuiltinDef[] = [
  {
    id: 'builtin-toe-clamp',
    name: same('Toe clamp'),
    type: 'toeClamp',
    // W6-C's clamp: width 30, grip 10 + reach 50 = length 60, top 25 (workholding.md § W6)
    sizes: {
      width: { mm: '30 mm', inch: '1 1/4"' },
      length: { mm: '60 mm', inch: '2 1/2"' },
      top: { mm: '25 mm', inch: '1"' },
      gripMin: { mm: '5 mm', inch: '3/16"' },
      gripMax: { mm: '15 mm', inch: '5/8"' },
    },
  },
  {
    id: 'builtin-vise',
    name: { mm: 'Machine vise 150', inch: 'Machine vise 6"' },
    type: 'vise',
    sizes: {
      jawWidth: { mm: '150 mm', inch: '6"' },
      jawThickness: { mm: '20 mm', inch: '3/4"' },
    },
    soft: false,
  },
  {
    id: 'builtin-screw',
    name: same('Screw, flush head'),
    type: 'screw',
    sizes: {
      headDiameter: { mm: '8 mm', inch: '5/16"' },
      headHeight: { mm: '0 mm', inch: '0"' },
    },
  },
  {
    id: 'builtin-spoilboard',
    name: same('Spoilboard'),
    type: 'base',
    sizes: {},
    baseType: 'spoilboard',
    sacrificial: true,
  },
  {
    id: 'builtin-fixture-plate',
    name: same('Fixture plate'),
    type: 'base',
    sizes: {},
    baseType: 'fixturePlate',
    sacrificial: false,
  },
  {
    id: 'builtin-tape',
    name: same('Double-sided tape'),
    type: 'surface',
    sizes: {},
    surfaceType: 'tape',
  },
  {
    id: 'builtin-vacuum',
    name: same('Vacuum table'),
    type: 'surface',
    sizes: {},
    surfaceType: 'vacuum',
  },
  { id: 'builtin-glue', name: same('Glue'), type: 'surface', sizes: {}, surfaceType: 'glue' },
]

const opt = <T>(v: T | undefined): Option<T> => (v === undefined ? None : Some(v))

/** Builds one built-in; a failure is a bug in the constants above (tested). */
function build(def: BuiltinDef, units: UnitSystem): LibraryItem {
  const sizes = Object.fromEntries(
    Object.entries(def.sizes).map(([f, src]) => [
      f,
      Quantity.parse(src[units], {
        kind: 'length',
        defaultUnit: units === 'mm' ? 'mm' : 'in',
      }).unwrap(),
    ]),
  )
  const values = Workholding.create({
    name: def.name[units],
    notes: None,
    type: def.type,
    isDefault: false,
    sizes,
    stud: None,
    soft: opt(def.soft),
    thread: None,
    baseType: opt(def.baseType),
    sacrificial: opt(def.sacrificial),
    surfaceType: opt(def.surfaceType),
  }).unwrap()
  return LibraryItem.create({
    id: def.id,
    revision: 1,
    updatedAt: BUILTIN_UPDATED_AT,
    values,
  }).unwrap()
}

const cache = new Map<UnitSystem, readonly LibraryItem[]>()

/** The built-in items with the value set of `units`, in list order. */
export function builtinWorkholding(units: UnitSystem): readonly LibraryItem[] {
  let items = cache.get(units)
  if (items === undefined) {
    items = BUILTINS.map((d) => build(d, units))
    cache.set(units, items)
  }
  return items
}

export const isBuiltinWorkholding = (id: string): boolean => id.startsWith(BUILTIN_PREFIX)

const valuesOf = (item: LibraryItem): Workholding | undefined =>
  item.values.kind === 'workholding' ? item.values : undefined

/**
 * The default of a device type (Q135): the user item marked `default`, the later `updatedAt`
 * winning when two claim it (then the larger id), else the type's first built-in; None for a
 * type without one (block).
 */
export function defaultWorkholding(
  userItems: readonly LibraryItem[],
  type: WorkholdingType,
  units: UnitSystem,
): Option<LibraryItem> {
  let best: LibraryItem | undefined
  for (const item of userItems) {
    const v = valuesOf(item)
    if (v === undefined || v.type !== type || !v.isDefault) continue
    if (best === undefined || later(item, best)) best = item
  }
  if (best !== undefined) return Some(best)
  return opt(builtinWorkholding(units).find((i) => valuesOf(i)?.type === type))
}

function later(a: LibraryItem, b: LibraryItem): boolean {
  const d = Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
  return d !== 0 ? d > 0 : a.id > b.id
}

/** A workholding item by id: a built-in (value set of `units`) or a library file. */
export function lookupWorkholding(
  library: Library,
  id: string,
  units: UnitSystem,
): ItemLookupResult {
  if (isBuiltinWorkholding(id)) {
    const item = builtinWorkholding(units).find((i) => i.id === id)
    return item === undefined ? { state: 'missing' } : { state: 'found', item }
  }
  return library.lookup('workholding', id)
}

/**
 * `lookup` that also finds the built-ins (value set of `units`, the project's: a plan's copy of a
 * built-in is compared with the set it took). For the plan's library copies (stale check, Update
 * from library, the `draft` follow); without a library (`undefined`) only the built-ins exist.
 */
export function withBuiltinWorkholding(
  lookup: ItemLookup | undefined,
  units: UnitSystem,
): ItemLookup {
  return (kind, id) => {
    if (kind === 'workholding' && isBuiltinWorkholding(id)) {
      const item = builtinWorkholding(units).find((i) => i.id === id)
      return item === undefined ? { state: 'missing' } : { state: 'found', item }
    }
    return lookup === undefined ? { state: 'missing' } : lookup(kind, id)
  }
}
