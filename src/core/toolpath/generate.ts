/**
 * `plan.toolpath.generate` (job) and `plan.toolpath.get` (query): generators run on the
 * `toolpath` worker lane, one plan operation after another; results go to the project's
 * `ToolpathCache`. Docs: docs/architecture/workers.md#toolpath-cache,
 * docs/modes/plan-v0.1.md#toolpath-generation-job
 */
import { z } from 'zod'
import type { AppError } from '../../shared/errors/app-error'
import { AppErrorDataSchema } from '../../shared/errors/schema'
import { fail, Ok, tryAsync, type AppResult, type AsyncAppResult } from '../../shared/result'
import type { QueryContext } from '../commands/context'
import type { WorkerControl, WorkerPort } from '../commands/jobs'
import type { Region2dPort } from '../geometry/2d/port'
import type { PlanOperationInput } from '../plan/inputs'
import { defineCommand, defineQuery } from '../commands/define'
import { planOperationInputs } from '../plan/inputs'
import { planPendingApply } from '../plan/pending'
import { PlanIdSchema, PlanRecordIdSchema } from '../plan/plan.dto'
import { toolpathGenerate } from '../workers/tasks'
import type { ToolpathCache } from './cache'
import { toGeneratorInputs } from './inputs'
import type { Toolpath } from './model'
import { ToolpathSchema } from './schemas'

const ErrorSchema = AppErrorDataSchema

export const OPERATION_OUTCOMES = ['generated', 'cached', 'failed'] as const

const OperationOutcome = z.object({
  planOperationId: z.string(),
  status: z.enum(OPERATION_OUTCOMES),
  error: ErrorSchema.optional().describe('Only when failed'),
})
type OperationOutcome = z.output<typeof OperationOutcome>

export function cacheOf(
  services: QueryContext['services'],
  where: string,
): AppResult<ToolpathCache> {
  return services.toolpaths === undefined
    ? fail('internal.unexpected', 'no toolpath cache configured', { where })
    : Ok(services.toolpaths)
}

const failed = (planOperationId: string, e: AppError): OperationOutcome => ({
  planOperationId,
  status: 'failed',
  error: e.toJSON(),
})

/**
 * The current toolpath of one plan operation: the cache entry for its `inputHash`, else
 * generated on the `toolpath` lane and stored. Shared by the job and the export.
 */
export async function ensureToolpath(
  cache: ToolpathCache,
  workers: WorkerPort,
  input: PlanOperationInput,
  ctl: WorkerControl,
  region2d?: Region2dPort,
): AsyncAppResult<{ toolpath: Toolpath; status: 'generated' | 'cached' }> {
  const hit = cache.get(input.inputHash)
  if (hit !== undefined) {
    cache.remember(input.planId, input.planOperationId, input.inputHash)
    return Ok({ toolpath: hit, status: 'cached' })
  }
  const request = toGeneratorInputs(input, region2d)
  if (request.isErr()) return request
  const tp = await workers.run(toolpathGenerate, request.unwrap(), ctl)
  if (tp.isErr()) return tp
  cache.set(input.planId, input.planOperationId, input.inputHash, tp.unwrap())
  return Ok({ toolpath: tp.unwrap(), status: 'generated' })
}

export const toolpathGenerateJob = defineCommand({
  kind: 'job',
  name: 'plan.toolpath.generate',
  summary:
    'Generate the toolpaths of a plan (or of some plan operations) in machining order; reports each operation as generated, cached or failed.',
  title: () => 'Generate toolpaths',
  machine: false,
  args: z.object({
    planId: PlanIdSchema,
    planOperationIds: z
      .array(PlanRecordIdSchema)
      .optional()
      .describe('Only these plan operations; default all'),
  }),
  result: z.object({ operations: z.array(OperationOutcome) }),
  async run(doc, args, ctx) {
    const where = 'plan.toolpath.generate'
    const cache = cacheOf(ctx.services, where)
    if (cache.isErr()) return cache
    // plan.check / plan.order findings fail the job before any worker runs
    const inputs = planOperationInputs(
      doc,
      args.planId,
      args.planOperationIds,
      ctx.services.region2d,
    )
    if (inputs.isErr()) return inputs
    const all = inputs.unwrap()
    const total = all.length
    const operations: OperationOutcome[] = []
    const completed: string[] = []
    const abortedJob = () =>
      fail('op.aborted', `${where} was aborted`, { where, data: { completed } })
    for (const [i, input] of all.entries()) {
      const id = input.planOperationId
      const cp = await tryAsync(() => ctx.checkpoint(), 'op.aborted', 'checkpoint')
      if (cp.isErr()) return abortedJob()
      ctx.progress({ done: i, total, label: id })
      const tp = await ensureToolpath(
        cache.unwrap(),
        ctx.services.workers,
        input,
        {
          // no `pause`: a paused job parks between plan operations (`ctx.checkpoint()`), never
          // the single toolpath worker, which other jobs share
          signal: ctx.signal,
          progress: (p) =>
            ctx.progress({
              done: i,
              total,
              label: p.label === undefined ? id : `${id}: ${p.label}`,
            }),
        },
        ctx.services.region2d,
      )
      if (tp.isErr()) {
        if (tp.unwrapErr().code === 'op.aborted') return abortedJob()
        operations.push(failed(id, tp.unwrapErr()))
        continue
      }
      operations.push({ planOperationId: id, status: tp.unwrap().status })
      completed.push(id)
    }
    ctx.progress({ done: total, total })
    return Ok({ operations })
  },
})

export const toolpathGet = defineQuery({
  name: 'plan.toolpath.get',
  summary:
    "Get a plan operation's toolpath for preview: the current one (stale: false), else the last generated one (stale: true), else null.",
  args: z.object({ planId: PlanIdSchema, planOperationId: PlanRecordIdSchema }),
  result: z.object({
    toolpath: ToolpathSchema.nullable(),
    stale: z.boolean().describe('True unless the toolpath matches the current inputs'),
    pendingApply: z
      .boolean()
      .describe("The plan's inputs have changes not applied yet: regenerated on Apply"),
  }),
  run(doc, args, ctx) {
    const where = 'plan.toolpath.get'
    const cache = cacheOf(ctx.services, where)
    if (cache.isErr()) return cache
    const plan = doc.plans[args.planId]
    if (plan === undefined || !Object.hasOwn(doc.plans, args.planId))
      return fail('input.malformed', `plan ${args.planId} does not exist`, {
        issues: [{ path: ['planId'], rule: 'unknownPlan', message: 'no such plan' }],
        where,
      })
    if (!plan.setups.some((s) => s.operations.some((o) => o.id === args.planOperationId)))
      return fail('input.malformed', `plan operation ${args.planOperationId} does not exist`, {
        issues: [
          {
            path: ['planOperationId'],
            rule: 'unknownPlanOperation',
            message: 'no such plan operation',
          },
        ],
        where,
      })
    // inputs with error findings have no current toolpath: fall back to the last one
    const inputs = planOperationInputs(
      doc,
      args.planId,
      [args.planOperationId],
      ctx.services.region2d,
    )
    const hash = inputs.isOk() ? inputs.unwrap()[0]?.inputHash : undefined
    const current = hash === undefined ? undefined : cache.unwrap().get(hash)
    const pendingApply = planPendingApply(plan, ctx.apply?.pending() ?? [])
    if (current !== undefined) return Ok({ toolpath: current, stale: false, pendingApply })
    const last = cache.unwrap().last(args.planId, args.planOperationId)
    return Ok({ toolpath: last?.toolpath ?? null, stale: true, pendingApply })
  },
})
