/**
 * Workholding devices from the library in a plan (WL2): the plan's library copies of kind
 * `workholding`, a setup item placed from one (`copyId`), the device's values written into the
 * item, detaching on an edit of a device value (Q138), the range findings and the device's name
 * in the program header.
 * Doc: docs/modes/workholding-library.md#setup-item, #implementation-wl2
 *
 * Pure and headless. A setup item keeps the device's values (resolved) beside its `copyId`, so
 * every reader of `setupWorkholding` sees an ordinary item; the writers here keep them equal to
 * the copy.
 */
import type { Issue } from '../../../shared/errors/app-error'
import { None, Ok, type AppResult } from '../../../shared/result'
import { fieldContext } from '../../design/operation'
import type { LibraryItem } from '../../library/library-item'
import {
  copiedValues,
  deepEqual,
  Snapshot,
  takeSnapshot,
  type SnapshotDTO,
} from '../../library/snapshot'
import type { Workholding } from '../../library/workholding'
import { isBuiltinWorkholding } from '../../library/workholding-builtins'
import type { Stock } from '../../library/stock'
import type { UnitSystem } from '../../project/document'
import { Quantity } from '../../quantity/quantity'
import { Rational } from '../../quantity/rational'
import type { PlanWarning } from '../checks'
import { lengthDTO, type LengthDTO, type PlanDTO, type SetupDTO } from '../plan.dto'
import {
  ITEM_DEFAULTS,
  itemIssues,
  lengthText,
  resolveItem,
  type SetupStock,
  type WorkholdingItemDTO,
  type WorkholdingKind,
} from './items'
import { setupStock } from './setup'

/**
 * The setup item's parameters that come from the device, per kind. The others (edge, at, grip,
 * axis, protrusion, center, rotation, bottom) are the placement.
 */
export const DEVICE_PARAMS: Readonly<Record<WorkholdingKind, readonly string[]>> = {
  toeClamp: ['width', 'reach', 'top'],
  vise: ['jawLength', 'jawThickness', 'soft'],
  screw: ['headDiameter', 'top'],
  block: ['length', 'width', 'top'],
  base: ['type', 'sacrificial'],
  surface: ['type'],
}

const memo = new WeakMap<SnapshotDTO, Workholding | null>()

/** The device of a plan copy (undefined: not a workholding copy, or it does not load). */
export function deviceOfCopy(copy: SnapshotDTO): Workholding | undefined {
  if (copy.kind !== 'workholding') return undefined
  let d = memo.get(copy)
  if (d === undefined) {
    const s = Snapshot.fromDTO(copy)
    const v = s.isOk() ? s.unwrap().values : undefined
    d = v?.kind === 'workholding' ? v : null
    memo.set(copy, d)
  }
  return d ?? undefined
}

/** The plan copy and device an item was placed from, if it names one that loads. */
export function itemDevice(
  snapshots: readonly SnapshotDTO[],
  item: { readonly copyId?: string | undefined },
): { readonly copy: SnapshotDTO; readonly device: Workholding } | undefined {
  if (item.copyId === undefined) return undefined
  const copy = snapshots.find((s) => s.id === item.copyId)
  const device = copy === undefined ? undefined : deviceOfCopy(copy)
  return copy === undefined || device === undefined ? undefined : { copy, device }
}

/**
 * The device's name for the program header and the set result's summary: only a device of the
 * user's library. A built-in's name restates the item's kind ("Toe clamp 1: … · Toe clamp").
 */
export function deviceLabel(
  snapshots: readonly SnapshotDTO[],
  item: { readonly copyId?: string | undefined },
): string | undefined {
  const d = itemDevice(snapshots, item)
  if (d === undefined || d.copy.libraryItemId === undefined) return undefined
  return isBuiltinWorkholding(d.copy.libraryItemId) ? undefined : d.device.name
}

/** A length from an exact value (mm), its source in the project's unit. */
function fromExact(exact: Rational, units: UnitSystem): LengthDTO {
  const mm = exact.toNumber()
  const source = units === 'mm' ? `${lengthText(mm, 'mm')} mm` : `${lengthText(mm, 'in')}"`
  return lengthDTO(
    Quantity.create({
      kind: 'length',
      source,
      defaultUnit: units === 'mm' ? 'mm' : 'in',
      exact,
      tolerance: None,
    }).unwrap(),
  )
}

const exactOf = (l: LengthDTO): Rational | undefined =>
  Quantity.fromDTO(l).mapOr(undefined, (q: Quantity) => q.exact)

/** A toe clamp's grip when none is given: the middle of the device's range, else 10 mm. */
export function deviceGrip(device: Workholding, units: UnitSystem): LengthDTO {
  const min = device.size('gripMin')
  const max = device.size('gripMax')
  if (min.isSome() && max.isSome())
    return fromExact(
      min.unwrap().exact.add(max.unwrap().exact).mul(Rational.create(1n, 2n).unwrap()),
      units,
    )
  return lengthDTO(
    Quantity.parse(ITEM_DEFAULTS.grip[units], fieldContext('length', units)).unwrap(),
  )
}

/**
 * What a placement from `device` takes for a parameter it does not give (before the built-in
 * defaults): a toe clamp's grip is the middle of its range, a block's sizes are the device's (its
 * top is then written by `placeDevice`). The other device values are written by `placeDevice`.
 */
export function deviceFallbacks(device: Workholding, units: UnitSystem): Record<string, LengthDTO> {
  const out: Record<string, LengthDTO> = {}
  const put = (param: string, f: Parameters<Workholding['size']>[0]) => {
    const q = device.size(f)
    if (q.isSome()) out[param] = lengthDTO(q.unwrap())
  }
  if (device.type === 'toeClamp') out['grip'] = deviceGrip(device, units)
  if (device.type === 'block') {
    put('length', 'length')
    put('width', 'width')
    put('top', 'height')
  }
  return out
}

/**
 * The item with the device's values written in (and the derived ones: a toe clamp's reach is the
 * strap length less the grip, a block's top its bottom plus the height, a screw's top the head
 * height); undefined when the device is of another type or misses a value.
 */
export function placeDevice(
  item: WorkholdingItemDTO,
  device: Workholding,
  stock: SetupStock,
  units: UnitSystem,
): WorkholdingItemDTO | undefined {
  if (device.type !== item.kind) return undefined
  const size = (f: Parameters<Workholding['size']>[0]) =>
    device.size(f).mapOr(undefined, (q: Quantity) => lengthDTO(q))
  switch (item.kind) {
    case 'toeClamp': {
      const width = size('width')
      const top = size('top')
      const length = device.size('length')
      const grip = exactOf(item.grip)
      if (width === undefined || top === undefined || length.isNone() || grip === undefined)
        return undefined
      return { ...item, width, reach: fromExact(length.unwrap().exact.sub(grip), units), top }
    }
    case 'vise': {
      const jawLength = size('jawWidth')
      const jawThickness = size('jawThickness')
      if (jawLength === undefined || jawThickness === undefined) return undefined
      return { ...item, jawLength, jawThickness, soft: device.soft.unwrapOr(false) }
    }
    case 'screw': {
      const headDiameter = size('headDiameter')
      const top = size('headHeight')
      if (headDiameter === undefined || top === undefined) return undefined
      return { ...item, headDiameter, top }
    }
    case 'block': {
      const length = size('length')
      const width = size('width')
      const height = device.size('height')
      if (length === undefined || width === undefined || height.isNone()) return undefined
      // the table (−T) when no bottom is set, as resolved at the time of writing
      const bottom =
        item.bottom === undefined
          ? Quantity.parse(`${-stock.thickness} mm`, fieldContext('length', 'mm')).unwrap().exact
          : exactOf(item.bottom)
      if (bottom === undefined) return undefined
      return { ...item, length, width, top: fromExact(bottom.add(height.unwrap().exact), units) }
    }
    case 'base': {
      const type = device.baseType
      if (type.isNone()) return undefined
      return {
        ...item,
        type: type.unwrap(),
        sacrificial: device.sacrificial.unwrapOr(type.unwrap() === 'spoilboard'),
      }
    }
    case 'surface':
      return device.surfaceType.isNone()
        ? undefined
        : { ...item, type: device.surfaceType.unwrap() }
  }
}

/**
 * Whether an edit detaches the item from its device (Q138): a device parameter the edit gives
 * explicitly whose value differs from the device's. Re-sending the device's own value does not.
 */
export function detaches(
  given: Readonly<Record<string, unknown>>,
  edited: WorkholdingItemDTO,
  placed: WorkholdingItemDTO,
): boolean {
  const a = edited as unknown as Record<string, unknown>
  const b = placed as unknown as Record<string, unknown>
  return DEVICE_PARAMS[edited.kind].some((p) => {
    if (given[p] === undefined) return false
    const x = a[p]
    const y = b[p]
    if (typeof x === 'object' && x !== null && typeof y === 'object' && y !== null) {
      const ex = exactOf(x as LengthDTO)
      const ey = exactOf(y as LengthDTO)
      return ex === undefined || ey === undefined || !ex.equals(ey)
    }
    return x !== y
  })
}

/**
 * The plan's copy of a library device: an existing copy of the same item with its current values
 * (Copy from and every placement of one device share it), else a new one appended to `snapshots`.
 */
export function deviceCopy(
  snapshots: SnapshotDTO[],
  item: LibraryItem,
  newId: () => string,
  now: string,
): AppResult<SnapshotDTO> {
  const values = copiedValues(item.values).toDTO()
  const same = snapshots.find(
    (s) => s.kind === 'workholding' && s.libraryItemId === item.id && deepEqual(s.values, values),
  )
  if (same !== undefined) return Ok(same)
  return takeSnapshot(item, newId(), now).map((s) => {
    const dto = s.toDTO()
    snapshots.push(dto)
    return dto
  })
}

/** Removes the workholding copies no setup item names any more (as unused tool copies are). */
export function pruneWorkholdingCopies(plan: Pick<PlanDTO, 'snapshots' | 'setups'>): SnapshotDTO[] {
  const used = new Set(
    plan.setups.flatMap((s) => (s.workholding ?? []).flatMap((i) => i.copyId ?? [])),
  )
  return plan.snapshots.filter((s) => s.kind !== 'workholding' || used.has(s.id))
}

/**
 * Writes the copy `copyId`'s device into every item placed from it (after Update from library or
 * the `draft` follow), in place on a plain plan. The model issues of the setups it changed: a
 * device that no longer fits its placement (a strap shorter than the grip) blocks the update.
 */
export function reresolveCopy(
  plan: PlanDTO,
  copyId: string,
  stock: Pick<Stock, 'length' | 'width' | 'thickness'>,
  units: UnitSystem,
): Issue[] {
  const copy = plan.snapshots.find((s) => s.id === copyId)
  const device = copy === undefined ? undefined : deviceOfCopy(copy)
  if (device === undefined) return []
  const issues: Issue[] = []
  for (const setup of plan.setups) {
    const items = setup.workholding
    if (items === undefined || !items.some((i) => i.copyId === copyId)) continue
    const size = setupStock(stock, setup)
    items.forEach((item, n) => {
      if (item.copyId !== copyId) return
      const placed = placeDevice(item, device, size, units)
      if (placed === undefined)
        issues.push({
          path: ['workholding', n, 'copyId'],
          rule: 'deviceType',
          message: `${device.name} is not a ${item.kind}`,
        })
      else items[n] = placed
    })
    issues.push(
      ...itemIssues(items.map(resolveItem), size).map((i) => ({
        ...i,
        message: `${setup.name}: ${i.message}`,
      })),
    )
  }
  return issues
}

const mmText = (v: number) => `${lengthText(v, 'mm')} mm`

/**
 * `plan.workholding.outOfRange` (warning, never blocks): an item placed from a device outside its
 * range: a toe clamp's grip outside `gripMin`–`gripMax` (rule `grip`), the stock across a vise's
 * jaws wider than `maxOpening` (rule `opening`).
 */
export function rangeFindings(
  plan: Pick<PlanDTO, 'snapshots'>,
  setup: SetupDTO,
  stock: SetupStock,
): PlanWarning[] {
  const out: PlanWarning[] = []
  for (const item of setup.workholding ?? []) {
    const d = itemDevice(plan.snapshots, item)
    if (d === undefined) continue
    const device = d.device
    const params = (rule: string) => ({ setupId: setup.id, itemId: item.id, rule })
    if (item.kind === 'toeClamp') {
      const min = device.size('gripMin')
      const max = device.size('gripMax')
      const grip = Quantity.fromDTO(item.grip).mapOr(undefined, (q: Quantity) => q.canonical)
      if (min.isNone() || max.isNone() || grip === undefined) continue
      const lo = min.unwrap().canonical
      const hi = max.unwrap().canonical
      if (grip < lo - 1e-9 || grip > hi + 1e-9)
        out.push({
          code: 'plan.workholding.outOfRange',
          severity: 'warning',
          message: `${item.name} in ${setup.name} grips ${mmText(grip)}, outside the grip range of ${device.name} (${mmText(lo)} to ${mmText(hi)})`,
          rule: 'grip',
          params: params('grip'),
        })
    } else if (item.kind === 'vise') {
      const max = device.size('maxOpening')
      if (max.isNone()) continue
      const across = item.axis === 'u' ? stock.length : stock.width
      const open = max.unwrap().canonical
      if (across > open + 1e-9)
        out.push({
          code: 'plan.workholding.outOfRange',
          severity: 'warning',
          message: `The stock in ${setup.name} is ${mmText(across)} across the jaws of ${device.name}, more than its opening of ${mmText(open)}`,
          rule: 'opening',
          params: params('opening'),
        })
    }
  }
  return out
}
