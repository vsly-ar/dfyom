/**
 * The run job (`run.job.start { planId, setupId? }`): checks, export of the setup's program with the
 * connected G54, the soft-limit refusal, streaming on the machine host with progress, and the
 * job's pause/abort mapping. One job per setup: the result names the next setup, which the
 * setup-change prompt runs after re-fixturing (task E2).
 * Doc: docs/modes/run-v0.1.md#run-job, docs/modes/plan-v0.2.md#implementation-task-e2
 */
import { z } from 'zod'
import { Err, fail, Ok, type AppResult, type AsyncAppResult } from '../../shared/result'
import type { JobContext, Services } from '../commands/context'
import { defineCommand } from '../commands/define'
import { PlanWarningSchema, type PlanWarning } from '../plan/checks'
import { PlanIdSchema, PlanRecordIdSchema, type SetupDTO } from '../plan/plan.dto'
import { findPlanDTO } from '../plan/plan'
import { machineKeyOf } from './machine-key'
import { chooseSetup, setupDirection, setupRotation } from '../plan/setups'
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

const NextSetupSchema = z.object({
  setupId: z.string(),
  name: z.string(),
  direction: z.string().describe('Part direction up to the spindle'),
  rotation: z.number().int().describe('Quarter turn about machine +Z, degrees'),
})

const RunJobResult = RunSummarySchema.extend({
  warnings: z
    .array(PlanWarningSchema)
    .describe('plan.machine findings of the export other than softLimit'),
  planId: z.string().describe('The plan this run machined'),
  setupId: z.string().describe('The setup this run machined'),
  next: NextSetupSchema.optional().describe(
    'The next setup: re-fixture, set its work zero, then run.job.start with its setupId',
  ),
})
type RunJobResult = z.output<typeof RunJobResult>

/** What the setup-change prompt and agents need about the next setup. */
export function nextSetupOf(setup: SetupDTO): z.output<typeof NextSetupSchema> {
  return {
    setupId: setup.id,
    name: setup.name,
    direction: setupDirection(setup),
    rotation: setupRotation(setup),
  }
}

/** Maps `job.pause`/`job.resume` to hold/resume and `job.abort` to the controlled stop. */
function bindJobControl(m: MachineService, ctx: JobContext): () => void {
  const off = ctx.pause.onChange((paused) => {
    void m.controlJob(ctx.jobId, paused ? 'hold' : 'resume')
  })
  const abort = () => void m.controlJob(ctx.jobId, 'stop')
  // An abort while the start was in flight (the host already streams, its reply not yet here)
  // has fired before this listener existed: stop now, or the job runs on (hardening P1).
  if (ctx.signal.aborted) abort()
  else ctx.signal.addEventListener('abort', abort, { once: true })
  return () => {
    off()
    ctx.signal.removeEventListener('abort', abort)
  }
}

/**
 * Step 1 of the run job, shared with `run.job.check` (DF46): connected, no job, Idle and homed,
 * the plan runnable, the setup chosen, the plan's machine copy the connected one.
 */
function startChecks(
  doc: ProjectDoc,
  planId: string,
  setupId: string | undefined,
  services: Services,
  where: string,
): AppResult<{
  m: MachineService
  workZero: readonly [number, number, number]
  setup: SetupDTO
  next: SetupDTO | undefined
  machineKey: string
}> {
  const machine = machineOf(services, where)
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
  // one program per setup (task E2)
  const chosen = chooseSetup(plan.unwrap().setups, setupId, where)
  if (chosen.isErr()) return Err(chosen.unwrapErr().withContext(where, { planId }))
  const { setup, next } = chosen.unwrap()
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
  return Ok({ m, workZero: status.workZero, setup, next, machineKey: key.unwrap() ?? '' })
}

async function runJob(
  doc: ProjectDoc,
  planId: string,
  setupId: string | undefined,
  ctx: JobContext,
): AsyncAppResult<RunJobResult> {
  const where = 'run.job.start'
  // 1. checks
  const checked = startChecks(doc, planId, setupId, ctx.services, where)
  if (checked.isErr()) return checked
  const { m, workZero, setup, next, machineKey } = checked.unwrap()
  // From here to the stream the connection is held for this job: no jog or work-zero change
  // slips in between the soft-limit check and the start (the host re-checks the G54 anyway).
  const reserved = m.reserve(ctx.jobId)
  if (reserved.isErr()) return reserved
  const started = await checkAndStart(doc, planId, setup.id, ctx, m, workZero, machineKey)
  m.release(ctx.jobId)
  if (started.isErr()) return started
  const { running, warnings } = started.unwrap()
  const unbind = bindJobControl(m, ctx)
  if (ctx.pause.paused) void m.controlJob(ctx.jobId, 'hold')
  // 5. end
  const ended = await running.ended
  unbind()
  if (ended.isErr()) return Err(ended.unwrapErr().withContext(where, { planId }))
  return Ok({
    ...ended.unwrap(),
    warnings,
    planId,
    setupId: setup.id,
    ...(next === undefined ? {} : { next: nextSetupOf(next) }),
  })
}

/** Steps 2–4 while the connection is reserved for the job. */
async function checkAndStart(
  doc: ProjectDoc,
  planId: string,
  setupId: string,
  ctx: JobContext,
  m: MachineService,
  workZero: readonly [number, number, number],
  machineKey: string,
): AsyncAppResult<{ running: RunningJob; warnings: PlanWarning[] }> {
  const where = 'run.job.start'
  const status = { workZero }
  // 2. program, exported with the live G54
  const exported = await exportPlan(doc, planId, ctx.services, {
    setupId,
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
    "Run a plan's program (one setup) on the connected virtual machine: exports it with the live work zero, refuses soft-limit violations, streams it and waits at each tool change for run.job.continue.",
  title: () => 'Run plan',
  machine: true,
  // apply first: docs/architecture/apply.md#implicit-apply
  applyFirst: true,
  args: z.object({
    planId: PlanIdSchema,
    setupId: PlanRecordIdSchema.optional().describe(
      'Setup to run; required when the plan has several',
    ),
  }),
  result: RunJobResult,
  run: (doc, args, ctx) => runJob(doc, args.planId, args.setupId, ctx),
})

/**
 * Steps 1–3 of the run job without the stream (DF46): the pre-flight dialog shows the soft-limit
 * result before "Start run". Doc: docs/modes/run.md#run-mode-presentation-df46
 */
export const runJobCheck = defineCommand({
  kind: 'effect',
  name: 'run.job.check',
  summary:
    "Check a setup's program against the soft limits at the live work zero, as run.job.start does, without moving the machine.",
  title: () => 'Check run',
  machine: false,
  // the same program run.job.start would export: docs/architecture/apply.md#implicit-apply
  applyFirst: true,
  args: z.object({
    planId: PlanIdSchema,
    setupId: PlanRecordIdSchema.optional().describe('Required when the plan has several setups'),
  }),
  result: z.object({
    setupId: z.string(),
    findings: z.array(PlanWarningSchema).describe('softLimit findings; empty = inside the travel'),
  }),
  async run(doc, args, ctx) {
    const where = 'run.job.check'
    const checked = startChecks(doc, args.planId, args.setupId, ctx.services, where)
    if (checked.isErr()) return checked
    const { setup, workZero } = checked.unwrap()
    const exported = await exportPlan(doc, args.planId, ctx.services, {
      setupId: setup.id,
      workZero,
    })
    if (exported.isErr())
      return Err(exported.unwrapErr().withContext(where, { planId: args.planId }))
    const findings = exported.unwrap().warnings.filter((w) => w.rule === 'softLimit')
    return Ok({ setupId: setup.id, findings: [...findings] })
  },
})
