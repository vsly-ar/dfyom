/**
 * A plan loaded from its DTO: the plan's part (its design snapshot) and its own library copies
 * as models. Plans read only their own copies, never the current design or library.
 * Doc: docs/modes/plan-v0.1.md#plan-record
 */
import { Err, fail, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import { partFromDTO, type Operation, type Part } from '../design/operation'
import { Machine } from '../library/machine'
import { Snapshot, type SnapshotDTO } from '../library/snapshot'
import { Stock } from '../library/stock'
import { Tool } from '../library/tool'
import type { ProjectDoc, UnitSystem } from '../project/document'
import { feedModeIssues } from './feeds'
import type { PlanDTO, PlanOperationDTO, SetupDTO } from './plan.dto'

export interface LoadedPlan {
  readonly dto: PlanDTO
  /** The plan's version of the part (design snapshot with plan-only edits). */
  readonly part: Part
  readonly stock: Stock
  readonly units: UnitSystem
  /** Tool copies by snapshot id. */
  readonly tools: ReadonlyMap<string, Tool>
  readonly machine: Option<Machine>
  /** v0.1: the only setup. */
  readonly setup: SetupDTO
}

export function unknownPlan(planId: string, where: string): AppResult<never> {
  return fail('input.malformed', `plan ${planId} does not exist`, {
    issues: [{ path: ['planId'], rule: 'unknownPlan', message: 'no such plan' }],
    where,
  })
}

export function findPlanDTO(doc: ProjectDoc, planId: string, where: string): AppResult<PlanDTO> {
  const plan = Object.hasOwn(doc.plans, planId) ? doc.plans[planId] : undefined
  return plan === undefined ? unknownPlan(planId, where) : Ok(plan)
}

export function snapshotById(plan: PlanDTO, id: string): SnapshotDTO | undefined {
  return plan.snapshots.find((s) => s.id === id)
}

function broken(plan: PlanDTO, message: string, where: string): AppResult<never> {
  return fail('input.malformed', `plan ${plan.id}: ${message}`, {
    where,
    data: { planId: plan.id },
  })
}

/** Models of a plan's copies; a broken record is `input.malformed`. */
export function loadPlanDTO(
  plan: PlanDTO,
  units: UnitSystem,
  where: string,
): AppResult<LoadedPlan> {
  const part = partFromDTO(plan.design.part)
  if (part.isErr()) return Err(part.unwrapErr().prefixIssues('design', 'part').withContext(where))
  const models = new Map<string, Snapshot>()
  for (const dto of plan.snapshots) {
    const s = Snapshot.fromDTO(dto)
    if (s.isErr()) return Err(s.unwrapErr().prefixIssues('snapshots', dto.id).withContext(where))
    models.set(dto.id, s.unwrap())
  }
  const stock = models.get(plan.design.part.stock)?.values
  if (!(stock instanceof Stock)) return broken(plan, 'the stock copy is missing', where)
  const tools = new Map<string, Tool>()
  for (const [id, s] of models) if (s.values instanceof Tool) tools.set(id, s.values)
  let machine: Option<Machine> = None
  if (plan.machine !== undefined) {
    const m = models.get(plan.machine)?.values
    if (!(m instanceof Machine)) return broken(plan, 'the machine copy is missing', where)
    machine = Some(m)
  }
  const setup = plan.setups[0]
  if (setup === undefined) return broken(plan, 'the plan has no setup', where)
  for (const op of setup.operations) {
    if (op.tool !== undefined && !tools.has(op.tool))
      return broken(plan, `the tool copy of ${op.id} is missing`, where)
    const kind = part.unwrap().operations.find((o) => o.id === op.designOperationIds[0])?.kind
    const issues = kind === undefined ? [] : feedModeIssues(op, kind)
    if (issues.length > 0)
      return fail('model.invariant', `plan ${plan.id}: ${op.id} has invalid locks`, {
        issues: issues.map((i) => ({ ...i, path: ['setups', 0, 'operations', op.id, ...i.path] })),
        where,
        data: { planId: plan.id },
      })
  }
  return Ok({ dto: plan, part: part.unwrap(), stock, units, tools, machine, setup })
}

export function loadPlan(doc: ProjectDoc, planId: string, where: string): AppResult<LoadedPlan> {
  return findPlanDTO(doc, planId, where).andThen((p) => loadPlanDTO(p, doc.unitSystem, where))
}

/** The design operations a plan operation machines, in the plan's part (missing ids skipped). */
export function designOperations(plan: LoadedPlan, op: PlanOperationDTO): Operation[] {
  return op.designOperationIds.flatMap((id) => {
    const found = plan.part.operations.find((o) => o.id === id)
    return found === undefined ? [] : [found]
  })
}

export function findPlanOperation(
  plan: LoadedPlan,
  planOperationId: string,
  where: string,
): AppResult<number> {
  const i = plan.setup.operations.findIndex((o) => o.id === planOperationId)
  if (i >= 0) return Ok(i)
  return fail('input.malformed', `plan operation ${planOperationId} does not exist`, {
    issues: [{ path: ['planOperationId'], rule: 'unknownPlanOperation', message: 'no such one' }],
    where,
  })
}
