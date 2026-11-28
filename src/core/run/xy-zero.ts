/**
 * Setting the work zero in X/Y from a stock edge or corner (v0.5 RV5): where the plan's setup puts
 * each edge in its work coordinates, the G54 that puts a measured edge there, the edge a touch-off
 * finds (the tool's radius and the feeler), the corner the plan's zero is on and, for the virtual
 * machine, where the virtual operator laid the stock. Pure. Doc: docs/modes/run-probing.md#set-xy-zero-rv5
 */
import type { Vec3 } from '../toolpath/model'

export type Side = -1 | 1

/** An edge (one axis) or a corner (both): −1 the stock's X−/Y− side, +1 its X+/Y+ side. */
export interface StockPick {
  readonly x?: Side
  readonly y?: Side
}

/**
 * The setup's stock as Set X/Y zero reads it: the setup frame has the stock on `[0, length] ×
 * [0, width] × [−thickness, 0]`, the work coordinates are the setup frame less `zero` (DF78).
 */
export interface PlanStock {
  readonly length: number
  readonly width: number
  readonly thickness: number
  readonly zero: readonly [number, number]
}

/**
 * The virtual operator never lays the stock exactly where G54 says (plan v0.5 RV5's case): the
 * virtual machine's stock sits this far off the plan's place (mm, X and Y), so probing it moves G54.
 */
export const VIRTUAL_MISPLACEMENT: readonly [number, number] = [3.2, -1.7]

/** The stock's edge on `axis` in the setup's work coordinates (mm). */
export function planEdge(stock: PlanStock, axis: 'x' | 'y', side: Side): number {
  const i = axis === 'x' ? 0 : 1
  const size = axis === 'x' ? stock.length : stock.width
  return (side < 0 ? 0 : size) - stock.zero[i]
}

/** The G54 (MPos) on an axis so a measured edge (MPos) gets the work coordinate `wcs`. */
export const g54For = (edge: number, wcs: number): number => edge - wcs

/**
 * The edge (MPos) a touch-off finds: the tool touches the stock's `side` edge from outside, so
 * the edge is the radius and the feeler further on (side −1: the tool on the X− side, edge at
 * position + r + feeler).
 */
export function touchedEdge(position: number, side: Side, diameter: number, feeler: number) {
  return position - side * (diameter / 2 + feeler)
}

/**
 * The corner nearest the plan's zero (the dialog's first pick) and whether the zero is on it
 * (within 0.001 mm): "the setup's G54 origin".
 */
export function zeroCorner(stock: PlanStock): { corner: readonly [Side, Side]; on: boolean } {
  const [zx, zy] = stock.zero
  const sx: Side = zx > stock.length / 2 ? 1 : -1
  const sy: Side = zy > stock.width / 2 ? 1 : -1
  const cx = sx < 0 ? 0 : stock.length
  const cy = sy < 0 ? 0 : stock.width
  return { corner: [sx, sy], on: Math.abs(zx - cx) < 1e-3 && Math.abs(zy - cy) < 1e-3 }
}

/**
 * The virtual machine's stock (MPos box): where the plan puts it at the G54 of this moment (its
 * top at the setup's Z0 less the zero level), off by `VIRTUAL_MISPLACEMENT`; under the tool (top
 * 10 mm below it) when G54 was never set.
 */
export function virtualStockBox(
  stock: PlanStock,
  at: { readonly workZero: Vec3; readonly zeroLevel?: number; readonly mpos: Vec3 },
): { min: Vec3; max: Vec3 } {
  const unset = at.workZero.every((v) => v === 0)
  const [dx, dy] = VIRTUAL_MISPLACEMENT
  const x0 = unset ? at.mpos[0] - stock.length / 2 : at.workZero[0] - stock.zero[0] + dx
  const y0 = unset ? at.mpos[1] - stock.width / 2 : at.workZero[1] - stock.zero[1] + dy
  const top = unset ? at.mpos[2] - 10 : at.workZero[2] - (at.zeroLevel ?? 0)
  return {
    min: [x0, y0, top - stock.thickness],
    max: [x0 + stock.length, y0 + stock.width, top],
  }
}
