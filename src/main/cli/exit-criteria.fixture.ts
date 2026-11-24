// Test-only: the v0.1 exit-criteria script, run headless through the bundled CLI by both agent
// transports (exit-criteria.mcp.test.ts: an MCP SDK client over `dfyom mcp`;
// exit-criteria.batch.test.ts: `dfyom batch` JSON lines). Each step asserts the exit criterion
// it covers. Not app code. Docs: docs/plans/v0.1.md#exit-criteria,
// docs/conventions/testing.md#end-to-end
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import { testStock } from '../../core/design/design.fixture'
import { libraryInput, machineValues } from '../../core/library/library.fixture'
import { bull6, drill6, flat4, flat6 } from '../../core/plan/plan.fixture'
import { withoutAppVersion } from '../../core/post/plan-export'

/**
 * The exported gCode of the test project, compared byte for byte (path relative to the test
 * files). Update after an intended post or generator change with
 * `npx vitest run src/main/cli/exit-criteria -u` and review the diff.
 */
export const GOLDEN = './__golden__/exit-criteria-bracket.nc'

/** One call's answer, transport-independent (MCP `structuredContent`, a `batch` line). */
export interface CallResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly revision?: number | undefined
  readonly error?: { readonly code: string; readonly message?: string | undefined }
}

/** Calls a tool by its registry (dotted) name; the transport maps the name. */
export type Call = (name: string, args?: object) => Promise<CallResult>

export interface Progress {
  readonly done: number
  readonly total?: number
  readonly label?: string
}

interface JobInfo {
  readonly state: string
  readonly progress?: Progress
  readonly outcome?: { readonly ok: boolean; readonly value?: unknown }
}

export interface RunJobStatus {
  readonly phase: string
  readonly toolChange?: { readonly n: number; readonly name: string }
  readonly pause?: number
}

/** A job.wait timeout short enough that tool changes are continued promptly (not asserted). */
const POLL_SECONDS = 0.05

export interface FlowResult {
  /** The text `plan.export` wrote. */
  readonly gcode: string
  /** Every progress report of the run job seen by `job.wait`, in order (export phase first). */
  readonly runProgress: readonly Progress[]
}

/** Calls that must succeed, job waits, and the run progress they saw; shared by the flows. */
export interface AgentSession {
  /** Calls a tool that must succeed; returns its value and the document revision. */
  ok<T = unknown>(name: string, args?: object): Promise<{ value: T; revision: number }>
  /** Waits for a job; on a run job's wait (`onWait`), polls and lets the caller continue it. */
  waitJob(
    jobId: string,
    onWait?: (job: RunJobStatus) => Promise<void>,
  ): Promise<{ ok: boolean; value?: unknown }>
  /** Polls the run job until its progress label reads `label` (what the UI shows at a wait). */
  untilLabel(jobId: string, label: string): Promise<Progress | undefined>
  /** Every progress report of a run job seen while polling, in order. */
  readonly progress: Progress[]
}

export function agentSession(call: Call): AgentSession {
  const ok = async <T = unknown>(name: string, args: object = {}) => {
    const r = await call(name, args)
    expect(r.ok, `${name}: ${JSON.stringify(r.error)}`).toBe(true)
    return { value: r.value as T, revision: r.revision ?? 0 }
  }
  const progress: Progress[] = []
  const waitJob = async (
    jobId: string,
    onWait?: (job: RunJobStatus) => Promise<void>,
  ): Promise<{ ok: boolean; value?: unknown }> => {
    for (;;) {
      const { value } = await ok<JobInfo>('job.wait', {
        jobId,
        timeoutSeconds: onWait === undefined ? 120 : POLL_SECONDS,
      })
      if (onWait !== undefined && value.progress !== undefined) progress.push(value.progress)
      if (value.state === 'finished') return value.outcome!
      if (onWait === undefined) continue
      const { job } = (await ok<{ job?: RunJobStatus }>('run.status.get')).value
      if (job !== undefined) await onWait(job)
    }
  }
  const untilLabel = async (jobId: string, label: string) => {
    for (;;) {
      const { value } = await ok<JobInfo>('job.wait', { jobId, timeoutSeconds: POLL_SECONDS })
      if (value.progress !== undefined) progress.push(value.progress)
      if (value.progress?.label === label || value.state === 'finished') return value.progress
    }
  }
  return { ok, waitJob, untilLabel, progress }
}

/**
 * Runs the exit-criteria flow: library → project with a rectangular stock → facing, pocket
 * (inside corner radius, floor fillet), drilling, profile with tabs → one-setup plan →
 * toolpaths → GRBL export (golden) → virtual run at `max` through its tool changes and pauses,
 * with progress → save → close → reopen → compare (and re-export: same bytes).
 */
export async function exitCriteriaFlow(call: Call, dir: string): Promise<FlowResult> {
  const { ok, waitJob, untilLabel, progress } = agentSession(call)

  // ── Library (app scope, no project needed) ────────────────────────────────────────────────
  const stock = (await ok<{ id: string }>('library.stock.add', { values: testStock() })).value.id
  for (const t of [flat6(), flat4(), bull6(), drill6()])
    await ok('library.tool.add', { values: libraryInput(t) })
  const m = libraryInput(machineValues())
  const machine = (await ok<{ id: string }>('library.machine.add', { values: m })).value.id

  // ── Criterion: create a project with a rectangular stock ──────────────────────────────────
  const created = await ok<{ key: string; revision: number }>('project.create', {
    name: 'Bracket',
    unitSystem: 'mm',
  })
  const { partId } = (
    await ok<{ partId: string }>('design.part.add', {
      name: 'Bracket',
      stockLibraryItemId: stock,
      expectedRevision: created.value.revision,
    })
  ).value

  // ── Criterion: facing, pocket (corner radius, floor fillet), drilling, profile with tabs ──
  await ok('design.facing.add', { partId, depth: '0.5' })
  await ok('design.pocket.add', {
    partId,
    shape: {
      kind: 'rectangle',
      center: ['50', '30'],
      length: '40',
      width: '25',
      cornerRadius: '4',
    },
    depth: '8',
    floorRadius: '2',
  })
  for (const [x, y, extra] of [
    ['15', '15', {}],
    ['85', '15', { bottom: 'flat', depth: '12' }],
    ['15', '45', { bottom: 'drillPoint', depth: '12' }],
    ['85', '45', { bottom: 'drillPoint', depth: '12', pointAngle: '118' }],
  ] as const)
    await ok('design.drilling.add', { partId, center: [x, y], diameter: '6', ...extra })
  await ok('design.profile.add', {
    partId,
    shape: {
      kind: 'rectangle',
      center: ['50', '30'],
      length: '84',
      width: '44',
      cornerRadius: '5',
    },
    slotWidth: '6',
    tabs: { count: '4', width: '8', thickness: '3' },
  })
  const evaluated = await ok<{ jobId: string }>('design.part.evaluate', { partId })
  expect(await waitJob(evaluated.value.jobId)).toMatchObject({
    ok: true,
    value: { evaluation: 'done' },
  })
  const designed = (await ok<PartGet>('design.part.get', { partId })).value
  expect(designed.stock.values).toMatchObject({
    shape: 'block',
    // quantities entered as plain numbers come back as numbers (llm-api.md#result-size)
    length: 100,
    width: 60,
    thickness: 20,
  })
  const designOps = designed.part.operations
  expect(designOps.map((o) => o['kind'])).toEqual([
    'facing',
    'pocket',
    'drilling',
    'drilling',
    'drilling',
    'drilling',
    'profile',
  ])
  expect(designOps[1]).toMatchObject({
    shape: { kind: 'rectangle', cornerRadius: 4 },
    floorRadius: 2,
  })
  expect(designOps[6]).toMatchObject({ tabs: { count: 4 } })

  // ── Criterion: plan one setup ─────────────────────────────────────────────────────────────
  const { planId } = (
    await ok<{ planId: string }>('plan.create', { partId, machineLibraryItemId: machine })
  ).value
  // plan.get's summary (llm-api.md#result-size): tools by name
  const planned = (await ok<PlanGet>('plan.get', { planId })).value.plan
  expect(planned.setups).toHaveLength(1)
  const planOps = planned.setups[0]!.operations
  // every design operation is machined, once
  expect(planOps.flatMap((o) => o.designOperationIds).sort()).toEqual(
    designOps.map((o) => o['id'] as string).sort(),
  )
  // the drill has no feeds-and-speeds preset (known issue): give its operations cutting values
  const drillOps = planOps.filter((o) => o.tool === 'Drill 6')
  expect(drillOps.length).toBeGreaterThan(0)
  for (const op of drillOps)
    await ok('plan.operation.update', {
      planId,
      planOperationId: op.id,
      overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
    })

  // Toolpaths (a job; job.wait reports its outcome)
  const gen = await ok<{ jobId: string }>('plan.toolpath.generate', { planId })
  const generated = (await waitJob(gen.value.jobId)) as {
    ok: boolean
    value: { operations: { status: string }[] }
  }
  expect(generated.ok).toBe(true)
  expect(generated.value.operations).toHaveLength(planOps.length)
  expect(generated.value.operations.every((o) => o.status === 'generated')).toBe(true)

  // ── Criterion: export GRBL gCode (golden file) ────────────────────────────────────────────
  // The virtual machine (an agent may open only the virtual one); `prepare` homes and sets the
  // work zero, so the export runs its soft-limit check at that G54.
  await ok('run.connection.open', { target: 'virtual', planId, timeScale: 'max', prepare: true })
  const ready = (await ok<RunStatus>('run.status.get')).value
  expect(ready).toMatchObject({ state: 'Idle', homed: true })
  expect(ready.connection).toMatchObject({ state: 'open', target: 'virtual', timeScale: 'max' })
  const target = join(dir, 'bracket.nc')
  const exported = (await ok<ExportResult>('plan.export', { planId, target })).value
  expect(exported).toMatchObject({ softLimitChecked: true, warnings: [], regenerated: [] })
  const gcode = readFileSync(target, 'utf8')
  await expect(withoutAppVersion(gcode)).toMatchFileSnapshot(GOLDEN)
  // the app version in the header (TG #242); goldens keep `DFYOM` alone
  expect(gcode).toMatch(/^\(Generator: DFYOM \d+\.\d+\.\d+[^)]*\)$/m)
  expect(gcode.split('\n').filter((l) => l !== '')).toHaveLength(exported.lines)
  expect(gcode).toMatch(/^G90 G94 G17 G21$/m)
  expect(gcode.trimEnd().endsWith('M30')).toBe(true)

  // ── Criterion: run it on the virtual machine with progress shown ──────────────────────────
  const run = await ok<{ jobId: string }>('run.job.start', { planId })
  const jobId = run.value.jobId
  const waits: string[] = []
  const ended = (await waitJob(jobId, async (job) => {
    if (job.phase === 'toolChange') {
      // the progress label names the tool change while the job waits (what the UI shows)
      const tc = job.toolChange!
      await untilLabel(jobId, `Tool change ${tc.n}: ${tc.name}`)
      waits.push(`toolChange ${tc.n}`)
      await ok('run.job.continue', { jobId, toolChange: tc.n })
    } else if (job.phase === 'programPause') {
      waits.push('programPause')
      await ok('run.job.continue', { jobId, pause: job.pause })
    }
  })) as { ok: boolean; value: RunSummary }
  expect(ended.ok).toBe(true)
  expect(ended.value).toMatchObject({
    lines: exported.lines,
    toolChanges: exported.stats.toolChanges,
    warnings: [],
  })
  // every tool change of the program (marker followed by M0) and every other M0 waited once
  const markers = [...gcode.matchAll(/^\(DFYOM TOOL CHANGE (\d+): [^)]*\)\nM0( ;[^\n]*)?$/gm)]
  expect(waits.filter((w) => w.startsWith('toolChange'))).toEqual(
    markers.map((mk) => `toolChange ${mk[1]}`),
  )
  expect(waits.filter((w) => w === 'programPause')).toHaveLength(ended.value.pauses)
  expect(gcode.match(/^M0( ;.*)?$/gm)).toHaveLength(markers.length + ended.value.pauses)
  // progress: first the job's export (indeterminate: no total, seen only when a poll lands in
  // it, i.e. under load), then lines acknowledged out of the program's lines, never going back,
  // ending complete (docs/modes/run-v0.1.md#progress)
  const streamStart = progress.findIndex((p) => p.total !== undefined)
  expect(streamStart).toBeGreaterThanOrEqual(0)
  for (const p of progress.slice(0, streamStart))
    expect(p).toEqual({ done: 0, label: expect.stringMatching(/^Export:/) as unknown })
  const streamed = progress.slice(streamStart)
  expect(streamed.every((p) => p.total === exported.lines)).toBe(true)
  const done = streamed.map((p) => p.done)
  expect(done).toEqual([...done].sort((a, b) => a - b))
  expect(streamed.at(-1)).toMatchObject({ done: exported.lines, total: exported.lines })
  // the machine ends idle where the program ends, without an alarm
  const after = (await ok<RunStatus>('run.status.get')).value
  expect(after).toMatchObject({ state: 'Idle', homed: true })
  expect(after.alarm).toBeUndefined()
  expect(after.job).toBeUndefined()
  const end = programEnd(gcode)
  after.wpos.forEach((v, i) => expect(v).toBeCloseTo(end[i]!, 3))
  await ok('run.connection.close')

  // ── Criterion: save, close and reopen the project ─────────────────────────────────────────
  const file = join(dir, 'bracket.dfyom')
  await ok('project.save', { target: file })
  const listed = (await ok<ProjectList>('project.list')).value.projects
  expect(listed).toEqual([expect.objectContaining({ key: created.value.key, dirty: false })])
  const partBefore = (await ok('design.part.get', { partId })).value
  const planBefore = (await ok('plan.get', { planId, detail: 'full' })).value
  await ok('project.close', { key: created.value.key })
  expect((await ok<ProjectList>('project.list')).value.projects).toEqual([])
  // the closed project is gone from the session (the flow's only failing call)
  expect(await call('design.part.list', {})).toMatchObject({
    ok: false,
    error: { code: 'input.malformed' },
  })
  const reopened = await ok<{ key: string; alreadyOpen: boolean }>('project.open', { file })
  expect(reopened.value.alreadyOpen).toBe(false)
  expect((await ok('design.part.get', { partId })).value).toEqual(partBefore)
  expect((await ok('plan.get', { planId, detail: 'full' })).value).toEqual(planBefore)
  // the reopened project exports the same program
  const again = join(dir, 'bracket-reopened.nc')
  await ok('plan.export', { planId, target: again })
  expect(readFileSync(again, 'utf8')).toBe(gcode)
  return { gcode, runProgress: progress }
}

/** The work position the program's last move ends at (absolute G90 XYZ words, modal). */
export function programEnd(text: string): [number, number, number] {
  const pos: [number, number, number] = [Number.NaN, Number.NaN, Number.NaN]
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\([^)]*\)/g, '')
    for (const w of line.matchAll(/([XYZ])(-?\d+(?:\.\d+)?)/g))
      pos['XYZ'.indexOf(w[1]!)] = Number(w[2])
  }
  return pos
}

type Op = Record<string, unknown>
interface PartGet {
  part: { operations: Op[] }
  stock: { values: Record<string, unknown> }
}
interface PlanGet {
  plan: {
    setups: { operations: { id: string; tool: string | null; designOperationIds: string[] }[] }[]
  }
}
interface ExportResult {
  lines: number
  stats: { toolChanges: number }
  warnings: unknown[]
  softLimitChecked: boolean
}
interface RunStatus {
  state: string
  homed: boolean
  wpos: number[]
  alarm?: unknown
  job?: RunJobStatus
  connection: { state: string; target?: string; timeScale?: unknown }
}
interface RunSummary {
  lines: number
  toolChanges: number
  pauses: number
  warnings: unknown[]
}
interface ProjectList {
  projects: { key: string; dirty: boolean }[]
}
