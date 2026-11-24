// The plan scene's workholding overlay (workholding.md#ui-summary): the setup's prisms as solids
// (an open-ended prism stands on the table: −T), the open item's keep-out halo (footprints grown
// by the margin at its top + margin) and the first hit of each collision finding. Pure.
import type { PlanWarning } from '../../../../core/plan/checks'
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
  const mine = holding.prisms.filter((p) => p.itemId === selected)
  const top = Math.max(...mine.map((p) => p.zMax))
  return {
    solids: holding.prisms.map((p) => ({
      itemId: p.itemId,
      outline: footprintOutline(p.footprint),
      zMin: Number.isFinite(p.zMin) ? p.zMin : floor,
      zMax: p.zMax,
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
