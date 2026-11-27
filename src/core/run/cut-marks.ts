/**
 * Marks from Run (hardening DF135 C2): which plan operations a run finished, from the run's own
 * record (the first line of each operation in the streamed program and where the run ended), and
 * which design units that makes already cut. A real `done` run of an unchanged program marks
 * them; a stopped or interrupted run offers its finished operations once no resume is pending; the
 * virtual machine marks nothing (practising). Pure and headless: `MachineClient` records the
 * finished operations in `lastRun`, Run's UI decides with `runCutMarks`.
 * Doc: docs/modes/cut-state.md#marking, #implementation-c2
 */
import { alreadyCutOperations, recutUnits, roughingOwnerOf } from '../design/already-cut'
import { topLevelUnits, unitOfOperation } from '../design/disabled'
import type { PartDTO } from '../design/part.dto'
import type { PlanDTO } from '../plan/plan.dto'
import { runPlanHash } from './plan-hash'
import type { LastRun } from './service'

/** A plan operation's first line in the streamed program (`JobAbout.operations`). */
export interface OperationStart {
  readonly planOperationId: string
  readonly fromLine: number
}

/**
 * The plan operations a run finished, in program order: every streamed one for a `done` run;
 * otherwise those before `stoppedIn`, the earliest operation the machine may still have been
 * executing (`stoppedOperation`: the acknowledged lines minus a full planner, or the operation
 * of the tool change it waited at). The operation in progress is never finished (Q197).
 */
export function finishedOperations(
  operations: readonly OperationStart[],
  outcome: LastRun['outcome'],
  stoppedIn: string | undefined,
): string[] {
  const ordered = [...operations].sort((a, b) => a.fromLine - b.fromLine)
  if (outcome === 'done') return ordered.map((o) => o.planOperationId)
  if (stoppedIn === undefined) return []
  const out: string[] = []
  for (const o of ordered) {
    if (o.planOperationId === stoppedIn) break
    out.push(o.planOperationId)
  }
  return out
}

/**
 * What a run that started part-way (a resume, a start at an operation or a line) keeps of the
 * run before it: the operations that run finished and this one does not stream, when both machine
 * the same plan, setup and program (`planHash`). A run from the beginning streams them all, so it
 * keeps nothing.
 */
export function carriedFinished(
  before: LastRun | undefined,
  next: { readonly planId: string; readonly setupId: string; readonly planHash?: string },
  streamed: readonly OperationStart[],
): string[] {
  if (before?.finished === undefined || before.planId !== next.planId) return []
  if (before.setupId !== next.setupId || before.planHash !== next.planHash) return []
  const ids = new Set(streamed.map((o) => o.planOperationId))
  return before.finished.filter((id) => !ids.has(id))
}

/**
 * The top-level units of the plan's design copy that `finished` plan operations cut in full, in
 * design order, minus those `live` (the design as it is now) already lists (unless recut, C4) or no
 * longer has. A unit
 * is cut when each of its design operations (a roughing pass follows its owner) is already cut or
 * machined only by finished plan operations, and at least one by this run.
 */
export function finishedUnits(plan: PlanDTO, finished: readonly string[], live: PartDTO): string[] {
  const part = plan.design.part
  const done = new Set(finished)
  const cut = alreadyCutOperations(part)
  const machinedBy = new Map<string, string[]>()
  for (const s of plan.setups)
    for (const op of s.operations)
      for (const d of op.designOperationIds)
        machinedBy.set(d, [...(machinedBy.get(d) ?? []), op.id])
  const listed = new Set(live.alreadyCut ?? [])
  // C4: a recut unit (edited since a run cut it) the run cut again is marked anew
  const recut = recutUnits(live)
  const known = new Set(topLevelUnits(live))
  const out: string[] = []
  for (const unit of topLevelUnits(part)) {
    if ((listed.has(unit) && !recut.has(unit)) || !known.has(unit)) continue
    const ops = part.operations.filter(
      (o) => unitOfOperation(part, o.id) === unit && roughingOwnerOf(o) === undefined,
    )
    if (ops.length === 0) continue
    let byRun = false
    const all = ops.every((o) => {
      if (cut.has(o.id)) return true
      const by = machinedBy.get(o.id) ?? []
      if (by.length === 0 || !by.every((p) => done.has(p))) return false
      byRun = true
      return true
    })
    if (all && byRun) out.push(unit)
  }
  return out
}

/** Why a run marks nothing (Run's notice says it where it helps). */
export type NoMarkReason = 'notReal' | 'notPlan' | 'changed' | 'nothing' | 'resumePending'

/** What Run does with the design marks after run `lastRun` (docs/modes/cut-state.md#marking). */
export type RunCutMarks =
  /** A real `done` run of an unchanged program: mark at once, with Undo. */
  | { readonly kind: 'mark'; readonly planId: string; readonly units: readonly string[] }
  /** A stopped, failed or interrupted run, no resume pending: offer the finished operations. */
  | { readonly kind: 'offer'; readonly planId: string; readonly units: readonly string[] }
  | { readonly kind: 'none'; readonly reason: NoMarkReason }

/**
 * The marks of the last run on `plan` (as it is now, with the design `live`): `mark` after a real
 * `done` run, `offer` after a real run that ended otherwise once no interruption waits for a
 * resume, `none` on the virtual machine (`lastRun.real` absent), for a file run, a plan changed
 * since the export (`planHash` differs) or when nothing new finished.
 */
export function runCutMarks(
  lastRun: LastRun | undefined,
  plan: PlanDTO | undefined,
  live: PartDTO | undefined,
): RunCutMarks {
  if (lastRun === undefined || lastRun.planId === undefined || lastRun.setupId === undefined)
    return { kind: 'none', reason: 'notPlan' }
  if (lastRun.real !== true) return { kind: 'none', reason: 'notReal' }
  if (plan === undefined || live === undefined || plan.id !== lastRun.planId)
    return { kind: 'none', reason: 'notPlan' }
  if (lastRun.planHash === undefined || lastRun.planHash !== runPlanHash(plan, lastRun.setupId))
    return { kind: 'none', reason: 'changed' }
  if (lastRun.outcome !== 'done' && lastRun.interruption !== undefined)
    return { kind: 'none', reason: 'resumePending' }
  const units = finishedUnits(plan, lastRun.finished ?? [], live)
  if (units.length === 0) return { kind: 'none', reason: 'nothing' }
  return { kind: lastRun.outcome === 'done' ? 'mark' : 'offer', planId: plan.id, units }
}

/**
 * The `design.part.update` arguments that mark `units` (a run's, `runCutMarks`) on `live`: the
 * list with the new ones added, and the listed ones (recut units, C4) as `recut` so the run marks
 * them anew. Doc: docs/modes/cut-state.md#cutting-only-the-difference-c4
 */
export function runMarkUpdate(
  live: PartDTO,
  units: readonly string[],
): { alreadyCut: string[]; recut?: string[] } {
  const list = live.alreadyCut ?? []
  const recut = units.filter((u) => list.includes(u))
  return {
    alreadyCut: [...list, ...units.filter((u) => !list.includes(u))],
    ...(recut.length === 0 ? {} : { recut }),
  }
}
