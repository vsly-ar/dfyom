/**
 * v0.5 RV9: the calibration cut commands (Q222): `run.calibration.check` builds the program for
 * the open plan's setup (the tool's resolved feeds, the setup's WCS, a free spot found when none is
 * given) with the placement check (stock top, operations, earlier calibration cuts), the
 * workholding guard and, while connected and homed, the soft-limit and work-area findings at the
 * live G54; `run.calibration.start` streams it after every run check `run.job.start` makes (the
 * plan runnable on this connection, a real machine's `$$`, Idle and homed, the alignment gate, the
 * connection reserved) and refuses on any problem or finding. UI commands, not agent tools (Q229).
 * Doc: docs/modes/run-calibration.md
 */
import { z } from 'zod'
import { Err, fail, Ok, type AsyncAppResult } from '../../shared/result'
import type { JobContext, Services } from '../commands/context'
import { defineCommand } from '../commands/define'
import { PlanWarningSchema, type PlanWarning } from '../plan/checks'
import { planOperationInputs, type PlanOperationInput } from '../plan/inputs'
import { planOpLabel } from '../plan/labels'
import { loadPlan, type LoadedPlan } from '../plan/plan'
import { PlanIdSchema, PlanRecordIdSchema, type SetupDTO } from '../plan/plan.dto'
import { chooseSetup, setupStockSize } from '../plan/setups'
import { checkOperations, moveFindings } from '../plan/workholding/findings'
import type { ProjectDoc } from '../project/document'
import type { GrblExport } from '../post/export'
import { programGenerator } from '../post/plan-export'
import { cacheOf, ensureToolpath } from '../toolpath/generate'
import { toolpathTool } from '../toolpath/inputs'
import type { CuttingParams } from '../toolpath/model'
import { alignmentGate } from './alignment'
import {
  calibrationExport,
  calibrationToolpaths,
  CALIBRATION_TESTS,
  findFreeSpot,
  footprintSize,
  placementProblems,
  toolpathReach,
  type CalibrationProgram,
  type CalibrationSpec,
  type KeepOutRect,
  type Rect,
} from './calibration'
import { areaFindings, bindJobAbort, programSections, RunPause, startChecks } from './job'
import type { RunningJob } from './service'
import { RunSummarySchema } from './host/protocol'

const RectSchema = z.object({
  x: z.tuple([z.number(), z.number()]).readonly(),
  y: z.tuple([z.number(), z.number()]).readonly(),
})

const CalibrationArgs = z.object({
  planId: PlanIdSchema,
  setupId: PlanRecordIdSchema.optional(),
  /** The tool copy (snapshot id); absent = the setup's first flat end mill. */
  toolId: z.string().min(1).max(200).optional(),
  test: z.enum(CALIBRATION_TESTS),
  /** The footprint's centre (WCS, mm); absent = the free spot nearest the work zero. */
  at: z.tuple([z.number(), z.number()]).readonly().optional(),
  size: z.number().positive().max(1000).optional(),
  depth: z.number().positive().max(100).optional(),
  vary: z.enum(['feed', 'stepdown']).optional(),
  spread: z.number().positive().max(100).optional(),
  steps: z.number().int().positive().max(20).optional(),
  /** Earlier calibration cuts on this stock (WCS footprints) the new one keeps out of. */
  avoid: z.array(RectSchema).max(100).optional(),
})
type CalibrationArgs = z.output<typeof CalibrationArgs>

const ProblemSchema = z.object({
  rule: z.string(),
  message: z.string(),
  ref: z.string().optional(),
})

const ProgramInfoSchema = z.object({
  /** The setup the program is for (the chosen one, else the first). */
  setupId: z.string(),
  at: z.tuple([z.number(), z.number()]),
  toolId: z.string(),
  tools: z.array(z.object({ id: z.string(), name: z.string(), diameter: z.number() })),
  footprint: RectSchema,
  stockTop: RectSchema,
  depth: z.number(),
  features: z.array(z.record(z.string(), z.unknown())).optional(),
  steps: z
    .array(
      z.object({
        n: z.number().int(),
        factor: z.number(),
        feed: z.number(),
        stepdown: z.number(),
      }),
    )
    .optional(),
  vary: z.enum(['feed', 'stepdown']).optional(),
  /** The tool's resolved feeds the program uses (mm/min, mm, rpm). */
  cutting: z.object({
    spindleSpeed: z.number(),
    feedRate: z.number(),
    plungeRate: z.number(),
    stepdown: z.number(),
  }),
  lines: z.array(z.string()),
  sections: z.array(z.object({ fromLine: z.number().int(), label: z.string() })),
  seconds: z.number(),
})
type ProgramInfo = z.output<typeof ProgramInfoSchema>

interface Built {
  readonly info: ProgramInfo
  readonly export: GrblExport
  /** Placement and workholding problems: the program may not run until the spot moves. */
  readonly problems: readonly { rule: string; message: string; ref?: string }[]
}

/** A tool of the setup the test may use: a flat end mill with every milling feed resolved. */
interface Candidate {
  readonly id: string
  readonly name: string
  readonly diameter: number
  readonly input: PlanOperationInput
  readonly cutting: CuttingParams
}

const MILLING = ['spindleSpeed', 'feedRate', 'plungeRate', 'stepdown', 'stepover'] as const

function candidates(inputs: readonly PlanOperationInput[]): Candidate[] {
  const out = new Map<string, Candidate>()
  for (const input of inputs) {
    if (input.tool.type !== 'flatEndMill' || out.has(input.toolSnapshotId)) continue
    const fields = MILLING.map((f) => input.feeds.fields[f])
    if (fields.some((f) => f.isNone())) continue
    const [spindleSpeed, feedRate, plungeRate, stepdown, stepover] = fields.map(
      (f) => f.unwrap().value,
    ) as [number, number, number, number, number]
    out.set(input.toolSnapshotId, {
      id: input.toolSnapshotId,
      name: input.tool.name,
      diameter: input.tool.diameter.canonical,
      input,
      cutting: { spindleSpeed, feedRate, plungeRate, stepdown, stepover },
    })
  }
  return [...out.values()]
}

/** The setup's stock top in its WCS: the setup frame's rectangle less the work zero. */
function stockTopOf(plan: LoadedPlan, setup: SetupDTO, input: PlanOperationInput): Rect {
  const size = setupStockSize(plan.stock, setup)
  const [zx, zy] = input.setup.zero ?? [0, 0]
  return { x: [-zx, size.x[1] - zx], y: [-zy, size.y[1] - zy] }
}

const neverAborted = new AbortController().signal

async function build(
  doc: ProjectDoc,
  args: CalibrationArgs,
  services: Services,
  where: string,
  workZero: readonly [number, number, number] | undefined,
  signal: AbortSignal = neverAborted,
): AsyncAppResult<Built> {
  const loaded = loadPlan(doc, args.planId, where)
  if (loaded.isErr()) return loaded
  const plan = loaded.unwrap()
  if (plan.machine.isNone())
    return fail('post.noMachine', 'gCode export needs a machine', {
      where,
      data: { planId: args.planId },
    })
  const chosen = chooseSetup(plan.setups, args.setupId, where)
  if (chosen.isErr()) return Err(chosen.unwrapErr().withContext(where, { planId: args.planId }))
  const setup = chosen.unwrap().setup
  const inputs = planOperationInputs(
    doc,
    args.planId,
    setup.operations.map((o) => o.id),
    services.region2d,
  )
  if (inputs.isErr()) return inputs
  const all = inputs.unwrap()
  const tools = candidates(all)
  const first = tools[0]
  if (first === undefined)
    return fail('plan.check', `${setup.name} has no flat end mill with its feeds resolved`, {
      where,
      data: { planId: args.planId, setupId: setup.id },
      issues: [{ path: ['toolId'], rule: 'noFlatEndMill', message: 'no flat end mill to test' }],
    })
  const tool = args.toolId === undefined ? first : tools.find((t) => t.id === args.toolId)
  if (tool === undefined)
    return fail('input.malformed', `tool ${args.toolId} is no flat end mill of ${setup.name}`, {
      where,
      issues: [{ path: ['toolId'], rule: 'unknownTool', message: "not one of the setup's tools" }],
    })
  const machine = plan.machine.unwrap()
  const input = tool.input
  const tooling = {
    tool: toolpathTool(input.tool, tool.id),
    cutting: tool.cutting,
    heights: {
      clearanceHeight: input.setup.clearanceHeight,
      retractHeight: input.setup.retractHeight,
    },
    maxFeedRate: [
      machine.maxFeedRate.x.canonical,
      machine.maxFeedRate.y.canonical,
      machine.maxFeedRate.z.canonical,
    ] as const,
  }
  // what the cut keeps out of: every operation of the setup (already-cut ones too: their region
  // is gone) but a facing (it skims the whole top, the test sits below it either way) and the
  // earlier calibration cuts
  const cache = cacheOf(services, where)
  if (cache.isErr()) return cache
  const keepOut: KeepOutRect[] = []
  for (const op of all) {
    if (op.kind === 'facing') continue
    const tp = await ensureToolpath(
      cache.unwrap(),
      services.workers,
      op,
      { signal, progress: () => {} },
      services.region2d,
    )
    if (tp.isErr())
      return Err(tp.unwrapErr().withContext(where, { planOperationId: op.planOperationId }))
    const rect = toolpathReach(tp.unwrap().toolpath, op.tool.diameter.canonical / 2)
    const dto = setup.operations.find((o) => o.id === op.planOperationId)
    if (rect !== undefined)
      keepOut.push({
        rect,
        kind: 'operation',
        ref: op.planOperationId,
        label: dto === undefined ? 'an operation' : planOpLabel(plan.dto.design.part, dto),
      })
  }
  ;(args.avoid ?? []).forEach((rect, i) =>
    keepOut.push({ rect, kind: 'earlierCut', ref: String(i), label: 'an earlier calibration cut' }),
  )
  const stockTop = stockTopOf(plan, setup, input)
  const spec: Omit<CalibrationSpec, 'at'> = {
    test: args.test,
    ...(args.size === undefined ? {} : { size: args.size }),
    ...(args.depth === undefined ? {} : { depth: args.depth }),
    ...(args.vary === undefined ? {} : { vary: args.vary }),
    ...(args.spread === undefined ? {} : { spread: args.spread }),
    ...(args.steps === undefined ? {} : { steps: args.steps }),
  }
  const at = args.at ?? findFreeSpot(footprintSize(spec, tool.diameter), stockTop, keepOut)
  if (at === undefined)
    return fail('plan.check', 'no free spot on the stock top fits the test', {
      where,
      data: { planId: args.planId, setupId: setup.id },
      issues: [
        {
          path: ['at'],
          rule: 'noFreeSpot',
          message: 'make the test smaller or clear room on the stock',
        },
      ],
    })
  const generated = calibrationToolpaths({ ...spec, at }, tooling, where)
  if (generated.isErr()) return generated
  const program = generated.unwrap()
  const problems: { rule: string; message: string; ref?: string }[] = placementProblems(
    program.footprint,
    stockTop,
    keepOut,
  ).map((p) => ({ ...p }))
  // the workholding guard on the program's moves (DF133, the export's WH-E)
  const zero = input.setup.zero ?? [0, 0]
  const guard = moveFindings(
    plan,
    setup,
    checkOperations(
      program.toolpaths.map((t) => ({
        input: { ...input, planOperationId: 'calibration' },
        toolpath: t.toolpath,
      })),
      zero,
    ),
    zero,
  ).filter((f) => f.severity === 'error')
  for (const f of guard)
    problems.push({
      rule: 'workholding',
      message: f.message.replace(/^An operation: /, 'The calibration cut: '),
    })
  const exported = calibrationExport(program, {
    planName: plan.dto.name,
    machine,
    tool: { name: input.tool.name, diameter: tool.diameter, type: 'flatEndMill' },
    clearanceHeight: input.setup.clearanceHeight,
    stockThickness: setupStockSize(plan.stock, setup).z[1],
    ...(workZero === undefined ? {} : { workZero }),
    generator: programGenerator(services.appVersion),
  })
  if (exported.isErr()) return Err(exported.unwrapErr().withContext(where))
  const e = exported.unwrap()
  return Ok({
    info: infoOf(program, e, at, tool.id, tools, stockTop, tool.cutting, setup.id),
    export: e,
    problems,
  })
}

function infoOf(
  p: CalibrationProgram,
  e: GrblExport,
  at: readonly [number, number],
  toolId: string,
  tools: readonly Candidate[],
  stockTop: Rect,
  cutting: CuttingParams,
  setupId: string,
): ProgramInfo {
  return {
    setupId,
    at: [at[0], at[1]],
    toolId,
    tools: tools.map((t) => ({ id: t.id, name: t.name, diameter: t.diameter })),
    footprint: p.footprint,
    stockTop,
    depth: p.depth,
    ...(p.features === undefined
      ? {}
      : { features: p.features.map((f) => ({ ...f }) as Record<string, unknown>) }),
    ...(p.steps === undefined
      ? {}
      : {
          steps: p.steps.map((s) => ({
            n: s.n,
            factor: s.factor,
            feed: s.feed,
            stepdown: s.stepdown,
          })),
        }),
    ...(p.vary === undefined ? {} : { vary: p.vary }),
    cutting: {
      spindleSpeed: cutting.spindleSpeed,
      feedRate: cutting.feedRate,
      plungeRate: cutting.plungeRate,
      stepdown: cutting.stepdown,
    },
    lines: [...e.lines],
    sections: programSections(e).map((x) => ({ ...x })),
    seconds: e.stats.estimatedSeconds,
  }
}

/**
 * The connection's G54 when a check can use it: connected, homed and Idle without a job. The
 * soft-limit and work-area findings need it; without it the check says so (`travelChecked`).
 */
function liveWorkZero(services: Services): readonly [number, number, number] | undefined {
  const m = services.machine
  if (m?.target === undefined) return undefined
  const s = m.status()
  return s.connection.state === 'open' && s.homed ? s.workZero : undefined
}

function softFindings(
  services: Services,
  e: GrblExport,
  workZero: readonly [number, number, number],
): PlanWarning[] {
  const m = services.machine
  return [
    ...e.warnings.filter((w) => w.rule === 'softLimit'),
    ...(m === undefined ? [] : areaFindings(m, e.lines, workZero)),
  ]
}

export const runCalibrationCheck = defineCommand({
  kind: 'effect',
  name: 'run.calibration.check',
  summary:
    "Build a calibration cut (dimension test or feed ladder) for a plan's setup at a spot on the stock top, with its placement, workholding and soft-limit findings; moves nothing.",
  title: () => 'Check calibration cut',
  machine: false,
  agentTool: false,
  // the program reads the plan's tools and toolpaths as they are: docs/architecture/apply.md
  applyFirst: true,
  args: CalibrationArgs,
  result: ProgramInfoSchema.extend({
    problems: z.array(ProblemSchema),
    findings: z.array(PlanWarningSchema),
    /** Whether the soft limits and the work area were checked (connected and homed). */
    travelChecked: z.boolean(),
  }),
  async run(doc, args, ctx) {
    const where = 'run.calibration.check'
    const workZero = liveWorkZero(ctx.services)
    const built = await build(doc, args, ctx.services, where, workZero)
    if (built.isErr()) return built
    const { info, export: e, problems } = built.unwrap()
    return Ok({
      ...info,
      problems: [...problems],
      findings: workZero === undefined ? [] : softFindings(ctx.services, e, workZero),
      travelChecked: workZero !== undefined,
    })
  },
})

export const runCalibrationStart = defineCommand({
  kind: 'job',
  name: 'run.calibration.start',
  summary:
    'Run a calibration cut on the connected machine after the run checks; waits at its tool change for run.job.continue.',
  title: () => 'Calibration cut',
  machine: true,
  agentTool: false,
  // job.pause is a feed hold, as a plan run's (DF82)
  pause: { kind: 'handled' },
  applyFirst: true,
  args: CalibrationArgs.extend({ at: z.tuple([z.number(), z.number()]).readonly() }),
  result: RunSummarySchema.extend({
    at: z.tuple([z.number(), z.number()]),
    footprint: RectSchema,
  }),
  run: async (doc, args, ctx) => {
    const pause = new RunPause(() => ctx.services.machine, ctx)
    const unregister = pause.register()
    try {
      return await startCalibration(doc, args, ctx, pause)
    } finally {
      pause.over()
      unregister()
    }
  },
})

async function startCalibration(
  doc: ProjectDoc,
  args: CalibrationArgs & { at: readonly [number, number] },
  ctx: JobContext,
  pause: RunPause,
): AsyncAppResult<z.output<typeof RunSummarySchema> & { at: [number, number]; footprint: Rect }> {
  const where = 'run.calibration.start'
  // every check run.job.start makes before it exports (run.md § Safety 4)
  const checked = startChecks(doc, args.planId, args.setupId, ctx.services, where)
  if (checked.isErr()) return checked
  const { m, workZero, setup, machineKey } = checked.unwrap()
  const aligned = alignmentGate(m.alignmentStep(), args.planId, setup, m.status(), where)
  if (aligned.isErr()) return aligned
  const reserved = m.reserve(ctx.jobId)
  if (reserved.isErr()) return reserved
  const started = await buildAndStart(
    doc,
    { ...args, setupId: setup.id },
    ctx,
    workZero,
    machineKey,
    pause,
  )
  m.release(ctx.jobId)
  if (started.isErr()) return started
  const { running, info } = started.unwrap()
  const unbind = bindJobAbort(m, ctx)
  const ended = await running.ended
  pause.over()
  unbind()
  if (ended.isErr()) return Err(ended.unwrapErr().withContext(where, { planId: args.planId }))
  return Ok({ ...ended.unwrap(), at: info.at, footprint: info.footprint })
}

async function buildAndStart(
  doc: ProjectDoc,
  args: CalibrationArgs,
  ctx: JobContext,
  workZero: readonly [number, number, number],
  machineKey: string,
  pause: RunPause,
): AsyncAppResult<{
  running: RunningJob
  info: ProgramInfo
}> {
  const where = 'run.calibration.start'
  const m = ctx.services.machine!
  const built = await build(doc, args, ctx.services, where, workZero, ctx.signal)
  if (built.isErr()) return built
  const { info, export: e, problems } = built.unwrap()
  const first = problems[0]
  if (first !== undefined)
    return fail('plan.check', first.message, {
      where,
      data: { planId: args.planId },
      issues: problems.map((p) => ({ path: ['at'], rule: p.rule, message: p.message })),
    })
  const soft = softFindings(ctx.services, e, workZero)
  if (soft.length > 0)
    return fail('run.softLimit', `${soft.length} soft-limit finding(s) at the current work zero`, {
      where,
      data: { planId: args.planId, workZero: [...workZero], findings: soft },
    })
  await pause.beforeStart()
  if (ctx.signal.aborted) {
    pause.started(false)
    return fail('op.aborted', 'the calibration cut was aborted before it started', { where })
  }
  ctx.progress({ done: 0, total: e.lines.length, label: 'started' })
  // no plan or file about the job: a calibration cut marks no operation cut, and an interrupted
  // one is cut again on a fresh spot rather than resumed (docs/modes/run-calibration.md)
  const started = await m.startJob(
    ctx.jobId,
    { lines: e.lines, sections: programSections(e) },
    {
      progress: (p) => ctx.progress({ done: p.done, total: p.total, label: p.label }),
      phase: (p) => pause.phase(p),
    },
    { workZero, machineKey },
  )
  pause.started(started.isOk())
  if (started.isErr()) return Err(started.unwrapErr().withContext(where, { planId: args.planId }))
  return Ok({ running: started.unwrap(), info })
}

export const CALIBRATION_COMMANDS = [runCalibrationCheck, runCalibrationStart] as const
