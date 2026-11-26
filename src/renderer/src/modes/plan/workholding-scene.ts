// The plan scene's workholding overlay (workholding.md#ui-summary): the setup's prisms as solids
// (an open-ended prism stands on the table: −T), the open item's keep-out halo (footprints grown
// by the margin at its top + margin) and the first hit of each collision finding (WCS); the
// solids of an item a collision names are marked (drawn in --danger). X2-6: a toe clamp's drag
// along its edge (`snapClampAt`, `moveClamp`; workholding.md#toe-clamp-drag-x2-6). Pure.
import type { PlanWarning } from '../../../../core/plan/checks'
import type { Edge } from '../../../../core/plan/workholding/items'
import { footprintOutline } from '../../../../core/plan/workholding/obstacles'
import type { SetupWorkholding } from '../../../../core/plan/workholding/setup'
import type { WorkholdingOverlay } from '../../viewport'

export function workholdingOverlay(
  holding: SetupWorkholding,
  setupId: string,
  selected: string | undefined,
  warnings: readonly PlanWarning[],
): WorkholdingOverlay | undefined {
  const floor = -holding.stock.thickness
  const hits = warnings
    .filter((w) => w.code === 'plan.workholding.collision' && w.params['setupId'] === setupId)
    .flatMap((w): (readonly [number, number, number])[] => {
      const { x, y, lowestZ } = w.params
      return typeof x === 'number' && typeof y === 'number' && typeof lowestZ === 'number'
        ? [[x, y, lowestZ]]
        : []
    })
  if (holding.prisms.length === 0 && hits.length === 0) return undefined
  const colliding = new Set(
    warnings
      .filter((w) => w.code === 'plan.workholding.collision' && w.params['setupId'] === setupId)
      .map((w) => w.params['itemId']),
  )
  const mine = holding.prisms.filter((p) => p.itemId === selected)
  const top = Math.max(...mine.map((p) => p.zMax))
  return {
    solids: holding.prisms.map((p) => ({
      itemId: p.itemId,
      outline: footprintOutline(p.footprint),
      zMin: Number.isFinite(p.zMin) ? p.zMin : floor,
      zMax: p.zMax,
      ...(colliding.has(p.itemId) ? { colliding: true } : {}),
    })),
    ...(mine.length === 0
      ? {}
      : {
          halo: {
            outlines: mine.map((p) => footprintOutline(p.footprint, holding.margin)),
            z: top + holding.margin,
          },
        }),
    ...(selected === undefined ? {} : { selected }),
    hits,
  }
}

/**
 * The overlay in the WCS of a setup whose work zero is moved (DF78): the items are in the setup
 * frame, the scene's frame has its origin at the zero (docs/modes/alignment.md#frames). Collision
 * hits come in the WCS already (the findings' x/y, S12) and stay.
 */
export function shiftOverlay(
  o: WorkholdingOverlay | undefined,
  zero: readonly [number, number],
): WorkholdingOverlay | undefined {
  const [zx, zy] = zero
  if (o === undefined || (zx === 0 && zy === 0)) return o
  const at = (p: readonly [number, number]) => [p[0] - zx, p[1] - zy] as const
  return {
    ...o,
    solids: o.solids.map((s) => ({ ...s, outline: s.outline.map(at) })),
    ...(o.halo === undefined
      ? {}
      : { halo: { ...o.halo, outlines: o.halo.outlines.map((l) => l.map(at)) } }),
  }
}

/** The setup-frame axis a toe clamp on `edge` moves along: 0 (X, front and back) or 1 (Y). */
export const clampAxis = (edge: Edge): 0 | 1 => (edge === 'uMin' || edge === 'uMax' ? 1 : 0)

/** Within this (mm) of a stock corner or the edge's midpoint a dragged clamp snaps there. */
export const CLAMP_SNAP = 3

/**
 * Where a dragged toe clamp goes (`at`, mm along its edge of length `len`): flush with a corner
 * (width / 2 from either end) or at the midpoint within `CLAMP_SNAP`, else rounded to 1 mm; kept
 * on the edge (0 … len, the model's invariant).
 */
export function snapClampAt(at: number, len: number, width: number): number {
  const on = Math.min(len, Math.max(0, at))
  const targets = [width / 2, len / 2, len - width / 2].filter((t) => t >= 0 && t <= len)
  let best: number | undefined
  for (const t of targets)
    if (
      Math.abs(t - on) <= CLAMP_SNAP &&
      (best === undefined || Math.abs(t - on) < Math.abs(best - on))
    )
      best = t
  return best ?? Math.min(len, Math.max(0, Math.round(on)))
}

/** The overlay with item `itemId`'s solids (and its halo, when open) moved by `delta` mm along `axis`. */
export function moveClamp(
  o: WorkholdingOverlay,
  itemId: string,
  axis: 0 | 1,
  delta: number,
): WorkholdingOverlay {
  if (delta === 0) return o
  const at = (p: readonly [number, number]) =>
    (axis === 0 ? [p[0] + delta, p[1]] : [p[0], p[1] + delta]) as readonly [number, number]
  return {
    ...o,
    solids: o.solids.map((s) => (s.itemId === itemId ? { ...s, outline: s.outline.map(at) } : s)),
    ...(o.halo === undefined || o.selected !== itemId
      ? {}
      : { halo: { ...o.halo, outlines: o.halo.outlines.map((l) => l.map(at)) } }),
  }
}
