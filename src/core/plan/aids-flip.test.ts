// Spec: docs/modes/alignment.md § Implementation (follow-ups, Q106–Q108 assumed): the flip axis
// of registration holes (S25), side marks as edge points (S26), a rebuild keeping a setup that
// holds only aids (S20).
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { deg, len, libraryInput, num } from '../library/library.fixture'
import { flipAxis, setupMap, type FlipAxis } from './aids'
import { setupAlignment } from './alignment'
import { loadPlan } from './plan'
import type { PlanDTO, SetupDTO } from './plan.dto'
import { planSetup, type PlanSetup } from './plan.fixture'

const STOCK = { length: 100, width: 60, thickness: 20 }
type Dir = '+x' | '-x' | '+y' | '-y' | '+z' | '-z'
const setup = (direction: Dir, rotation: 0 | 90 | 180 | 270 = 0): SetupDTO =>
  ({
    id: `${direction}${rotation}`,
    name: direction,
    workOffset: 'G54',
    direction,
    ...(rotation === 0 ? {} : { rotation }),
    operations: [],
  }) as unknown as SetupDTO

const near = (a: readonly number[], b: readonly number[], eps = 1e-6) =>
  a.every((c, i) => Math.abs(c - b[i]!) < eps)

/** Points along the axis (its ends and middle). */
const onAxis = (x: FlipAxis): [number, number][] => [
  [x.from[0], x.from[1]],
  [(x.from[0] + x.to[0]) / 2, (x.from[1] + x.to[1]) / 2],
  [x.to[0], x.to[1]],
]

describe('the flip axis (S25, Q106 assumed)', () => {
  it('exists for every flip and rotation; points on it keep their place up to one shift', () => {
    for (const [a, b] of [
      ['+z', '-z'],
      ['-z', '+z'],
      ['+x', '-x'],
      ['-y', '+y'],
    ] as const)
      for (const ra of [0, 90, 180, 270] as const)
        for (const rb of [0, 90, 180, 270] as const) {
          const A = setup(a, ra)
          const B = setup(b, rb)
          const axis = flipAxis(A, B, STOCK)
          expect(axis, `${a}${ra} → ${b}${rb}`).toBeDefined()
          const map = setupMap(A, B, STOCK)
          const shifts = onAxis(axis!).map((p) => {
            const q = map(p)
            return [q[0] - p[0], q[1] - p[1]]
          })
          // one common shift: two dowels on the axis fit both sides
          for (const s of shifts) expect(near(s, shifts[0]!)).toBe(true)
          // the later frame's view of the axis is the image of its ends
          expect(near(axis!.later.from, map(axis!.from), 1e-3)).toBe(true)
        }
  })

  it('a flip about X with the stock unturned: the mid line, the holes land on themselves', () => {
    const axis = flipAxis(setup('+z'), setup('-z'), STOCK)!
    expect([axis.from, axis.to]).toEqual([
      [0, 30],
      [100, 30],
    ])
    expect(axis.later).toEqual({ from: [0, 30], to: [100, 30] })
    // a hole at X 10 Y 30 drilled from the top is at X 10 Y 30 from the bottom
    expect(near(setupMap(setup('+z'), setup('-z'), STOCK)([10, 30]), [10, 30])).toBe(true)
  })

  it('no axis for a turn or a side setup', () => {
    expect(flipAxis(setup('+z'), setup('+z', 90), STOCK)).toBeUndefined()
    expect(flipAxis(setup('+z'), setup('-y'), STOCK)).toBeUndefined()
  })
})

const vbit = () => ({
  name: 'V-bit 90',
  type: 'chamferMill' as const,
  diameter: len('6'),
  angle: deg('90'),
  fluteLength: len('8'),
  overallLength: len('50'),
  fluteCount: num('2'),
  toolMaterial: 'carbide' as const,
  presets: [],
})

/** The test part plus a bottom facing, Top first (so the Bottom flips it). */
async function topThenBottom(): Promise<{ s: PlanSetup; planId: string }> {
  const s = await planSetup()
  await s.run('library.tool.add', { values: libraryInput(vbit()) })
  await s.run('design.facing.add', { partId: s.partId, on: 'stock.bottom', depth: '0.5' })
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const top = s.plan(planId).setups.find((x) => x.name === 'Top')!
  await s.run('plan.setup.move', { planId, setupId: top.id, toIndex: 0 })
  return { s, planId }
}

interface AidResult {
  planOperationIds: string[]
  alignmentPointIds: string[]
  findings: { rule: string }[]
}
interface View {
  alignment: {
    setupId: string
    zero: [number, number]
    points: { id: string; kind: string; wcs: [number, number] | null; oneAxis?: string }[]
    flipAxes?: { from: [number, number]; to: [number, number]; otherSetupId: string }[]
  }[]
  warnings: { code: string; rule: string; severity: string; planOperationId?: string }[]
}
const view = (s: PlanSetup, planId: string) => s.query('plan.warning.list', { planId }) as View
const named = (p: PlanDTO, name: string) => p.setups.find((x) => x.name === name)!

describe('registration holes on the flip axis (S25)', { timeout: 60_000 }, () => {
  it('the helper puts both holes on the axis, in the waste, as points of the flipped setup', async () => {
    const { s, planId } = await topThenBottom()
    const p0 = s.plan(planId)
    const [top, bottom] = [named(p0, 'Top'), named(p0, 'Bottom')]
    const r = (await s.run('plan.aid.set', {
      planId,
      setupId: top.id,
      place: 'holes',
      forSetupId: bottom.id,
      aid: { diameter: '6' },
    })) as AidResult
    const p = s.plan(planId)
    const centres = r.planOperationIds.map(
      (id) =>
        named(p, 'Top').operations.find((o) => o.id === id)!.aid as { center: [number, number] },
    )
    // the axis is Y 30 (Bottom flips about X); one hole near each end, centred in the 8 mm of
    // waste before the profile (Ø/2 + 3 mm in would touch the part)
    expect(centres.map((c) => c.center)).toEqual([
      [4.25, 30],
      [95.75, 30],
    ])
    expect(r.findings.map((f) => f.rule)).not.toContain('offAxis')
    // the Bottom sees each hole where it was drilled; the axis is drawn in both setups
    const v = view(s, planId)
    const b = v.alignment.find((a) => a.setupId === bottom.id)!
    expect(b.points.map((x) => x.wcs)).toEqual([
      [4.25, 30],
      [95.75, 30],
    ])
    expect(b.flipAxes).toEqual([{ from: [0, 30], to: [100, 30], otherSetupId: top.id }])
    expect(v.alignment.find((a) => a.setupId === top.id)!.flipAxes).toEqual([
      { from: [0, 30], to: [100, 30], otherSetupId: bottom.id },
    ])
  })

  it('a moved work zero moves neither the holes nor the axis; the points follow it', async () => {
    const { s, planId } = await topThenBottom()
    const p0 = s.plan(planId)
    const [top, bottom] = [named(p0, 'Top'), named(p0, 'Bottom')]
    await s.run('plan.aid.set', {
      planId,
      setupId: top.id,
      place: 'holes',
      forSetupId: bottom.id,
      aid: { diameter: '6' },
    })
    await s.run('plan.setup.update', { planId, setupId: top.id, zero: { at: ['50', '30'] } })
    await s.run('plan.setup.update', { planId, setupId: bottom.id, zero: { at: ['100', '0'] } })
    const v = view(s, planId)
    const b = v.alignment.find((a) => a.setupId === bottom.id)!
    // the Bottom's zero at its front-right corner: WCS = setup frame − zero
    expect(b.points.map((x) => x.wcs)).toEqual([
      [-95.75, 30],
      [-4.25, 30],
    ])
    expect(b.flipAxes![0]).toMatchObject({ from: [0, 30], to: [100, 30] })
    const t = v.alignment.find((a) => a.setupId === top.id)!
    expect(t.flipAxes![0]).toMatchObject({ from: [0, 30], to: [100, 30] })
    // the run step's entries (pointer targets) are the same WCS positions
    const loaded = expectOk(loadPlan(s.d.doc, planId, 'test'))
    const a = setupAlignment(loaded, named(s.plan(planId), 'Bottom'))
    expect(a.points.map((x) => x.wcs)).toEqual([
      [-95.75, 30],
      [-4.25, 30],
    ])
    expect(v.warnings.filter((w) => w.rule === 'offAxis')).toEqual([])
  })

  it('a hole moved off the axis is the warning offAxis; mirrored about it is fine', async () => {
    const { s, planId } = await topThenBottom()
    const p0 = s.plan(planId)
    const [top, bottom] = [named(p0, 'Top'), named(p0, 'Bottom')]
    const r = (await s.run('plan.aid.set', {
      planId,
      setupId: top.id,
      place: 'holes',
      forSetupId: bottom.id,
      aid: { diameter: '6' },
    })) as AidResult
    const [h1, h2] = r.planOperationIds as [string, string]
    const u = (await s.run('plan.aid.set', {
      planId,
      planOperationId: h2,
      aid: { center: ['95.75', '33'] },
    })) as AidResult
    expect(u.findings.map((f) => f.rule)).toContain('offAxis')
    const off = view(s, planId).warnings.filter((w) => w.rule === 'offAxis')
    expect(off.map((w) => [w.planOperationId, w.severity])).toEqual([[h2, 'warning']])
    // both 3 mm off on the same side: the flipped stock shifts 6 mm but sits on both dowels
    await s.run('plan.aid.set', { planId, planOperationId: h1, aid: { center: ['4.25', '27'] } })
    expect(view(s, planId).warnings.filter((w) => w.rule === 'offAxis')).toHaveLength(2)
    await s.run('plan.aid.set', { planId, planOperationId: h1, aid: { center: ['4.25', '33'] } })
    expect(view(s, planId).warnings.filter((w) => w.rule === 'offAxis')).toEqual([])
  })
})

describe('a witness mark on a side wall (S26, Q108 assumed)', { timeout: 60_000 }, () => {
  it('is an edge point that checks one axis, with the info sideMark', async () => {
    const s = await planSetup()
    await s.run('library.tool.add', { values: libraryInput(vbit()) })
    // a front facing gives a Front setup (−y up): the old top is one of its side walls
    await s.run('design.facing.add', { partId: s.partId, on: 'stock.side[0]', depth: '0.5' })
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const p0 = s.plan(planId)
    const top = named(p0, 'Top')
    const front = named(p0, 'Front')
    await s.run('plan.setup.move', { planId, setupId: top.id, toIndex: 0 })
    const r = (await s.run('plan.aid.set', {
      planId,
      setupId: top.id,
      forSetupId: front.id,
      aid: { kind: 'witnessMark', at: ['50', '2'] },
    })) as AidResult
    const v = view(s, planId)
    const pt = v.alignment
      .find((a) => a.setupId === front.id)!
      .points.find((x) => x.id === r.alignmentPointIds[0])!
    expect(pt.kind).toBe('edge')
    expect(pt.oneAxis).toBe('x')
    const info = v.warnings.filter((w) => w.rule === 'sideMark')
    expect(info.map((w) => w.severity)).toEqual(['info'])
    expect(v.warnings.filter((w) => w.rule === 'notReachable')).toEqual([])
  })
})

describe('a rebuild keeps a setup left with only aids (S20)', { timeout: 60_000 }, () => {
  it('keeps the setup, its aids and the points on them, with the info onlyAids', async () => {
    const { s, planId } = await topThenBottom()
    const p0 = s.plan(planId)
    const [top, bottom] = [named(p0, 'Top'), named(p0, 'Bottom')]
    const r = (await s.run('plan.aid.set', {
      planId,
      setupId: bottom.id,
      place: 'marks',
    })) as AidResult
    // the bottom facing goes: Bottom keeps only its two marks
    const facing = s
      .part()
      .operations.find((o) => o.kind === 'facing' && JSON.stringify(o).includes('stock.bottom'))!
    await s.run('design.operation.remove', { partId: s.partId, operationId: facing.id })
    await s.run('project.apply', {})
    await s.run('plan.rebuild', { planId })
    const p = s.plan(planId)
    const kept = p.setups.find((x) => x.id === bottom.id)
    expect(kept?.operations.map((o) => o.id)).toEqual(r.planOperationIds)
    expect(p.setups.map((x) => x.id)).toEqual([top.id, bottom.id])
    const info = view(s, planId).warnings.filter((w) => w.rule === 'onlyAids')
    expect(info.map((w) => w.severity)).toEqual(['info'])
    // removing the last aid takes the empty setup with it
    for (const id of r.planOperationIds)
      await s.run('plan.aid.set', { planId, planOperationId: id })
    expect(s.plan(planId).setups.map((x) => x.id)).toEqual([top.id])
  })
})
