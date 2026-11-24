// Spec: docs/modes/alignment.md (Alignment aids, Implementation (slice 2)).
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { deg, len, libraryInput, num } from '../library/library.fixture'
import { exportPlan } from '../post/plan-export'
import { createToolpathCache } from '../toolpath/cache'
import { toGeneratorInputs } from '../toolpath/inputs'
import type { Toolpath } from '../toolpath/model'
import { generateRequest } from '../toolpath/request'
import { markDepth } from './aids'
import { planOperationInputs } from './inputs'
import type { PlanDTO, PlanOperationDTO } from './plan.dto'
import { planSetup, type PlanSetup } from './plan.fixture'

const vbit = (angle = '90') => ({
  name: `V-bit ${angle}`,
  type: 'chamferMill' as const,
  diameter: len('6'),
  angle: deg(angle),
  fluteLength: len('8'),
  overallLength: len('50'),
  fluteCount: num('2'),
  toolMaterial: 'carbide' as const,
  presets: [],
})

const services = () => ({ workers: createInProcessWorkers(), toolpaths: createToolpathCache() })

interface Finding {
  rule: string
  message: string
  planOperationId?: string
  alignmentPointId?: string
}
interface AidResult {
  planOperationIds: string[]
  alignmentPointIds: string[]
  findings: Finding[]
}

/** The test part with a bottom facing (setups Bottom, Top) and a 90° V-bit in the library. */
async function twoSided(opts: { vbit?: boolean } = {}) {
  const s = await planSetup()
  if (opts.vbit !== false) await s.run('library.tool.add', { values: libraryInput(vbit()) })
  await s.run('design.facing.add', { partId: s.partId, on: 'stock.bottom', depth: '0.5' })
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  // the 6 mm drill has no data: every drilling gets overrides
  const drillings = new Set(
    s
      .part()
      .operations.filter((o) => o.kind === 'drilling')
      .map((o) => o.id),
  )
  for (const setup of s.plan(planId).setups)
    for (const op of setup.operations)
      if (op.designOperationIds.some((d) => drillings.has(d)))
        await s.run('plan.operation.update', {
          planId,
          planOperationId: op.id,
          overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
        })
  return { s, planId }
}

const setupNamed = (p: PlanDTO, name: string) => p.setups.find((x) => x.name === name)!
const opOf = (p: PlanDTO, id: string): PlanOperationDTO =>
  p.setups.flatMap((x) => x.operations).find((o) => o.id === id)!
const aidSet = async (s: PlanSetup, args: object) =>
  (await s.run('plan.aid.set', args)) as AidResult
const warnings = (s: PlanSetup, planId: string) =>
  (
    s.query('plan.warning.list', { planId }) as {
      warnings: { code: string; rule: string; planOperationId?: string; severity: string }[]
    }
  ).warnings

function zRange(tp: Toolpath): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (const p of tp.passes)
    for (const m of p.moves) {
      const zs = m.kind === 'drill' ? [m.top, m.bottom] : [m.to[2]]
      for (const z of zs) {
        min = Math.min(min, z)
        max = Math.max(max, z)
      }
    }
  return { min, max }
}

describe('alignment aids (S13–S19)', { timeout: 60_000 }, () => {
  it('mark depth follows the V-bit angle', () => {
    expect(markDepth(1, 90)).toBeCloseTo(0.5)
    expect(markDepth(1, 60)).toBeCloseTo(0.866, 3)
  })

  it('places two marks in the waste of the top for the bottom, named and as its points', async () => {
    const { s, planId } = await twoSided()
    const p0 = s.plan(planId)
    const first = setupNamed(p0, p0.setups[0]!.name)
    const second = p0.setups[1]!
    const r = await aidSet(s, {
      planId,
      setupId: first.id,
      place: 'marks',
      forSetupId: second.id,
    })
    expect(r.planOperationIds).toHaveLength(2)
    expect(r.alignmentPointIds).toHaveLength(2)
    const p = s.plan(planId)
    const names = r.planOperationIds.map((id) => opOf(p, id).aid!.name)
    expect(names).toEqual(['Witness mark 1', 'Witness mark 2'])
    // marks go last, and never into the part: no inPart finding, no error
    const ops = p.setups[0]!.operations
    expect(ops.slice(-2).map((o) => o.id)).toEqual(r.planOperationIds)
    expect(r.findings.filter((f) => f.rule === 'inPart')).toEqual([])
    const errs = warnings(s, planId).filter(
      (w) => w.severity === 'error' && r.planOperationIds.includes(w.planOperationId ?? ''),
    )
    expect(errs).toEqual([])
    // the later setup aligns on them, reachable (the aids are cut before)
    expect(p.setups[1]!.alignment!.map((a) => a.source)).toEqual(
      r.planOperationIds.map((aid) => ({ aid })),
    )
    expect(warnings(s, planId).filter((w) => w.rule === 'notYetCut')).toEqual([])
    // a mark's toolpath: V-bit at its depth (1 mm at the face, 90°: 0.5 mm)
    const inputs = expectOk(planOperationInputs(s.d.doc, planId, r.planOperationIds))
    expect(inputs.map((i) => i.aid?.kind)).toEqual(['mark', 'mark'])
    for (const i of inputs) {
      const tp = expectOk(generateRequest(expectOk(toGeneratorInputs(i))))
      expect(zRange(tp).min).toBeCloseTo(-0.5, 6)
    }
  })

  it('a registration hole drills through into the spoilboard and exports like any operation', async () => {
    const { s, planId } = await twoSided()
    const p0 = s.plan(planId)
    const first = p0.setups[0]!
    // a 6 mm hole (the library's 6 mm drill; 6.2 mm, the default, has no tool here), 5 mm deep
    const r = await aidSet(s, {
      planId,
      setupId: first.id,
      place: 'holes',
      aid: { diameter: '6', spoilboardDepth: '5' },
    })
    expect(r.planOperationIds).toHaveLength(2)
    const p = s.plan(planId)
    const holes = r.planOperationIds.map((id) => opOf(p, id))
    expect(holes.map((h) => h.aid!.name)).toEqual(['Registration hole 1', 'Registration hole 2'])
    expect(holes.every((h) => h.tool !== undefined)).toBe(true)
    for (const h of holes)
      await s.run('plan.operation.update', {
        planId,
        planOperationId: h.id,
        overrides: { spindleSpeed: '9000', feedRate: '600', plungeRate: '300' },
      })
    const inputs = expectOk(planOperationInputs(s.d.doc, planId, r.planOperationIds))
    const stock = inputs[0]!.stock.thickness.canonical
    for (const i of inputs) {
      expect(i.aid?.kind).toBe('hole')
      const tp = expectOk(generateRequest(expectOk(toGeneratorInputs(i))))
      // through the stock and 5 mm into the spoilboard
      expect(zRange(tp).min).toBeLessThanOrEqual(-stock - 5 + 1e-6)
      expect(zRange(tp).min).toBeGreaterThan(-stock - 10)
    }
    const e = expectOk(await exportPlan(s.d.doc, planId, services(), { setupId: first.id }))
    const at = (name: string) => e.lines.indexOf(`(${name})`)
    expect(at('Registration hole 1')).toBeGreaterThan(0)
    expect(at('Registration hole 2')).toBeGreaterThan(at('Registration hole 1'))
  })

  it('a hole over the part is a plan.aid inPart warning; update and remove work', async () => {
    const { s, planId } = await twoSided()
    const first = s.plan(planId).setups[0]!
    const r = await aidSet(s, {
      planId,
      setupId: first.id,
      aid: { kind: 'registrationHole', center: ['50', '30'] },
    })
    const id = r.planOperationIds[0]!
    expect(r.findings.map((f) => f.rule)).toContain('inPart')
    const u = await aidSet(s, {
      planId,
      planOperationId: id,
      aid: { center: ['3', '3'], name: 'Dowel A' },
    })
    expect(u.findings.map((f) => f.rule)).not.toContain('inPart')
    expect(opOf(s.plan(planId), id).aid).toMatchObject({ name: 'Dowel A', center: [3, 3] })
    await aidSet(s, { planId, planOperationId: id })
    expect(opOf(s.plan(planId), id)).toBeUndefined()
  })

  it('a mark without a pointed V-bit is an error finding', async () => {
    const { s, planId } = await twoSided({ vbit: false })
    const first = s.plan(planId).setups[0]!
    const r = await aidSet(s, {
      planId,
      setupId: first.id,
      aid: { kind: 'witnessMark', at: ['2', '2'] },
    })
    const id = r.planOperationIds[0]!
    const errs = warnings(s, planId).filter((w) => w.planOperationId === id)
    expect(errs.some((w) => w.severity === 'error')).toBe(true)
  })

  it('an aid stays in its frame, and a rebuild keeps it', async () => {
    const { s, planId } = await twoSided()
    const [first, second] = s.plan(planId).setups
    const r = await aidSet(s, {
      planId,
      setupId: first!.id,
      place: 'marks',
      forSetupId: second!.id,
    })
    const id = r.planOperationIds[0]!
    // across directions: refused as for any operation
    await s.failWith(
      'plan.operation.move',
      { planId, planOperationId: id, toSetupId: second!.id, toIndex: 0 },
      'plan.setup',
    )
    // same direction, another rotation: the aid's frame would change
    const onTop = (
      await aidSet(s, { planId, setupId: second!.id, aid: { kind: 'witnessMark', at: ['2', '2'] } })
    ).planOperationIds[0]!
    const topOps = s.plan(planId).setups[1]!.operations
    await s.run('plan.setup.split', {
      planId,
      setupId: second!.id,
      planOperationIds: [topOps[1]!.id],
    })
    const split = s.plan(planId).setups[2]!
    await s.run('plan.setup.update', { planId, setupId: split.id, rotation: 90 })
    const err = await s.failWith(
      'plan.operation.move',
      { planId, planOperationId: onTop, toSetupId: split.id, toIndex: 0 },
      'plan.aid',
    )
    expect(err.issues?.[0]?.rule).toBe('otherFrame')
    await s.run('plan.rebuild', { planId })
    const p = s.plan(planId)
    expect(r.planOperationIds.every((x) => opOf(p, x)?.aid !== undefined)).toBe(true)
    expect(p.setups[1]!.alignment).toHaveLength(2)
  })
})
