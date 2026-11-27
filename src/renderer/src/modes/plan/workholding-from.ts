// Where the workholding fields measure from (hardening DF125): X/Y from the stock corner (the
// setup frame, as stored) or from the setup's work zero (the WCS), heights from the stock top (Z0,
// as stored) or from the stock bottom. A viewer's habit, remembered app-wide with the inspector's
// chrome state; the stored values never change: the field converts what it shows and commits.
// Doc: docs/modes/workholding.md#measured-from-df125
import { fieldContext } from '../../../../core/design/operation'
import type { UnitSystem } from '../../../../core/project/document'
import { Quantity } from '../../../../core/quantity/quantity'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import { lengthSource } from '../design/reference-view'
import { useInspectorMemory, useRememberedTab } from '../../ui'
import { quantityOf } from '../design/model'

export type XyFrom = 'corner' | 'zero'
export type ZFrom = 'top' | 'bottom'

export interface MeasuredFrom {
  readonly xy: XyFrom
  readonly z: ZFrom
}

/** The remembered keys (settings `inspectorTabs`). */
export const XY_FROM_KEY = 'workholding.xyFrom'
export const Z_FROM_KEY = 'workholding.zFrom'

/** The viewer's choices (defaults: the stock corner and top, as stored) and their setters. */
export function useMeasuredFrom(): {
  from: MeasuredFrom
  setXy: (xy: XyFrom) => void
  setZ: (z: ZFrom) => void
} {
  const memory = useInspectorMemory()
  const xy = useRememberedTab(XY_FROM_KEY) === 'zero' ? 'zero' : 'corner'
  const z = useRememberedTab(Z_FROM_KEY) === 'bottom' ? 'bottom' : 'top'
  return {
    from: { xy, z },
    setXy: (v) => memory.setTab(XY_FROM_KEY, v),
    setZ: (v) => memory.setTab(Z_FROM_KEY, v),
  }
}

/** What a field measures: X or Y in the setup frame, or a height above Z0. */
export type MeasuredAxis = 'x' | 'y' | 'z'

/** The setup's references: its work zero (setup frame, mm) and the stock's thickness T (mm). */
export interface SetupReferences {
  readonly zero: readonly [number, number]
  readonly thickness: number
}

/** What a shown value adds up to the stored one (mm): stored = shown + offset. */
export function storeOffset(axis: MeasuredAxis, from: MeasuredFrom, refs: SetupReferences): number {
  if (axis === 'z') return from.z === 'bottom' ? -refs.thickness : 0
  return from.xy === 'zero' ? refs.zero[axis === 'x' ? 0 : 1] : 0
}

/**
 * The field's value: the stored quantity as entered when the offset is 0 (formulas kept), else
 * the resolved value less the offset as a plain length in the project's units.
 */
export function shownQuantity(
  dto: QuantityDTO,
  resolvedMm: number | undefined,
  offset: number,
  units: UnitSystem,
): Quantity | undefined {
  if (offset === 0 || resolvedMm === undefined) return quantityOf(dto)
  const q = Quantity.parse(lengthSource(resolvedMm - offset, units), fieldContext('length', units))
  return q.isOk() ? q.unwrap() : undefined
}

/** What the field commits: the entry as typed when the offset is 0, else entry + offset in mm. */
export function storedSource(q: Quantity, offset: number, units: UnitSystem): string {
  return offset === 0 ? q.source : lengthSource(q.canonical + offset, units)
}
