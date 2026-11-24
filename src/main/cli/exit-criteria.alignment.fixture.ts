// Test-only: the alignment phase 1 exit criterion (hardening DF78), run headless through the
// bundled CLI (exit-criteria.mcp.test.ts): a two-sided test part, two registration holes into the
// spoilboard and two witness marks across the top's edges cut in the Top setup, the Bottom setup
// aligning on all four; the virtual machine runs both setups, and the alignment step moves the
// pointer to each point's expected machine position at the clearance height, zero first,
// previous/next wrapping; a re-zero clears the ticks. Not app code.
// Docs: docs/modes/alignment.md#implementation-slice-2,
// docs/plans/proposal-multi-setup-alignment.md#exit-criteria-per-phase
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import { deg, len, libraryInput, machineValues, num } from '../../core/library/library.fixture'
import { drill6, flat6 } from '../../core/plan/plan.fixture'
import { testStock } from '../../core/design/design.fixture'
import { agentSession, type Call, type RunJobStatus } from './exit-criteria.fixture'

interface PlanSetupView {
  id: string
  name: string
  direction: string
  operations: { id: string; tool: string | null; aid?: { kind: string; name: string } }[]
  zero?: [number, number] | null
  alignment?: { id: string; name: string; wcs: [number, number] | null }[]
}
interface PlanGet {
  plan: { setups: PlanSetupView[] }
}
interface AidResult {
  planOperationIds: string[]
  alignmentPointIds: string[]
  findings: { rule: string; message: string }[]
}
interface Step {
  setupId: string
  current?: string
  confirmed: boolean
  entries: { id: string; name: string; target: [number, number]; ticked: boolean }[]
}
interface RunStatus {
  state: string
  wpos: [number, number, number]
  mpos: [number, number, number]
  workZero: [number, number, number]
  alignment?: Step
}
interface RunSummary {
  setupId: string
  next?: { setupId: string }
}

const vbit = {
  name: 'V-bit 90',
  type: 'chamferMill',
  diameter: len('6'),
  angle: deg('90'),
  fluteLength: len('8'),
  overallLength: len('50'),
  fluteCount: num('2'),
  toolMaterial: 'carbide',
  presets: [],
}

const STOCK = { length: 100, width: 60, thickness: 20 }

export async function exitCriteriaAlignmentFlow(call: Call, dir: string): Promise<void> {
  const { ok, waitJob } = agentSession(call)
  const stock = (await ok<{ id: string }>('library.stock.add', { values: testStock() })).value.id
  for (const t of [flat6(), drill6(), vbit])
    await ok('library.tool.add', { values: libraryInput(t) })
  const machine = (
    await ok<{ id: string }>('library.machine.add', { values: libraryInput(machineValues()) })
  ).value.id
  const created = await ok<{ revision: number }>('project.create', {
    name: 'Two sides',
    unitSystem: 'mm',
  })
  const { partId } = (
    await ok<{ partId: string }>('design.part.add', {
      name: 'Two sides',
      stockLibraryItemId: stock,
      expectedRevision: created.value.revision,
    })
  ).value

  // ── a two-sided part: a top facing and pocket, a bottom facing, a through profile ─────────
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
    depth: '6',
  })
  await ok('design.facing.add', { partId, on: 'stock.bottom', depth: '0.5' })
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
  const { planId } = (
    await ok<{ planId: string }>('plan.create', { partId, machineLibraryItemId: machine })
  ).value
  let plan = (await ok<PlanGet>('plan.get', { planId })).value.plan
  // the Top first: it cuts the aids the flipped Bottom aligns on
  const topIndex = plan.setups.findIndex((s) => s.direction === '+z')
  const top = plan.setups[topIndex]!
  if (topIndex !== 0) await ok('plan.setup.move', { planId, setupId: top.id, toIndex: 0 })
  plan = (await ok<PlanGet>('plan.get', { planId })).value.plan
  const bottom = plan.setups[1]!
  expect(bottom.direction).toBe('-z')
  await ok('plan.workholding.set', {
    planId,
    setupId: top.id,
    items: [{ kind: 'base', type: 'spoilboard' }],
  })

  // ── two registration holes into the spoilboard, two witness marks across the top's edges ──
  const holes = (
    await ok<AidResult>('plan.aid.set', {
      planId,
      setupId: top.id,
      place: 'holes',
      forSetupId: bottom.id,
      aid: { diameter: '6', spoilboardDepth: '5' },
    })
  ).value
  const marks = (
    await ok<AidResult>('plan.aid.set', {
      planId,
      setupId: top.id,
      place: 'marks',
      forSetupId: bottom.id,
    })
  ).value
  expect(holes.planOperationIds).toHaveLength(2)
  expect(marks.planOperationIds).toHaveLength(2)
  // in the waste, on a base, cut before the Bottom, reachable from it (the feeds come below)
  expect([...holes.findings, ...marks.findings].filter((f) => f.rule !== 'unresolved')).toEqual([])
  plan = (await ok<PlanGet>('plan.get', { planId })).value.plan
  const topOps = plan.setups[0]!.operations
  // marks last: the V-bit stays in for the Bottom's alignment (no markLast)
  expect(topOps.slice(-2).map((o) => o.id)).toEqual(marks.planOperationIds)
  expect(topOps.find((o) => o.id === holes.planOperationIds[0])?.tool).toBe('Drill 6')
  expect(topOps.find((o) => o.id === marks.planOperationIds[0])?.tool).toBe('V-bit 90')
  const points = plan.setups[1]!.alignment!
  expect(points.map((p) => p.name)).toEqual([
    'Registration hole 1',
    'Registration hole 2',
    'Witness mark 1',
    'Witness mark 2',
  ])
  expect(points.every((p) => p.wcs !== null)).toBe(true)
  // the drill and the V-bit have no presets: cutting values
  for (const op of topOps.filter((o) => o.tool === 'Drill 6' || o.tool === 'V-bit 90'))
    await ok('plan.operation.update', {
      planId,
      planOperationId: op.id,
      overrides: { spindleSpeed: '9000', feedRate: '300', plungeRate: '150' },
    })
  const findings = (
    await ok<{ warnings: { severity: string; rule: string; message: string }[] }>(
      'plan.warning.list',
      { planId, detail: 'full' },
    )
  ).value.warnings.filter((w) => w.severity === 'error')
  expect(findings).toEqual([])

  // ── both setups on the virtual machine; the Bottom's alignment step first ─────────────────
  await ok('run.connection.open', { target: 'virtual', planId, timeScale: 'max', prepare: true })
  const status = async () => (await ok<RunStatus>('run.status.get')).value
  const settle = async () => {
    for (let i = 0; i < 400; i++) {
      const s = await status()
      if (s.state === 'Idle') return s
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error('the machine did not settle')
  }
  const runSetup = async (setupId: string, n: number): Promise<RunSummary> => {
    const target = join(dir, `two-sides-${n}.nc`)
    await ok('plan.export', { planId, setupId, target })
    const gcode = readFileSync(target, 'utf8')
    if (n === 1) {
      expect(gcode).toContain('(Registration hole 1)')
      expect(gcode).toContain('(Witness mark 2)')
    } else {
      expect(gcode).toContain('(Align 4 points after zeroing, spindle off:)')
      expect(gcode).toContain('(Align 3: Witness mark 1 at X ')
    }
    const run = await ok<{ jobId: string }>('run.job.start', { planId, setupId })
    const ended = (await waitJob(run.value.jobId, async (job: RunJobStatus) => {
      if (job.phase === 'toolChange')
        await ok('run.job.continue', { jobId: run.value.jobId, toolChange: job.toolChange!.n })
      else if (job.phase === 'programPause')
        await ok('run.job.continue', { jobId: run.value.jobId, pause: job.pause })
    })) as { ok: boolean; value: RunSummary }
    expect(ended.ok, JSON.stringify(ended)).toBe(true)
    return ended.value
  }
  const first = await runSetup(top.id, 1)
  expect(first.next?.setupId).toBe(bottom.id)

  // the setup change: the flipped stock zeroed at the same machine place (centred, as prepare)
  const zeroAt = async (dx: number) => {
    const s = await status()
    const g54 = [-400 - STOCK.length / 2 + dx, -400 - STOCK.width / 2, s.workZero[2]]
    await ok('run.workZero.set', {
      axes: ['x', 'y', 'z'],
      values: s.mpos.map((m, i) => m - g54[i]!),
    })
    return g54
  }
  let g54 = await zeroAt(0)
  // the gate: the Bottom does not start before its step is confirmed
  // (a job: it ends refused, run.state alignmentPending)
  const gated = await ok<{ jobId: string }>('run.job.start', { planId, setupId: bottom.id })
  expect(await waitJob(gated.value.jobId)).toMatchObject({
    ok: false,
    error: { code: 'run.state' },
  })

  // the cycle: zero → points → zero (next wraps), each at its expected machine position
  const expected = [[0, 0] as [number, number], ...points.map((p) => p.wcs!)]
  const visit = async (to: string, want: [number, number]) => {
    const r = (
      await ok<{ current: string; target: [number, number] }>('run.align.goto', {
        planId,
        setupId: bottom.id,
        to,
      })
    ).value
    expect(r.target[0]).toBeCloseTo(want[0], 3)
    expect(r.target[1]).toBeCloseTo(want[1], 3)
    const s = await settle()
    // machine position = G54 + WCS target; at the clearance height above the top
    expect(s.mpos[0]).toBeCloseTo(g54[0]! + want[0], 2)
    expect(s.mpos[1]).toBeCloseTo(g54[1]! + want[1], 2)
    expect(s.wpos[2]).toBeGreaterThan(0)
    return r.current
  }
  expect(await visit('zero', expected[0]!)).toBe('zero')
  await ok('run.align.tick', { entry: 'zero' })
  for (let i = 1; i < expected.length; i++) {
    const current = await visit('next', expected[i]!)
    expect(current).toBe(points[i - 1]!.id)
    await ok('run.align.tick', { entry: current })
  }
  expect(await visit('next', expected[0]!)).toBe('zero')
  // previous wraps to the last point
  expect(await visit('previous', expected.at(-1)!)).toBe(points.at(-1)!.id)
  expect((await status()).alignment?.entries.every((e) => e.ticked)).toBe(true)

  // nudging the stock: a re-zero clears every tick
  await visit('zero', expected[0]!)
  g54 = await zeroAt(0.2)
  for (let i = 0; i < 100 && (await status()).alignment?.entries.some((e) => e.ticked); i++)
    await new Promise((r) => setTimeout(r, 20))
  expect((await status()).alignment?.entries.some((e) => e.ticked)).toBe(false)
  // the cycle again at the new zero, then confirm
  expect(await visit('zero', expected[0]!)).toBe('zero')
  await ok('run.align.tick', { entry: 'zero' })
  for (let i = 1; i < expected.length; i++) {
    const current = await visit('next', expected[i]!)
    await ok('run.align.tick', { entry: current })
  }
  expect((await ok<Step>('run.align.tick', { confirm: true })).value.confirmed).toBe(true)
  const second = await runSetup(bottom.id, 2)
  expect(second.next).toBeUndefined()
  await ok('run.connection.close')
  await ok('project.save', { target: join(dir, 'two-sides.dfyom') })
}
