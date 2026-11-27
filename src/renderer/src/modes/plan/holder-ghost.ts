// The plan scene's holder ghost (hardening DF132 H5): for the shown operation, the tool (its
// stickout), the collet nut and the spindle body as stacked cylinders with the tip at the move
// that decides its minimum stickout (`stickoutReason`: the clamp-deciding move, or the deepest
// point of its toolpath when the cut decides), or at the first hit of its `holder` collision,
// marked colliding. None without a holder on the machine, a tool or a stickout, or while the
// clamps are not yet checked (a toolpath of the run is missing or outdated). Pure.
// Doc: docs/modes/tool-holder.md#implementation-h5, docs/conventions/ui.md#workholding
import type { PlanWarning } from '../../../../core/plan/checks'
import { toolEnvelope, type HolderSizes } from '../../../../core/plan/workholding/envelope'
import { expandDrill } from '../../../../core/toolpath/stats'
import type { Toolpath, Vec3 } from '../../../../core/toolpath/model'
import type { HolderGhostOverlay } from '../../viewport'
import type { PlanOperationView } from './model'

/**
 * How much of the spindle body is drawn (mm; the body counts to infinity): a stub of 0.3 × its
 * diameter, at least 10 mm, broken off above (a taller one filled the view over the part).
 */
export const bodyShown = (h: HolderSizes): number => Math.max(10, 0.3 * h.bodyDiameter)

/** The deepest point of a toolpath (the first move that reaches its lowest Z; WCS, mm). */
export function deepestPoint(toolpath: Toolpath): Vec3 | undefined {
  let best: Vec3 | undefined
  for (const pass of toolpath.passes)
    for (const m of pass.moves) {
      const points: readonly Vec3[] =
        m.kind === 'drill'
          ? expandDrill(m).map((d) => d.to)
          : m.kind === 'rapid'
            ? [] // rapids never cut: the deepest cut is a feed
            : [m.to]
      for (const p of points) if (best === undefined || p[2] < best[2] - 1e-9) best = p
    }
  return best
}

export interface HolderGhostInput {
  /** The shown operation's `plan.operation.list` row. */
  readonly op: PlanOperationView | undefined
  /** The machine's holder (mm); undefined: no ghost. */
  readonly holder: HolderSizes | undefined
  /** The operation's tool (mm). */
  readonly tool: { readonly diameter: number; readonly shankDiameter?: number } | undefined
  /** Its toolpath while current (WCS); undefined when missing or outdated. */
  readonly toolpath: Toolpath | undefined
  readonly warnings: readonly PlanWarning[]
  /** The dimension label ("Stickout 25 mm · needs 36 mm"). */
  label(stickout: number, needed: number): string
}

/** The ghost of the shown operation, or undefined (see the header). */
export function holderGhost(input: HolderGhostInput): HolderGhostOverlay | undefined {
  const { op, holder, tool } = input
  if (op === undefined || holder === undefined || tool === undefined) return undefined
  const stickout = op.stickout
  const needed = op.stickoutNeeded
  const reason = op.stickoutReason
  if (stickout == null || needed == null || reason == null || reason.clamps === 'pending')
    return undefined
  // a holder collision of the operation: the ghost at its first hit, colliding
  const hit = input.warnings.find(
    (w) =>
      w.code === 'plan.workholding.collision' &&
      w.rule === 'holder' &&
      w.planOperationId === op.id &&
      typeof w.params['x'] === 'number' &&
      typeof w.params['y'] === 'number' &&
      typeof w.params['lowestZ'] === 'number',
  )
  const at: Vec3 | undefined =
    hit !== undefined
      ? [hit.params['x'] as number, hit.params['y'] as number, hit.params['lowestZ'] as number]
      : reason.kind === 'workholding' &&
          reason.x !== undefined &&
          reason.y !== undefined &&
          reason.z !== undefined
        ? [reason.x, reason.y, reason.z]
        : input.toolpath === undefined
          ? undefined
          : deepestPoint(input.toolpath)
  if (at === undefined) return undefined
  const parts = toolEnvelope(tool, stickout, holder).map((s) => ({
    part: s.part,
    radius: s.radius,
    zFrom: s.zFrom,
    zTo: Number.isFinite(s.zTo) ? s.zTo : s.zFrom + bodyShown(holder),
  }))
  return {
    key: `${op.id}:${at.join(',')}`,
    tip: at,
    parts,
    colliding: hit !== undefined,
    label: input.label(stickout, needed),
  }
}
