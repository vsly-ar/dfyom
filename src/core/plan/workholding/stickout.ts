/**
 * The clamp term of the minimum stickout (hardening DF132 H3): how high a workholding item under
 * the collet nut (or the spindle body) sits above the tool tip along the toolpath. The minimum
 * stickout becomes max(deepest cut, clamp term) + `STICKOUT_CLEARANCE`; without a holder or
 * without items it is DF130's deepest cut + 5 mm exactly.
 * Doc: docs/modes/tool-holder.md#minimum-stickout-gains-the-clamp-term
 *
 * Pure and headless; mm in the setup frame (as `checkWorkholding`).
 */
import type { Vec3 } from '../../toolpath/model'
import { STICKOUT_CLEARANCE } from '../checks'
import { checkMoves, moveSegments, type CheckOperation } from './check'
import { segmentDistance, type Prism } from './obstacles'

export interface ClampTerm {
  /**
   * The stickout less `STICKOUT_CLEARANCE` that keeps the part above the item on every move whose
   * part disc (radius + margin) meets the item's footprint: item top − tip Z (the body: − the nut
   * length), plus the margin's excess over `STICKOUT_CLEARANCE` (mm, not rounded).
   */
  readonly term: number
  readonly itemId: string
  readonly part: 'nut' | 'body'
  /** Index of the deciding move in its operation's expanded move list. */
  readonly moveIndex: number
  /** The deciding move's point nearest the item (XY) at the move's lowest Z. */
  readonly at: Vec3
}

/**
 * The clamp term per operation (by plan operation id) over every move of the program, links and
 * rapids included (moves at the clearance height never decide it); only operations whose tool has
 * a holder. A move counts with its lowest Z (as the collision check does), so the term never
 * falls below the stickout `checkWorkholding` asks for.
 */
export function clampTerms(input: {
  readonly operations: readonly CheckOperation[]
  readonly prisms: readonly Prism[]
  readonly margin: number
}): Map<string, ClampTerm> {
  const { prisms, margin } = input
  const out = new Map<string, ClampTerm>()
  // a margin over the read-out's 5 mm would leave the read-out inside the check's margin
  const extra = Math.max(0, margin - STICKOUT_CLEARANCE)
  let pos: Vec3 | undefined
  for (const op of input.operations) {
    const holder = op.tool.holder
    const moves = checkMoves(op)
    if (holder === undefined || prisms.length === 0) {
      pos = moves.at(-1)?.to ?? pos
      continue
    }
    const parts = [
      { part: 'nut' as const, reach: holder.nutDiameter / 2 + margin, above: 0 },
      { part: 'body' as const, reach: holder.bodyDiameter / 2 + margin, above: holder.nutLength },
    ]
    let best: ClampTerm | undefined
    moves.forEach((m, moveIndex) => {
      const start: Vec3 = pos ?? m.to
      pos = m.to
      for (const s of moveSegments(start, m)) {
        const lowest = Math.min(s.a[2], s.b[2])
        for (const p of prisms)
          for (const e of parts) {
            const term = p.zMax - lowest - e.above + extra
            // only a term above the best so far (and above the stock top) can decide
            if (term <= Math.max(0, best?.term ?? 0) + 1e-9) continue
            const d = segmentDistance(p.footprint, [s.a[0], s.a[1]], [s.b[0], s.b[1]])
            if (d.distance - s.slack >= e.reach) continue
            best = {
              term,
              itemId: p.itemId,
              part: e.part,
              moveIndex,
              at: [d.at[0], d.at[1], lowest],
            }
          }
      }
    })
    if (best !== undefined) out.set(op.planOperationId, best)
  }
  return out
}

/** The minimum stickout of an operation and what decides it. */
export interface StickoutNeed {
  /** mm, not rounded: max(DF130's deepest cut + 5, clamp term + 5). */
  readonly needed: number
  /** `cut` (DF130's deepest cut, also on a tie) or `workholding` (the clamp term). */
  readonly kind: 'cut' | 'workholding'
  readonly clamp?: ClampTerm
}

/**
 * An operation's minimum stickout from DF130's value (`deepest`, deepest cut + 5 mm) and its clamp
 * term: the clamp decides only when it needs more.
 */
export function stickoutNeed(deepest: number, clamp: ClampTerm | undefined): StickoutNeed {
  if (clamp === undefined || clamp.term + STICKOUT_CLEARANCE <= deepest + 1e-9)
    return { needed: deepest, kind: 'cut' }
  return { needed: clamp.term + STICKOUT_CLEARANCE, kind: 'workholding', clamp }
}
