/**
 * Already-cut plan operations (hardening DF135, slice C1): a plan operation whose design
 * operations are all marked **already cut** in Design (`PartDTO.alreadyCut`, the plan's own copy)
 * is locked, left out of the program, and stays in the machining order as removed material. This
 * module derives the flag and holds the lock refusal, the order rule and `plan.cutSetupOrder`.
 * Doc: docs/modes/cut-state.md
 */
import { fail, type AppResult } from '../../shared/result'
import { alreadyCutOperations, cutChangedUnits } from '../design/already-cut'
import { unitOfOperation } from '../design/disabled'
import type { PartDTO } from '../design/part.dto'
import type { PlanWarning } from './checks'
import { planOpLabel } from './labels'
import type { LoadedPlan } from './plan'
import type { PlanDTO, PlanOperationDTO } from './plan.dto'

/** What the flag reads of a plan operation (DTOs, inputs, the agent summary's rows). */
export interface CutTestable {
  readonly designOperationIds: readonly string[]
  readonly aid?: unknown
}

/** Whether a plan operation is cut, by its design operations in `part`. */
export type CutTest = (op: CutTestable) => boolean

/**
 * The test of `part` (a plan's design copy): a plan operation is cut when it machines design
 * operations and all of them are already cut (an alignment aid never is).
 */
export function cutTest(part: PartDTO): CutTest {
  const cut = alreadyCutOperations(part)
  if (cut.size === 0) return () => false
  return (op) =>
    op.aid === undefined &&
    op.designOperationIds.length > 0 &&
    op.designOperationIds.every((d) => cut.has(d))
}

/** The ids of the plan's cut operations. */
export function cutIds(plan: PlanDTO): ReadonlySet<string> {
  const isCut = cutTest(plan.design.part)
  return new Set(plan.setups.flatMap((s) => s.operations.filter(isCut).map((o) => o.id)))
}

/**
 * The refusal of an edit to a cut operation (docs/modes/cut-state.md#what-a-cut-operation-means-in-its-plan):
 * `plan.status` like a read-only plan, rule `cut`.
 */
export function cutLocked(plan: PlanDTO, op: PlanOperationDTO, where: string): AppResult<never> {
  const label = planOpLabel(plan.design.part, op)
  const message = `${label} is already cut; mark it not cut in Design to change it`
  return fail('plan.status', message, {
    issues: [
      { path: ['planOperationId'], rule: 'cut', message, params: { planOperationId: op.id } },
    ],
    where,
    data: { planId: plan.id, planOperationId: op.id },
  })
}

/** The first cut operation among `ids` of the plan, if any. */
export function firstCut(plan: PlanDTO, ids: readonly string[]): PlanOperationDTO | undefined {
  const isCut = cutTest(plan.design.part)
  for (const s of plan.setups)
    for (const op of s.operations) if (ids.includes(op.id) && isCut(op)) return op
  return undefined
}

/**
 * `plan.cutSetupOrder` (warning: an uncut operation in a setup before one with cut operations
 * needs the part flipped back). Doc: docs/modes/cut-state.md#setups-and-work-zero
 */
export function cutFindings(plan: LoadedPlan): PlanWarning[] {
  const out: PlanWarning[] = []
  const part = plan.dto.design.part
  const isCut = cutTest(part)
  out.push(...cutChangedFindings(plan))
  const lastCut = plan.setups.findLastIndex((s) => s.operations.some(isCut))
  if (lastCut < 0) return out
  const later = plan.setups[lastCut]!
  plan.setups.forEach((s, si) => {
    if (si >= lastCut) return
    for (const op of s.operations) {
      if (isCut(op)) continue
      out.push({
        code: 'plan.cutSetupOrder',
        severity: 'warning',
        message: `${planOpLabel(part, op)} on ${s.name} is not cut, but ${later.name} is: cutting it needs the part flipped back`,
        planOperationId: op.id,
        rule: 'cutSetupOrder',
        params: { setupId: s.id, cutSetupId: later.id },
      })
    }
  })
  return out
}

/** A top-level unit's name in the design (the operation's or the feature's). */
function unitName(part: PartDTO, id: string): string {
  return (
    part.operations.find((o) => o.id === id)?.name ??
    part.features?.find((f) => f.id === id)?.name ??
    id
  )
}

/**
 * `plan.cutChanged` (DF135 C2, Q198 as revised: warning): a plan operation machining a unit that
 * a run marked already cut and whose geometry was edited since. Marks set by hand never warn.
 * Doc: docs/modes/cut-state.md#editing-an-already-cut-operation
 */
function cutChangedFindings(plan: LoadedPlan): PlanWarning[] {
  const part = plan.dto.design.part
  const changed = cutChangedUnits(part)
  if (changed.size === 0) return []
  const out: PlanWarning[] = []
  for (const s of plan.setups)
    for (const op of s.operations) {
      const unit = op.designOperationIds
        .map((d) => unitOfOperation(part, d))
        .find((u) => changed.has(u))
      if (unit === undefined) continue
      const at = part.alreadyCutMarks?.[unit]?.at
      out.push({
        code: 'plan.cutChanged',
        severity: 'warning',
        message: `${unitName(part, unit)} changed since the run cut it`,
        planOperationId: op.id,
        rule: 'cutChanged',
        params: { unitId: unit, ...(at === undefined ? {} : { markedAt: at }) },
      })
    }
  return out
}

/**
 * A setup's operations with the cut ones first, each group in its order (cut operations were
 * machined before every uncut one: docs/modes/cut-state.md#what-a-cut-operation-means-in-its-plan).
 */
export function cutFirst<T extends CutTestable>(ops: readonly T[], isCut: CutTest): T[] {
  return [...ops.filter(isCut), ...ops.filter((o) => !isCut(o))]
}
