/**
 * The run job (`run.job.start { planId }`): checks, export with the connected G54, the soft-limit
 * refusal, streaming on the machine host with progress, and the job's pause/abort mapping.
 * Doc: docs/modes/run-v0.1.md#run-job
 */
import { z } from 'zod'
import { Err, fail, Ok, type AppResult, type AsyncAppResult } from '../../shared/result'
import type { JobContext, Services } from '../commands/context'
import { defineCommand } from '../commands/define'
import { PlanWarningSchema, type PlanWarning } from '../plan/checks'
import { PlanIdSchema } from '../plan/plan.dto'
import { findPlanDTO } from '../plan/plan'
import { machineKeyOf } from './machine-key'
import { checkAllowed } from '../plan/status'
import type { ProjectDoc } from '../project/document'
import { commentLine } from '../post/grbl/format'
import type { GrblExport } from '../post/export'
import { exportPlan } from '../post/plan-export'
import type { SenderProgram } from './grbl/sender'
import { RunSummarySchema } from './host/protocol'
import type { MachineService, RunningJob } from './service'

const MARKER = /^\(DFYOM TOOL CHANGE (\d+): ([^()]*)\)$/

/**
 * Progress labels from the program: the operation comments (`pocket1`) and the tool of each
 * marker, so a label reads `pocket1 · tool 2: 6 mm end mill`.
 */
export function programSections(e: GrblExport): SenderProgram['sections'] {
  const labels = new Set(
    e.program.blocks.flatMap((b) => (b.kind === 'comment' ? [commentLine(b.text)] : [])),
  )
  const sections: { fromLine: number; label: string }[] = []
  let op = ''
  let tool = ''
  e.lines.forEach((line, i) => {
    const m = MARKER.exec(line)
    if (m) tool = `tool ${m[1]}: ${m[2]}`
    else if (labels.has(line)) op = line.slice(1, -1)
    else return
    const label = [op, tool].filter((x) => x !== '').join(' · ')
    if (sections.at(-1)?.label !== label) sections.push({ fromLine: i + 1, label })
  })
  return sections
}

export function machineOf(services: Services, where: string): AppResult<MachineService> {
  const m = services.machine
  if (m?.target === undefined)
    return fail('run.notConnected', 'connect to the virtual machine first', { where })
  return Ok(m)
}

const RunJobResult = RunSummarySchema.extend({
  warnings: z
    .array(PlanWarningSchema)
    .describe('plan.machine findings of the export other than softLimit'),
})
type RunJobResult = z.output<typeof RunJobResult>

/** Maps `job.pause`/`job.resume` to hold/resume and `job.abort` to the controlled stop. */
function bindJobControl(m: MachineService, ctx: JobContext): () => void {
  const off = ctx.pause.onChange((paused) => {
    void m.controlJob(ctx.jobId, paused ? 'hold' : 'resume')
  })
  const abort = () => void m.controlJob(ctx.jobId, 'stop')
  ctx.signal.addEventListener('abort', abort, { once: true })
  return () => {
    off()
    ctx.signal.removeEventListener('abort', abort)
  }
}

async function runJob(
  doc: ProjectDoc,
  planId: string,
  ctx: JobContext,
): AsyncAppResult<RunJobResult> {
  const where = 'run.job.start'
  // 1. checks
  const machine = machineOf(ctx.services, where)
  if (machine.isErr()) return machine
  const m = machine.unwrap()
  const status = m.status()
  if (status.job !== undefined || status.connection.state !== 'open')
    return fail(
      'run.busy',
      status.job ? `job ${status.job.jobId} is running` : 'still connecting',
      {
        where,
      },
    )
  if (status.state !== 'Idle' || !status.homed)
    return fail(
      'run.state',
      `the machine must be Idle and homed (is ${status.state}${status.homed ? '' : ', not homed'})`,
      {
        where,
        data: { state: status.state, homed: status.homed },
      },
    )
  const plan = findPlanDTO(doc, planId, where)
  if (plan.isErr()) return plan
  const allowed = checkAllowed(planId, plan.unwrap().status, where)
  if (allowed.isErr()) return allowed
  const key = machineKeyOf(doc, planId, where)
  if (key.isErr()) return key
  if (key.unwrap() === undefined)
    return fail('post.noMachine', 'the plan has no machine', { where, data: { planId } })
  if (key.unwrap() !== m.machineKey)
    return fail('run.state', "the virtual machine emulates another machine than this plan's", {
      where,
      data: { state: status.state },
      issues: [
        {
          path: ['planId'],
          rule: 'machineMismatch',
          message: 'connect with this plan to emulate its machine copy',
        },
      ],
    })
  // From here to the stream the connection is held for this job: no jog or work-zero change
  // slips in between the soft-limit check and the start (the host re-checks the G54 anyway).
  const reserved = m.reserve(ctx.jobId)
  if (reserved.isErr()) return reserved
  const started = await checkAndStart(doc, planId, ctx, m, status.workZero, key.unwrap() ?? '')
  m.release(ctx.jobId)
  if (started.isErr()) return started
  const { running, warnings } = started.unwrap()
  const unbind = bindJobControl(m, ctx)
  if (ctx.pause.paused) void m.controlJob(ctx.jobId, 'hold')
  // 5. end
  const ended = await running.ended
  unbind()
  if (ended.isErr()) return Err(ended.unwrapErr().withContext(where, { planId }))
  return Ok({ ...ended.unwrap(), warnings })
}

/** Steps 2–4 while the connection is reserved for the job. */
async function checkAndStart(
  doc: ProjectDoc,
  planId: string,
  ctx: JobContext,
  m: MachineService,
  workZero: readonly [number, number, number],
  machineKey: string,
): AsyncAppResult<{ running: RunningJob; warnings: PlanWarning[] }> {
  const where = 'run.job.start'
  const status = { workZero }
  // 2. program, exported with the live G54
  const exported = await exportPlan(doc, planId, ctx.services, {
    workZero: status.workZero,
    signal: ctx.signal,
    progress: (p) => ctx.progress({ done: 0, label: `Export: ${p.label ?? ''}`.trim() }),
  })
  if (exported.isErr()) return exported
  const e = exported.unwrap()
  // 3. soft limits refuse the start (decision 8)
  const soft = e.warnings.filter((w) => w.rule === 'softLimit')
  if (soft.length > 0)
    return fail('run.softLimit', `${soft.length} soft-limit finding(s) at the current work zero`, {
      where,
      data: { planId, workZero: [...status.workZero], findings: soft },
    })
  const warnings: PlanWarning[] = e.warnings.filter((w) => w.rule !== 'softLimit')
  if (ctx.signal.aborted)
    return fail('op.aborted', 'the run was aborted before it started', { where })
  // 4. stream
  const prefix = warnings.length > 0 ? `${warnings.length} machine warning(s) · ` : ''
  // before the stream starts: the host's progress ticks may arrive before startJob resolves,
  // and this tick must not overwrite them (done never goes back)
  ctx.progress({ done: 0, total: e.lines.length, label: `${prefix}started` })
  // the host refuses if the G54, the machine copy or the target changed since the check
  const started = await m.startJob(
    ctx.jobId,
    { lines: e.lines, sections: programSections(e) },
    {
      progress: (p) => ctx.progress({ done: p.done, total: p.total, label: `${prefix}${p.label}` }),
      phase: () => {},
    },
    { workZero, machineKey },
  )
  if (started.isErr()) return Err(started.unwrapErr().withContext(where, { planId }))
  return Ok({ running: started.unwrap(), warnings })
}

export const runJobStart = defineCommand({
  kind: 'job',
  name: 'run.job.start',
  summary:
    "Run a plan's program on the connected virtual machine: exports it with the live work zero, refuses soft-limit violations, streams it and waits at each tool change for run.job.continue.",
  title: () => 'Run plan',
  machine: true,
  // apply first: docs/architecture/apply.md#implicit-apply
  applyFirst: true,
  args: z.object({ planId: PlanIdSchema }),
  result: RunJobResult,
  run: (doc, args, ctx) => runJob(doc, args.planId, ctx),
})
