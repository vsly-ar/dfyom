/**
 * A setup's workholding as the plan reads it: its items in mm, the stock as it sits in the setup,
 * the prisms, the margin and the clearance height the program uses (WH-A–C).
 * Doc: docs/modes/workholding.md#model, docs/modes/workholding.md#links-and-safe-heights
 */
import type { Stock } from '../../library/stock'
import { Quantity } from '../../quantity/quantity'
import { setupOrientation } from '../../toolpath/wcs'
import type { SetupDTO } from '../plan.dto'
import { setupDirection, setupRotation } from '../setups'
import { resolveItem, type ResolvedItem, type SetupStock } from './items'
import {
  effectiveClearance,
  obstacles,
  workholdingObstacles,
  type Prism,
  type WorkholdingObstacles,
} from './obstacles'

/** The default margin (mm) when a setup has none stored. */
export const DEFAULT_MARGIN = 2

export interface SetupWorkholding {
  readonly items: readonly ResolvedItem[]
  readonly stock: SetupStock
  readonly prisms: readonly Prism[]
  readonly margin: number
  /** The clearance height the setup's program uses (mm above Z0). */
  readonly clearance: number
  /** The item whose top raised the clearance height above the stored value. */
  readonly clearanceFrom?: string
  /** The stored clearance height (mm). */
  readonly storedClearance: number
  readonly clearanceSet: boolean
  readonly obstacles: WorkholdingObstacles
}

const length = (dto: Parameters<typeof Quantity.fromDTO>[0] | undefined, fallback: number) =>
  dto === undefined ? fallback : Quantity.fromDTO(dto).mapOr(fallback, (q) => q.canonical)

/** The stock's extents in a setup (machine X, Y, Z). */
export function setupStock(
  stock: Pick<Stock, 'length' | 'width' | 'thickness'>,
  setup: Pick<SetupDTO, 'direction' | 'rotation'>,
): SetupStock {
  const size = setupOrientation(setupDirection(setup), setupRotation(setup), {
    length: stock.length.canonical,
    width: stock.width.canonical,
    thickness: stock.thickness.canonical,
  }).size
  return { length: size[0], width: size[1], thickness: size[2] }
}

const memo = new WeakMap<SetupDTO, WeakMap<object, SetupWorkholding>>()

/** The workholding of `setup` on the plan's stock copy (memoised per immutable record). */
export function setupWorkholding(
  setup: SetupDTO,
  stock: Pick<Stock, 'length' | 'width' | 'thickness'>,
): SetupWorkholding {
  let byStock = memo.get(setup)
  if (byStock === undefined) memo.set(setup, (byStock = new WeakMap()))
  const hit = byStock.get(stock)
  if (hit !== undefined) return hit
  const items = (setup.workholding ?? []).map(resolveItem)
  const size = setupStock(stock, setup)
  const prisms = obstacles(items, size)
  const margin = length(setup.workholdingMargin, DEFAULT_MARGIN)
  const stored = length(setup.clearanceHeight, 0)
  const set = setup.clearanceHeightSet === true
  const c = effectiveClearance(stored, set, prisms, margin)
  const out: SetupWorkholding = {
    items,
    stock: size,
    prisms,
    margin,
    clearance: c.value,
    ...(c.derivedFrom === undefined ? {} : { clearanceFrom: c.derivedFrom }),
    storedClearance: stored,
    clearanceSet: set,
    obstacles: workholdingObstacles(prisms, margin),
  }
  byStock.set(stock, out)
  return out
}
