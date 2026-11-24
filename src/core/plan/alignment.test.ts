// Spec: docs/modes/alignment.md (Setup work zero, Alignment points, Validity, Export,
// Negative work coordinates, Implementation (slice 1)).
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { DIRECTIONS } from '../geometry/face'
import { applyPlacement, type Vec2, type Vec3 } from '../geometry/model'
import { exportPlan } from '../post/plan-export'
import { createToolpathCache } from '../toolpath/cache'
import { toGeneratorInputs } from '../toolpath/inputs'
import type { Move, Toolpath } from '../toolpath/model'
import { generateRequest, GeneratorRequestSchema } from '../toolpath/request'
import { fromWcs, setupFrame, setupWcs, toWcs, type WcsRotation } from '../toolpath/wcs'
import { setupAlignment } from './alignment'
import { planOperationInputs, type PlanOperationInput } from './inputs'
import { loadPlan } from './plan'
import type { PlanDTO } from './plan.dto'
import { planSetup, type PlanSetup } from './plan.fixture'

const STOCK = { length: 100, width: 60, thickness: 20 }
const ROTATIONS: WcsRotation[] = [0, 90, 180, 270]
const close = (a: readonly number[], b: readonly number[], eps = 1e-9) =>
  a.every((c, i) => Math.abs(c - b[i]!) < eps)

const services = () => ({ workers: createInProcessWorkers(), toolpaths: createToolpathCache() })

/** The test part plus a bottom facing: setups Bottom, Top. */
async function twoSided() {
  const s = await planSetup()
  await s.run('design.facing.add', { partId: s.partId, on: 'stock.bottom', depth: '0.5' })
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  // the 6 mm drill has no data: every drilling of the top gets overrides
  const top = s.plan(planId).setups.find((x) => x.name === 'Top')!
  const drillings = new Set(
    s
      .part()
      .operations.filter((o) => o.kind === 'drilling')
      .map((o) => o.id),
  )
  for (const op of top.operations)
    if (op.designOperationIds.some((d) => drillings.has(d)))
      await s.run('plan.operation.update', {
        planId,
        planOperationId: op.id,
        overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
      })
  return { s, planId }
}

const setupNamed = (p: PlanDTO, name: string) => p.setups.find((x) => x.name === name)!
const inputsOf = (s: PlanSetup, planId: string, setup: string): PlanOperationInput[] => {
  const ids = setupNamed(s.plan(planId), setup).operations.map((o) => o.id)
  return expectOk(planOperationInputs(s.d.doc, planId, ids))
}
const toolpathOf = (input: PlanOperationInput): Toolpath =>
  expectOk(generateRequest(expectOk(toGeneratorInputs(input))))

function points(tp: Toolpath): Vec3[] {
  const out: Vec3[] = []
  const add = (m: Move) => {
    if (m.kind === 'drill') {
      out.push([m.at[0], m.at[1], m.top], [m.at[0], m.at[1], m.bottom])
      return
    }
    out.push(m.to)
    if (m.kind === 'arc') out.push([m.center[0], m.center[1], m.to[2]])
  }
  for (const p of tp.passes) for (const m of p.moves) add(m)
  return out
}

describe('setup WCS with a work zero (N2)', () => {
  it('toWcs and fromWcs stay inverse with a zero, and the zero point maps to WCS 0, 0', () => {
    for (const d of DIRECTIONS)
      for (const r of ROTATIONS) {
        const zero: Vec2 = [-20, 37.5]
        const wcs = setupWcs(d, r, STOCK, zero)!
        expect(wcs.zero).toEqual(zero)
        for (const p of [
          [0, 0],
          [12.3, 4.5],
          [-40, 80],
        ] as const) {
          const back = fromWcs(toWcs(p, wcs), wcs)
          expect(close(back, p)).toBe(true)
        }
        // the shift is a pure translation of the turned frame
        const plain = setupWcs(d, r, STOCK)
        const turned = plain === undefined ? [5, 6] : toWcs([5, 6], plain)
        expect(close(toWcs([5, 6], wcs), [turned[0]! - zero[0], turned[1]! - zero[1]])).toBe(true)
        // setupFrame: its origin is the zero on the up face, the axes unchanged
        const f = setupFrame(d, r, STOCK, zero)
        const corner = setupFrame(d, r, STOCK)
        expect(close(f.origin, applyPlacement(corner, [zero[0], zero[1], 0]))).toBe(true)
        expect([f.u, f.v, f.n]).toEqual([corner.u, corner.v, corner.n])
      }
    // absent or [0, 0]: no shift, so unrotated setups keep the face frame (goldens unchanged)
    expect(setupWcs('+z', 0, STOCK, [0, 0])).toBeUndefined()
    expect(setupWcs('+z', 90, STOCK, [0, 0])).not.toHaveProperty('zero')
  })

  it('a request with a zero passes the worker schema', () => {
    const req = {
      kind: 'facing',
      inputs: [{}],
      wcs: { rotation: 0, size: [100, 60], zero: [-20, -20] },
    }
    const parsed = GeneratorRequestSchema.safeParse(req)
    // the input itself is not valid here: only the wcs part must not be the failing path
    const paths = parsed.success ? [] : parsed.error.issues.map((i) => i.path[0])
    expect(paths).not.toContain('wcs')
  })
})

describe('toolpaths, export and findings with a moved zero (A11)', { timeout: 60_000 }, () => {
  it('toolpaths equal the corner-zero ones shifted, for the top and the bottom', async () => {
    const { s, planId } = await twoSided()
    const p = s.plan(planId)
    for (const name of ['Top', 'Bottom']) {
      const before = inputsOf(s, planId, name).map(toolpathOf)
      const setupId = setupNamed(p, name).id
      for (const zero of [
        [-20, -20],
        [STOCK.length + 10, STOCK.width / 2],
      ] as const) {
        await s.run('plan.setup.update', {
          planId,
          setupId,
          zero: { at: [String(zero[0]), String(zero[1])] },
        })
        const inputs = inputsOf(s, planId, name)
        expect(inputs[0]!.setup.zero).toEqual(zero)
        const after = inputs.map(toolpathOf)
        // drilling order may start elsewhere (N4): compare the sets of points per operation
        after.forEach((tp, i) => {
          const want = points(before[i]!)
            .map((q) => [q[0] - zero[0], q[1] - zero[1], q[2]].map((c) => c.toFixed(6)).join())
            .sort()
          const got = points(tp)
            .map((q) => q.map((c) => c.toFixed(6)).join())
            .sort()
          expect(got).toEqual(want)
        })
      }
      await s.run('plan.setup.update', { planId, setupId, zero: null })
      expect(setupNamed(s.plan(planId), name).zero).toBeUndefined()
    }
  })

  it('the export header names the zero and the points; a corner zero keeps it as before', async () => {
    const { s, planId } = await twoSided()
    const bottom = setupNamed(s.plan(planId), 'Bottom')
    const top = setupNamed(s.plan(planId), 'Top')
    const plain = expectOk(await exportPlan(s.d.doc, planId, services(), { setupId: top.id }))
    expect(plain.lines.some((l) => l.startsWith('(Work zero G54 X0 Y0: front-left corner'))).toBe(
      true,
    )
    expect(plain.lines.some((l) => l.startsWith('(Align'))).toBe(false)
    await s.run('plan.alignment.set', {
      planId,
      setupId: top.id,
      points: [
        { source: { corner: 'top front left' } },
        { name: 'Back edge', source: { edge: 'top back', t: 0.25 } },
      ],
    })
    await s.run('plan.setup.update', { planId, setupId: top.id, zero: { at: ['40', '25'] } })
    const e = expectOk(await exportPlan(s.d.doc, planId, services(), { setupId: top.id }))
    const header = e.lines.slice(0, 16)
    expect(header).toContain('(Corner: front-left corner of the top face)')
    expect(header).toContain('(Work zero G54 X0 Y0: X 40 Y 25 mm from that corner)')
    expect(header).toContain('(Align 2 points after zeroing, spindle off:)')
    expect(header).toContain('(Align 1: Top front-left corner at X -40 Y -25)')
    expect(header).toContain('(Align 2: Back edge at X -15 Y 35)')
    // negative work coordinates in the program body
    expect(e.lines.some((l) => /X-\d/.test(l) && l.startsWith('G'))).toBe(true)
    // the zero on a point
    const pointId = setupNamed(s.plan(planId), 'Top').alignment![0]!.id
    await s.run('plan.setup.update', { planId, setupId: top.id, zero: { point: pointId } })
    const onPoint = expectOk(await exportPlan(s.d.doc, planId, services(), { setupId: top.id }))
    expect(onPoint.lines).toContain('(Work zero on Top front-left corner)')
    // the bottom still exports as before (no zero, no points)
    expectOk(await exportPlan(s.d.doc, planId, services(), { setupId: bottom.id }))
  })

  it('positions, findings and the refusals of plan.alignment.set', async () => {
    const { s, planId } = await twoSided()
    const p = s.plan(planId)
    const bottom = setupNamed(p, 'Bottom')
    const top = setupNamed(p, 'Top')
    const warnings = () =>
      (
        s.query('plan.warning.list', { planId }) as {
          warnings: { code: string; rule: string; severity: string; params: object }[]
        }
      ).warnings.filter((w) => w.code === 'plan.alignment')
    // Top comes after Bottom and has no points: info `none`
    expect(warnings()).toEqual([
      expect.objectContaining({ rule: 'none', severity: 'info', params: { setupId: top.id } }),
    ])
    const drill = top.operations.find((o) =>
      o.designOperationIds.some(
        (d) => s.part().operations.find((x) => x.id === d)?.kind === 'drilling',
      ),
    )!
    const pocket = top.operations.find(
      (o) => s.part().operations.find((x) => x.id === o.designOperationIds[0])?.kind === 'pocket',
    )!
    // points on the Bottom that Top cuts later: not yet cut
    const r = (await s.run('plan.alignment.set', {
      planId,
      setupId: bottom.id,
      points: [
        { source: { corner: 'bottom back left' } },
        { source: { operation: drill.id, hole: 0 } },
      ],
    })) as { alignmentPointIds: string[]; findings: { rule: string }[] }
    expect(r.alignmentPointIds).toEqual(['al1', 'al2'])
    expect(r.findings.map((f) => f.rule)).toEqual(['notYetCut'])
    // reorder: Top first, Bottom second; the through hole is seen from the bottom
    await s.run('plan.setup.move', { planId, setupId: top.id, toIndex: 0 })
    const loaded = expectOk(loadPlan(s.d.doc, planId, 'test'))
    const a = setupAlignment(
      loaded,
      s.plan(planId).setups.find((x) => x.id === bottom.id)!,
    )
    expect(a.points.map((x) => [x.notYetCut, x.reachable])).toEqual([
      [false, true],
      [false, true],
    ])
    // the bottom is flipped about X: the hole at part (15, 15) is at X 15, Y 60 − 15 on the bottom
    expect(a.points[1]!.frame).toEqual([15, 45, 0])
    // a pocket vertex on the old top is neither on the up face nor on the outline
    const v = (await s.run('plan.alignment.set', {
      planId,
      setupId: bottom.id,
      points: [
        { id: 'al1', source: { corner: 'bottom back left' } },
        { source: { operation: pocket.id, vertex: 0 } },
      ],
    })) as { alignmentPointIds: string[]; findings: { rule: string }[] }
    expect(v.alignmentPointIds).toEqual(['al1', 'al3'])
    expect(v.findings.map((f) => f.rule)).toEqual(['notReachable'])
    // an export of the bottom is blocked by its own error; the top's is not
    expectErrCode(
      await exportPlan(s.d.doc, planId, services(), { setupId: bottom.id }),
      'plan.check',
    )
    expectOk(await exportPlan(s.d.doc, planId, services(), { setupId: top.id }))
    // missing source: a hole index out of range
    const m = (await s.run('plan.alignment.set', {
      planId,
      setupId: bottom.id,
      points: [{ source: { operation: drill.id, hole: 99 } }],
    })) as { findings: { rule: string }[] }
    expect(m.findings.map((f) => f.rule)).toEqual(['missingSource'])
    // refusals: unknown id, unknown operation, dropping the zero's point
    await s.failWith(
      'plan.alignment.set',
      {
        planId,
        setupId: bottom.id,
        points: [{ id: 'al77', source: { corner: 'top front left' } }],
      },
      'plan.alignment',
    )
    await s.failWith(
      'plan.alignment.set',
      {
        planId,
        setupId: bottom.id,
        points: [{ source: { operation: 'nope', hole: 0 } }],
      },
      'plan.alignment',
    )
    const id = s.plan(planId).setups.find((x) => x.id === bottom.id)!.alignment![0]!.id
    await s.run('plan.setup.update', { planId, setupId: bottom.id, zero: { point: id } })
    const dropped = await s.failWith(
      'plan.alignment.set',
      { planId, setupId: bottom.id, points: [] },
      'plan.alignment',
    )
    expect(dropped.issues[0]?.rule).toBe('zeroPoint')
    await s.failWith(
      'plan.setup.update',
      { planId, setupId: bottom.id, zero: { point: 'al99' } },
      'plan.alignment',
    )
  })

  it('moving the zero keeps a chosen touch-off spot on the same place (S3)', async () => {
    const { s, planId } = await twoSided()
    const top = setupNamed(s.plan(planId), 'Top')
    const first = top.operations[0]!
    await s.run('plan.operation.update', {
      planId,
      planOperationId: first.id,
      zRef: { at: ['30', '20'] },
    })
    await s.run('plan.setup.update', { planId, setupId: top.id, zero: { at: ['10', '-5'] } })
    const after = setupNamed(s.plan(planId), 'Top').operations[0]!
    expect(after.zRef?.at).toEqual([20, 25])
    await s.run('plan.setup.update', { planId, setupId: top.id, zero: null })
    expect(setupNamed(s.plan(planId), 'Top').operations[0]!.zRef?.at).toEqual([30, 20])
  })

  it('merge keeps the first zero and concatenates the points; split keeps both on the source', async () => {
    const { s, planId } = await twoSided()
    const top = setupNamed(s.plan(planId), 'Top')
    await s.run('plan.alignment.set', {
      planId,
      setupId: top.id,
      points: [{ source: { corner: 'top front left' } }],
    })
    await s.run('plan.setup.update', { planId, setupId: top.id, zero: { at: ['5', '5'] } })
    const { setupId: second } = (await s.run('plan.setup.split', {
      planId,
      setupId: top.id,
      planOperationIds: [top.operations.at(-1)!.id],
    })) as { setupId: string }
    const split = s.plan(planId)
    expect(split.setups.find((x) => x.id === top.id)).toMatchObject({
      zero: { at: [5, 5] },
      alignment: [{ id: 'al1' }],
    })
    expect(split.setups.find((x) => x.id === second)?.alignment).toBeUndefined()
    await s.run('plan.alignment.set', {
      planId,
      setupId: second,
      points: [{ source: { corner: 'top back right' } }],
    })
    await s.run('plan.setup.merge', { planId, setupIds: [top.id, second] })
    const merged = s.plan(planId).setups.find((x) => x.id === top.id)!
    expect(merged.zero).toEqual({ at: [5, 5] })
    expect(merged.alignment?.map((x) => x.id)).toEqual(['al1', 'al2'])
  })
})
