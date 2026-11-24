/**
 * The run job (`run.job.start { planId, setupId? }`): checks, export of the setup's program with the
 * connected G54, the soft-limit refusal, streaming on the machine host with progress, and the
 * job's pause (a feed hold confirmed at `Hold:0`, DF82) and abort mapping. One job per setup: the
 * result names the next setup, which the setup-change prompt runs after re-fixturing (task E2).
 * `from` resumes at an operation's start (hardening M5); the job tells the machine port its plan and setup for the status (M7).
 * Doc: docs/modes/run-v0.1.md#run-job, docs/modes/plan-v0.2.md#implementation-task-e2,
 * docs/modes/run-machine.md#section-resume-m5
 */
import { z } from 'zod'
import { Err, fail, Ok, type AppResult, type AsyncAppResult } from '../../shared/result'
import type { JobContext, Services } from '../commands/context'
import { defineCommand } from '../commands/define'
import { PlanWarningSchema, type PlanWarning } from '../plan/checks'
import { PlanIdSchema, PlanRecordIdSchema, type PlanDTO, type SetupDTO } from '../plan/plan.dto'
import { setupAlignment } from '../plan/alignment'
import { findPlanDTO, loadPlanDTO, snapshotById, type LoadedPlan } from '../plan/plan'
import { setupZeroCorner } from '../toolpath/wcs'
import { machineKeyOf } from './machine-key'
import { chooseSetup, setupDirection, setupRotation } from '../plan/setups'
import { checkAllowed, statusError } from '../plan/status'
import type { MachineValuesDTO } from '../library/machine.dto'
import { settingsCheck } from './settings-check'
import type { ProjectDoc } from '../project/document'
import { commentLine } from '../post/grbl/format'
import type { GrblExport } from '../post/export'
import { exportPlan } from '../post/plan-export'
import type { SenderProgram } from './grbl/sender'
import { RunSummarySchema } from './host/protocol'
import { alignmentGate } from './alignment'
import { runPlanHash } from './plan-hash'
import type { JobAbout, JobListener, MachineService, RunningJob, RunPlan } from './service'

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
    return fail('run.notConnected', 'connect to a machine first', { where })
  return Ok(m)
}

const NextSetupSchema = z.object({
  setupId: z.string(),
  name: z.string(),
  direction: z.string().describe('Part direction up to the spindle'),
  rotation: z.number().int().describe('Quarter turn about machine +Z, degrees'),
  corner: z
    .string()
    .optional()
    .describe(
      'Part corner at the work zero, e.g. "back left"; on the machine the front-left corner of the top',
    ),
  zero: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe('Work zero X, Y mm from that corner when the setup moved it (DF78)'),
  zeroPoint: z.string().optional().describe('Alignment point the work zero is on, by name'),
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
export function nextSetupOf(
  setup: SetupDTO,
  stock?: { length: number; width: number; thickness: number },
  plan?: LoadedPlan,
): z.output<typeof NextSetupSchema> {
  // N9 (DF78): the zero to set is the corner, an offset from it or a point
  const a = plan === undefined || setup.zero === undefined ? undefined : setupAlignment(plan, setup)
  const point = a?.points.find((p) => p.id === a.zeroPoint)
  return {
    ...(a === undefined || (a.zero[0] === 0 && a.zero[1] === 0)
      ? {}
      : { zero: [a.zero[0], a.zero[1]] as [number, number] }),
    ...(point === undefined ? {} : { zeroPoint: point.name }),
    setupId: setup.id,
    name: setup.name,
    direction: setupDirection(setup),
    rotation: setupRotation(setup),
    ...(stock === undefined
      ? {}
      : { corner: setupZeroCorner(setupDirection(setup), setupRotation(setup), stock) }),
  }
}

/** Plan statuses a real machine runs (run-machine.md amendment of decision 5). */
const REAL_MACHINE_STATUSES: readonly string[] = ['finalized', 'inUse']

/** The real-machine rules of `run.job.start` beyond the virtual machine's (run.md § Safety 4). */
function realMachineChecks(
  plan: Parameters<typeof snapshotById>[0],
  m: MachineService,
  planId: string,
  state: string,
  where: string,
): AppResult<void> {
  if (!REAL_MACHINE_STATUSES.includes(plan.status))
    return statusError(
      planId,
      plan.status,
      where,
      'a real machine runs only finalized or inUse plans',
    ).mapErr((e) => e.withContext(where, { target: 'serial' }))
  const snap = plan.machine === undefined ? undefined : snapshotById(plan, plan.machine)
  const settings = m.controllerSettings
  if (snap === undefined || settings === undefined)
    return fail('run.state', "the controller's settings are not known", {
      where,
      data: { state },
    })
  const check = settingsCheck(snap.values as MachineValuesDTO, settings, 'plan')
  if (check.matches) return Ok(undefined)
  const message = check.homingEnabled
    ? `the controller's settings differ from the plan's machine: ${check.differences
        .map(
          (d) =>
            `${d.setting} ${d.field} is ${d.controller} on the controller, ${d.machine} in the plan`,
        )
        .join('; ')}`
    : 'homing is off on the controller ($22=0): DFYOM runs only on a homed machine'
  return fail('run.state', message, {
    where,
    data: { state, differences: check.differences, homingEnabled: check.homingEnabled },
    issues: [{ path: ['planId'], rule: 'settingsMismatch', message }],
  })
}

/** Maps `job.abort` to the controlled stop. */
function bindJobAbort(m: MachineService, ctx: JobContext): () => void {
  const abort = () => void m.controlJob(ctx.jobId, 'stop')
  // An abort while the start was in flight (the host already streams, its reply not yet here)
  // has fired before this listener existed: stop now, or the job runs on (hardening P1).
  if (ctx.signal.aborted) abort()
  else ctx.signal.addEventListener('abort', abort, { once: true })
  return () => ctx.signal.removeEventListener('abort', abort)
}

/**
 * The run job's pause (the `handled` policy, hardening DF82): the job is paused only once nothing
 * moves. Before the stream starts, a pause parks the job at the start gate; once it streams,
 * `job.pause` is a feed hold the machine host confirms at `Hold:0` (at a tool change or `M0` wait
 * at once) and `job.resume` a cycle start. A pause while the start is in flight waits for it.
 * A hold DFYOM did not send (the machine's hold button, its safety door) is adopted: the job is
 * paused once the run is held, and runs again when the machine's cycle start resumes it.
 * Doc: docs/architecture/commands.md#pausing-a-job, docs/modes/run.md#external-holds-df82
 */
class RunPause {
  private stage: 'preparing' | 'starting' | 'streaming' | 'over' = 'preparing'
  /** `job.pause`/`job.resume` in flight: their own phase changes are not adopted. */
  private controlling = 0
  private gate: { readonly wait: Promise<void>; readonly open: () => void } | undefined
  private startSettled: Promise<void> = Promise.resolve()
  private settleStart: () => void = () => {}

  constructor(
    private readonly m: () => MachineService | undefined,
    private readonly ctx: JobContext,
  ) {}

  register(): () => void {
    return this.ctx.onPause({ hold: () => this.hold(), resume: () => this.resume() })
  }

  /**
   * Just before the stream starts: waits while paused at the gate (an abort ends the wait), then
   * marks the start in flight. Synchronous from the gate check to the mark, so a pause is either
   * held at the gate or waits for the start.
   */
  async beforeStart(): Promise<void> {
    while (this.gate !== undefined && !this.ctx.signal.aborted)
      await Promise.race([this.gate.wait, aborted(this.ctx.signal)])
    this.stage = 'starting'
    this.startSettled = new Promise((resolve) => (this.settleStart = resolve))
  }

  /** The start settled: streaming, or over when it failed. */
  started(ok: boolean): void {
    this.stage = ok ? 'streaming' : 'over'
    this.settleStart()
  }

  over(): void {
    this.stage = 'over'
    this.settleStart()
  }

  /**
   * A phase of the stream: a `held` the machine reports by itself pauses the job, `streaming`
   * after a hold (the machine's cycle start) resumes it (DF82). Ignored while `job.pause` or
   * `job.resume` is in flight: the dispatcher changes the state then, after its log event.
   */
  phase(p: Parameters<JobListener['phase']>[0]): void {
    if (this.stage === 'over' || this.stage === 'preparing' || this.controlling > 0) return
    if (p.phase === 'held' && p.heldBy === 'machine') this.ctx.adoptPause(true)
    else if (p.phase === 'streaming') this.ctx.adoptPause(false)
  }

  private async hold(): AsyncAppResult<void> {
    this.controlling++
    try {
      return await this.holdNow()
    } finally {
      this.controlling--
    }
  }

  private async holdNow(): AsyncAppResult<void> {
    if (this.stage === 'preparing') {
      if (this.gate === undefined) {
        let open = () => {}
        const wait = new Promise<void>((resolve) => (open = resolve))
        this.gate = { wait, open }
      }
      return Ok(undefined)
    }
    await this.startSettled
    const m = this.m()
    if (this.stage !== 'streaming' || m === undefined)
      return fail('run.state', 'the run is not streaming', { where: 'run.job.start' })
    return m.controlJob(this.ctx.jobId, 'hold')
  }

  private async resume(): AsyncAppResult<void> {
    this.controlling++
    try {
      return await this.resumeNow()
    } finally {
      this.controlling--
    }
  }

  private async resumeNow(): AsyncAppResult<void> {
    const gate = this.gate
    if (gate !== undefined) {
      this.gate = undefined
      gate.open()
      return Ok(undefined)
    }
    const m = this.m()
    if (this.stage !== 'streaming' || m === undefined) return Ok(undefined)
    return m.controlJob(this.ctx.jobId, 'resume')
  }
}

/** Resolves once `signal` aborts. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })
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
  plan: PlanDTO
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
    return fail('run.state', "the connection is for another machine than this plan's", {
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
  // a real machine: finalized plans only, and the controller's $$ must match the machine copy
  // (docs/modes/run.md#4-before-a-real-run-streams)
  if (m.target === 'serial') {
    const real = realMachineChecks(plan.unwrap(), m, planId, status.state, where)
    if (real.isErr()) return real
  }
  if (status.state !== 'Idle' || !status.homed)
    return fail(
      'run.state',
      `the machine must be Idle and homed (is ${status.state}${status.homed ? '' : ', not homed'})`,
      {
        where,
        data: { state: status.state, homed: status.homed },
      },
    )
  return Ok({
    m,
    workZero: status.workZero,
    plan: plan.unwrap(),
    setup,
    next,
    machineKey: key.unwrap() ?? '',
  })
}

async function runJob(
  doc: ProjectDoc,
  planId: string,
  setupId: string | undefined,
  from: string | undefined,
  ctx: JobContext,
): AsyncAppResult<RunJobResult> {
  const pause = new RunPause(() => ctx.services.machine, ctx)
  const unregister = pause.register()
  try {
    return await runJobSteps(doc, planId, setupId, from, ctx, pause)
  } finally {
    pause.over()
    unregister()
  }
}

async function runJobSteps(
  doc: ProjectDoc,
  planId: string,
  setupId: string | undefined,
  from: string | undefined,
  ctx: JobContext,
  pause: RunPause,
): AsyncAppResult<RunJobResult> {
  const where = 'run.job.start'
  // 1. checks
  const checked = startChecks(doc, planId, setupId, ctx.services, where)
  if (checked.isErr()) return checked
  const { m, workZero, plan: p, setup, next, machineKey } = checked.unwrap()
  // DF78: a setup with alignment points runs after its step was confirmed at this G54
  // (docs/modes/alignment.md#ticks-and-the-confirm-gate); not part of run.job.check
  const aligned = alignmentGate(m.alignmentStep(), planId, setup, m.status(), where)
  if (aligned.isErr()) return aligned
  // From here to the stream the connection is held for this job: no jog or work-zero change
  // slips in between the soft-limit check and the start (the host re-checks the G54 anyway).
  const reserved = m.reserve(ctx.jobId)
  if (reserved.isErr()) return reserved
  const runPlan: RunPlan = {
    planId,
    planName: p.name,
    setupId: setup.id,
    setupName: setup.name,
    setup: p.setups.findIndex((s) => s.id === setup.id) + 1,
    setups: p.setups.length,
  }
  const started = await checkAndStart(
    doc,
    { planId, setupId: setup.id, from, runPlan },
    ctx,
    m,
    workZero,
    machineKey,
    pause,
  )
  m.release(ctx.jobId)
  if (started.isErr()) return started
  const { running, warnings } = started.unwrap()
  const unbind = bindJobAbort(m, ctx)
  // 5. end
  const ended = await running.ended
  pause.over()
  unbind()
  if (ended.isErr()) return Err(ended.unwrapErr().withContext(where, { planId }))
  const loaded = loadPlanDTO(p, doc.unitSystem, where)
  const stock = loaded.isOk()
    ? {
        length: loaded.unwrap().stock.length.canonical,
        width: loaded.unwrap().stock.width.canonical,
        thickness: loaded.unwrap().stock.thickness.canonical,
      }
    : undefined
  return Ok({
    ...ended.unwrap(),
    warnings,
    planId,
    setupId: setup.id,
    ...(next === undefined
      ? {}
      : { next: nextSetupOf(next, stock, loaded.isOk() ? loaded.unwrap() : undefined) }),
  })
}

/** Steps 2–4 while the connection is reserved for the job. */
async function checkAndStart(
  doc: ProjectDoc,
  run: { planId: string; setupId: string; from: string | undefined; runPlan: RunPlan },
  ctx: JobContext,
  m: MachineService,
  workZero: readonly [number, number, number],
  machineKey: string,
  pause: RunPause,
): AsyncAppResult<{ running: RunningJob; warnings: PlanWarning[] }> {
  const where = 'run.job.start'
  const { planId, setupId, from } = run
  const status = { workZero }
  // 2. program, exported with the live G54 (a resume: from an operation's start, M5)
  const exported = await exportPlan(doc, planId, ctx.services, {
    setupId,
    workZero: status.workZero,
    ...(from === undefined ? {} : { resumeFrom: from }),
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
  // a pause before the stream parks the job here, before anything moves (DF82)
  await pause.beforeStart()
  if (ctx.signal.aborted) {
    pause.started(false)
    return fail('op.aborted', 'the run was aborted before it started', { where })
  }
  // 4. stream
  // notes (`info`, e.g. DF68's zHeadroomUnknown) are not warnings
  const counted = warnings.filter((w) => w.severity === 'warning').length
  const prefix = counted > 0 ? `${counted} machine warning(s) · ` : ''
  // before the stream starts: the host's progress ticks may arrive before startJob resolves,
  // and this tick must not overwrite them (done never goes back)
  ctx.progress({ done: 0, total: e.lines.length, label: `${prefix}started` })
  // the host refuses if the G54, the machine copy or the target changed since the check
  const plan = doc.plans[planId]
  const about: JobAbout = {
    plan: run.runPlan,
    operations: e.operationLines,
    ...(plan === undefined
      ? {}
      : {
          planHash: runPlanHash(plan, setupId),
          order: (plan.setups.find((s) => s.id === setupId)?.operations ?? []).map((o) => o.id),
        }),
  }
  const started = await m.startJob(
    ctx.jobId,
    { lines: e.lines, sections: programSections(e) },
    {
      progress: (p) => ctx.progress({ done: p.done, total: p.total, label: `${prefix}${p.label}` }),
      phase: (p) => pause.phase(p),
    },
    { workZero, machineKey },
    about,
  )
  pause.started(started.isOk())
  if (started.isErr()) return Err(started.unwrapErr().withContext(where, { planId }))
  return Ok({ running: started.unwrap(), warnings })
}

export const runJobStart = defineCommand({
  kind: 'job',
  name: 'run.job.start',
  summary:
    "Run a plan's program (one setup) on the connected machine: exports it with the live work zero, refuses soft-limit violations, streams it and waits at each tool change for run.job.continue.",
  title: () => 'Run plan',
  machine: true,
  // job.pause is a feed hold, paused once the controller reports Hold:0 (DF82)
  pause: { kind: 'handled' },
  // apply first: docs/architecture/apply.md#implicit-apply
  applyFirst: true,
  args: z.object({
    planId: PlanIdSchema,
    setupId: PlanRecordIdSchema.optional().describe(
      'Setup to run; required when the plan has several',
    ),
    from: PlanRecordIdSchema.optional().describe(
      "Resume at this operation's start (after a stop): waits at its tool first",
    ),
  }),
  result: RunJobResult,
  run: (doc, args, ctx) => runJob(doc, args.planId, args.setupId, args.from, ctx),
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
