// Spec: docs/modes/plan-v0.2.md (Toolpaths per setup; Implementation (task C3)).
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { DIRECTIONS, faceFrame, toPartFrame } from '../geometry/face'
import { applyPlacement, type Vec3 } from '../geometry/model'
import { planOperationInputs, type PlanOperationInput } from '../plan/inputs'
import type { PlanDTO } from '../plan/plan.dto'
import { planSetup, type PlanSetup } from '../plan/plan.fixture'
import { exportPlan } from '../post/plan-export'
import { createToolpathCache } from './cache'
import { toGeneratorInputs } from './inputs'
import type { Move, Toolpath } from './model'
import { generateRequest, GeneratorRequestSchema, type GeneratorRequest } from './request'
import { toolpathStats } from './stats'
import { render } from './testing/oracles'
import {
  fromWcs,
  setupFrame,
  setupOrientation,
  setupWcs,
  toWcs,
  turnToolpath,
  type WcsRotation,
} from './wcs'

const STOCK = { length: 100, width: 60, thickness: 20 }
const ROTATIONS: WcsRotation[] = [0, 90, 180, 270]

const rect = (cx: string, cy: string, length: string, width: string) => ({
  kind: 'rectangle',
  center: [cx, cy],
  length,
  width,
  cornerRadius: '3',
})

/** A bottom facing with a pocket on its floor, and a flat hole in the right side (+x). */
async function bottomAndSide(s: PlanSetup, opts: { bottom?: boolean; side?: boolean } = {}) {
  const partId = s.partId
  if (opts.bottom !== false) {
    await s.run('design.facing.add', { partId, on: 'stock.bottom', depth: '0.5' })
    const facing = s.part().operations.at(-1)!.id
    await s.run('design.pocket.add', {
      partId,
      on: `${facing}.floor`,
      shape: rect('50', '30', '20', '10'),
      depth: '3',
      floorRadius: '0',
    })
  }
  if (opts.side !== false)
    await s.run('design.drilling.add', {
      partId,
      on: 'stock.side[1]',
      center: ['30', '10'],
      diameter: '6',
      bottom: 'flat',
      depth: '12',
    })
}

/** The test part plus bottom and side operations: setups Bottom, Right, Top. */
async function multiPlan() {
  const s = await planSetup()
  await bottomAndSide(s)
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  // the 6 mm drill has no data: every drilling gets overrides
  const drillings = new Set(
    s
      .part()
      .operations.filter((o) => o.kind === 'drilling')
      .map((o) => o.id),
  )
  for (const op of s.plan(planId).setups.flatMap((x) => x.operations))
    if (op.designOperationIds.some((d) => drillings.has(d)))
      await s.run('plan.operation.update', {
        planId,
        planOperationId: op.id,
        overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
      })
  return { s, planId }
}

const setupOf = (p: PlanDTO, name: string) => p.setups.find((x) => x.name === name)!
const inputsOf = (s: PlanSetup, planId: string, setup: string): PlanOperationInput[] => {
  const ids = setupOf(s.plan(planId), setup).operations.map((o) => o.id)
  return expectOk(planOperationInputs(s.d.doc, planId, ids))
}
const toolpathOf = (input: PlanOperationInput): Toolpath =>
  expectOk(generateRequest(expectOk(toGeneratorInputs(input))))

/** Every position a toolpath reaches (move ends, arc centers at the end's Z, drill tops/bottoms). */
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

const close = (a: Vec3, b: Vec3) => a.every((c, i) => Math.abs(c - b[i]!) < 1e-9)

describe('setup WCS', () => {
  it('toWcs and fromWcs are inverse quarter turns that keep the face inside [0, size]', () => {
    for (const d of DIRECTIONS)
      for (const r of ROTATIONS.slice(1) as (90 | 180 | 270)[]) {
        const wcs = setupWcs(d, r, STOCK)!
        const [L, W] = wcs.size
        const [X, Y] = r === 180 ? [L, W] : [W, L]
        for (const p of [
          [0, 0],
          [L, 0],
          [L, W],
          [0, W],
          [12.3, 4.5],
        ] as const) {
          const q = toWcs(p, wcs)
          expect(q[0]).toBeGreaterThanOrEqual(0)
          expect(q[0]).toBeLessThanOrEqual(X)
          expect(q[1]).toBeGreaterThanOrEqual(0)
          expect(q[1]).toBeLessThanOrEqual(Y)
          const back = fromWcs(q, wcs)
          expect(close([back[0], back[1], 0], [p[0], p[1], 0])).toBe(true)
        }
      }
    expect(setupWcs('+z', 0, STOCK)).toBeUndefined()
    // 90°: u turns onto machine +Y, the work zero moves to the face's lower-right corner
    expect(toWcs([0, 0], setupWcs('+z', 90, STOCK)!)).toEqual([60, 0])
    expect(toWcs([100, 0], setupWcs('+z', 90, STOCK)!)).toEqual([60, 100])
  })

  it('setupFrame places the WCS on the face: work zero at the lower-left corner, Z along n', () => {
    // +z without rotation: the identity (v0.1)
    expect(setupFrame('+z', 0, STOCK)).toEqual(faceFrame('+z', STOCK))
    expect(applyPlacement(setupFrame('+z', 0, STOCK), [1, 2, 3])).toEqual([1, 2, 3])
    for (const d of DIRECTIONS)
      for (const r of ROTATIONS) {
        const frame = setupFrame(d, r, STOCK)
        const face = faceFrame(d, STOCK)
        const wcs = setupWcs(d, r, STOCK)
        // a face-frame point and its WCS image are the same part point
        for (const p of [
          [0, 0, 0],
          [7, 3, -2],
        ] as const) {
          const q = wcs === undefined ? [p[0], p[1]] : toWcs([p[0], p[1]], wcs)
          expect(close(applyPlacement(frame, [q[0]!, q[1]!, p[2]]), toPartFrame(face, p))).toBe(
            true,
          )
        }
        expect(frame.n).toEqual(face.n)
      }
  })

  it('turnToolpath keeps arc senses and lengths and recomputes stats per axis', () => {
    const tp: Toolpath = {
      planOperationId: 'p',
      tool: 't',
      spindleSpeed: 1000,
      passes: [
        {
          kind: 'rough',
          moves: [
            { kind: 'rapid', to: [0, 0, 5] },
            { kind: 'line', to: [10, 0, 0], feed: 500 },
            { kind: 'arc', to: [20, 0, 0], center: [15, 0], cw: true, feed: 500 },
            { kind: 'rapid', to: [20, 30, 5] },
          ],
        },
      ],
      stats: { cutLength: 0, rapidLength: 0, estimatedSeconds: 0 },
    }
    const rates: Vec3 = [6000, 3000, 1000]
    const turned = turnToolpath(tp, { rotation: 90, size: [100, 60] }, rates)
    const moves = turned.passes[0]!.moves
    expect(moves[1]).toEqual({ kind: 'line', to: [60, 10, 0], feed: 500 })
    expect(moves[2]).toEqual({
      kind: 'arc',
      to: [60, 20, 0],
      center: [60, 15],
      cw: true,
      feed: 500,
    })
    expect(turned.stats).toEqual(toolpathStats(turned.passes, rates))
    expect(turned.stats.cutLength).toBeCloseTo(toolpathStats(tp.passes, rates).cutLength, 9)
    // the long rapid ran along Y at 3000, now along X at 6000
    expect(turned.stats.estimatedSeconds).toBeLessThan(
      toolpathStats(tp.passes, rates).estimatedSeconds,
    )
  })
})

describe('toolpaths per setup', () => {
  it('passes bottom and side operations in their face frame; unrotated setups have no turn', async () => {
    const { s, planId } = await multiPlan()
    expect(s.plan(planId).setups.map((x) => x.name)).toEqual(['Bottom', 'Right', 'Top'])
    for (const [name, stock] of [
      ['Bottom', { length: 100, width: 60, thickness: 20 }],
      ['Right', { length: 60, width: 20, thickness: 100 }],
      ['Top', { length: 100, width: 60, thickness: 20 }],
    ] as const)
      for (const input of inputsOf(s, planId, name)) {
        const r = expectOk(toGeneratorInputs(input))
        expect(GeneratorRequestSchema.safeParse(r).success).toBe(true)
        expect(r.wcs).toBeUndefined()
        for (const g of r.inputs) {
          expect(g.stock).toEqual(stock)
          expect(g.operation).not.toHaveProperty('direction')
        }
      }
    const [pocket] = inputsOf(s, planId, 'Bottom').filter((i) => i.kind === 'pocket')
    const r = expectOk(toGeneratorInputs(pocket!)) as Extract<GeneratorRequest, { kind: 'pocket' }>
    // on the bottom facing's floor, 0.5 below the bottom stock face
    expect(r.inputs[0]!.operation).toMatchObject({
      onZ: -0.5,
      depth: 3,
      shape: { center: [50, 30] },
    })
  })

  it('toolpaths land on the part where the geometry puts the features', async () => {
    const { s, planId } = await multiPlan()
    const p = s.plan(planId)
    // right side: the hole axis at part y 30, z −10, drilled 12 deep from x = 100
    const [hole] = inputsOf(s, planId, 'Right')
    const right = setupFrame('+x', 0, STOCK)
    const holePts = points(toolpathOf(hole!)).map((q) => applyPlacement(right, q))
    const below = holePts.filter((q) => q[0] < 100)
    expect(below.length).toBeGreaterThan(0)
    for (const q of below) {
      expect(Math.hypot(q[1] - 30, q[2] + 10)).toBeLessThanOrEqual(3 + 1e-9)
      expect(q[0]).toBeGreaterThanOrEqual(88 - 1e-9)
    }
    expect(Math.min(...holePts.map((q) => q[0]))).toBeCloseTo(88, 9)
    // bottom: the pocket 20 × 10 at part x 50, y 30, from z −19.5 up to −16.5
    const pocket = inputsOf(s, planId, 'Bottom').find((i) => i.kind === 'pocket')!
    const bottom = setupFrame('-z', 0, STOCK)
    const cut = points(toolpathOf(pocket))
      .map((q) => applyPlacement(bottom, q))
      .filter((q) => q[2] > -19.5 + 1e-9)
    expect(cut.length).toBeGreaterThan(0)
    for (const q of cut) {
      expect(Math.abs(q[0] - 50)).toBeLessThanOrEqual(10 + 1e-9)
      expect(Math.abs(q[1] - 30)).toBeLessThanOrEqual(5 + 1e-9)
    }
    expect(Math.max(...cut.map((q) => q[2]))).toBeCloseTo(-16.5, 9)
    expect(setupOf(p, 'Bottom').direction).toBe('-z')
  })

  it('a rotated setup turns the toolpath; placed back on the part it is the same path', async () => {
    const { s, planId } = await multiPlan()
    const before = inputsOf(s, planId, 'Bottom').map(toolpathOf)
    const setupId = setupOf(s.plan(planId), 'Bottom').id
    for (const rotation of [90, 180, 270] as const) {
      await s.run('plan.setup.update', { planId, setupId, rotation })
      const inputs = inputsOf(s, planId, 'Bottom')
      const after = inputs.map((i) => {
        const r = expectOk(toGeneratorInputs(i))
        expect(r.wcs).toEqual({ rotation, size: [100, 60] })
        expect(GeneratorRequestSchema.safeParse(r).success).toBe(true)
        // generators still get the face frame
        for (const g of r.inputs) expect(g.stock).toEqual(STOCK)
        return expectOk(generateRequest(r))
      })
      const unturned = setupFrame('-z', 0, STOCK)
      const turned = setupFrame('-z', rotation, STOCK)
      after.forEach((tp, k) => {
        const a = points(before[k]!).map((q) => applyPlacement(unturned, q))
        const b = points(tp).map((q) => applyPlacement(turned, q))
        expect(b.length).toBe(a.length)
        b.forEach((q, i) => expect(close(q, a[i]!), `${tp.planOperationId} #${i}`).toBe(true))
        // within the turned stock face
        const [X, Y] = rotation === 180 ? [100, 60] : [60, 100]
        for (const q of points(tp).filter((q) => q[2] < 0)) {
          expect(q[0]).toBeGreaterThanOrEqual(-1 - 3 - 1e-9)
          expect(q[0]).toBeLessThanOrEqual(X + 1 + 3 + 1e-9)
          expect(q[1]).toBeGreaterThanOrEqual(-1 - 3 - 1e-9)
          expect(q[1]).toBeLessThanOrEqual(Y + 1 + 3 + 1e-9)
        }
      })
    }
  })

  it('drills in nearest-neighbour order from the work zero of the turned WCS', async () => {
    const s = await planSetup({ part: false })
    for (const x of ['10', '90'])
      await s.run('design.drilling.add', {
        partId: s.partId,
        center: [x, '30'],
        diameter: '6',
        bottom: 'flat',
        depth: '5',
      })
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const setupId = s.plan(planId).setups[0]!.id
    const order = () => {
      const [input] = expectOk(planOperationInputs(s.d.doc, planId))
      const r = expectOk(toGeneratorInputs(input!)) as Extract<
        GeneratorRequest,
        { kind: 'drilling' }
      >
      return r.inputs.map((h) => h.operation.center[0])
    }
    expect(order()).toEqual([10, 90])
    await s.run('plan.setup.update', { planId, setupId, rotation: 180 })
    expect(order()).toEqual([90, 10])
  })

  it('an operation whose face is not its setup direction fails with plan.setup', async () => {
    const { s, planId } = await multiPlan()
    const [hole] = inputsOf(s, planId, 'Right')
    const e = expectErrCode(
      toGeneratorInputs({ ...hole!, setup: { ...hole!.setup, direction: '+z' } }),
      'plan.setup',
    )
    expect(e.issues?.[0]?.rule).toBe('setupDirection')
  })

  it('golden: the bottom and right setups of the multi-face part', async () => {
    const { s, planId } = await multiPlan()
    for (const [name, file] of [
      ['Bottom', 'setup-bottom'],
      ['Right', 'setup-right'],
    ] as const)
      await expect(
        inputsOf(s, planId, name).map(toolpathOf).map(render).join('\n'),
      ).toMatchFileSnapshot(`__golden__/${file}.txt`)
    const setupId = setupOf(s.plan(planId), 'Bottom').id
    await s.run('plan.setup.update', { planId, setupId, rotation: 90 })
    await expect(
      inputsOf(s, planId, 'Bottom').map(toolpathOf).map(render).join('\n'),
    ).toMatchFileSnapshot('__golden__/setup-bottom-rot90.txt')
  })

  it('golden: gCode of a bottom-only and a side-only plan (one setup each)', async () => {
    for (const [opts, file, rotation] of [
      [{ side: false }, 'setup-bottom', 0],
      [{ bottom: false }, 'setup-right-rot90', 90],
    ] as const) {
      const s = await planSetup({ part: false })
      await bottomAndSide(s, opts)
      const planId = await s.create({ machineLibraryItemId: s.machineId })
      const p = s.plan(planId)
      expect(p.setups).toHaveLength(1)
      if (rotation !== 0)
        await s.run('plan.setup.update', { planId, setupId: p.setups[0]!.id, rotation })
      const e = expectOk(
        await exportPlan(s.d.doc, planId, {
          workers: createInProcessWorkers(),
          toolpaths: createToolpathCache(),
        }),
      )
      await expect(e.text).toMatchFileSnapshot(`__golden__/${file}.nc`)
    }
  })
})

// Spec: docs/modes/plan-v0.2.md (Implementation (task E2)).
describe('export per setup (E2)', () => {
  const services = () => ({ workers: createInProcessWorkers(), toolpaths: createToolpathCache() })

  it('setupOrientation: the stock extents on machine X, Y, Z and the part faces seen', () => {
    // top, unrotated: as designed (v0.1)
    expect(setupOrientation('+z', 0, STOCK)).toEqual({
      size: [100, 60, 20],
      up: '+z',
      front: '-y',
      right: '+x',
    })
    // flipped about the part's x axis: the bottom up, the back in front
    expect(setupOrientation('-z', 0, STOCK)).toEqual({
      size: [100, 60, 20],
      up: '-z',
      front: '+y',
      right: '+x',
    })
    // the right side up, turned a quarter: the extents swap on X and Y
    const right = setupOrientation('+x', 90, STOCK)
    expect(right.up).toBe('+x')
    expect(right.size).toEqual([20, 60, 100])
    for (const d of DIRECTIONS)
      for (const r of ROTATIONS) {
        const o = setupOrientation(d, r, STOCK)
        expect(o.up).toBe(d)
        // three perpendicular faces
        expect(new Set([o.up, o.front, o.right].map((x) => x.slice(1))).size).toBe(3)
        // the far top corner on the machine (X, Y at the extents) lies on the stock face
        const frame = setupFrame(d, r, STOCK)
        const far = applyPlacement(frame, [o.size[0], o.size[1], 0])
        const near = applyPlacement(frame, [0, 0, 0])
        const span = far.map((c, i) => Math.abs(c - near[i]!)).sort((a, b) => a - b)
        const face = [o.size[0], o.size[1]].sort((a, b) => a - b)
        expect(span[0]).toBeCloseTo(0, 9)
        expect(span[1]).toBeCloseTo(face[0]!, 9)
        expect(span[2]).toBeCloseTo(face[1]!, 9)
      }
  })

  it('a plan with several setups needs setupId; each setup exports its own program', async () => {
    const { s, planId } = await multiPlan()
    const p = s.plan(planId)
    expect(p.setups.map((x) => x.name)).toEqual(['Bottom', 'Right', 'Top'])
    const missing = expectErrCode(await exportPlan(s.d.doc, planId, services()), 'plan.setup')
    expect(missing.issues[0]).toMatchObject({ path: ['setupId'], rule: 'setupRequired' })
    const unknown = expectErrCode(
      await exportPlan(s.d.doc, planId, services(), { setupId: 'nope' }),
      'input.malformed',
    )
    expect(unknown.issues[0]?.rule).toBe('unknownSetup')
    const names = new Map(s.part().operations.map((o) => [o.id, o.name]))
    for (const setup of p.setups) {
      const e = expectOk(await exportPlan(s.d.doc, planId, services(), { setupId: setup.id }))
      expect(e.setupId).toBe(setup.id)
      expect(e.lines).toContain(`(Setup: ${setup.name})`)
      // the program machines exactly this setup's operations, in order
      const labels = e.program.blocks.flatMap((b) => (b.kind === 'comment' ? [b.text] : []))
      const own = setup.operations.map((o) =>
        o.designOperationIds.map((d) => names.get(d)).join(', '),
      )
      expect(labels.filter((l) => own.includes(l))).toEqual(own)
      expect(e.regenerated).toEqual(setup.operations.map((o) => o.id))
    }
  })

  it("only the exported setup's findings block its program", async () => {
    const s = await planSetup()
    await bottomAndSide(s)
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const p = s.plan(planId)
    const top = setupOf(p, 'Top')
    // the top drillings without data (the 6 mm drill has none): the top program fails
    const drillings = new Set(
      s
        .part()
        .operations.filter((o) => o.kind === 'drilling')
        .map((o) => o.id),
    )
    for (const op of p.setups.filter((x) => x !== top).flatMap((x) => x.operations))
      if (op.designOperationIds.some((d) => drillings.has(d)))
        await s.run('plan.operation.update', {
          planId,
          planOperationId: op.id,
          overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
        })
    expectErrCode(await exportPlan(s.d.doc, planId, services(), { setupId: top.id }), 'plan.check')
    for (const name of ['Bottom', 'Right'])
      expectOk(await exportPlan(s.d.doc, planId, services(), { setupId: setupOf(p, name).id }))
  })

  it('a single-setup plan exports without setupId, as before', async () => {
    const s = await planSetup({ part: false })
    await bottomAndSide(s, { side: false })
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const only = s.plan(planId).setups[0]!.id
    const a = expectOk(await exportPlan(s.d.doc, planId, services()))
    const b = expectOk(await exportPlan(s.d.doc, planId, services(), { setupId: only }))
    expect(a.setupId).toBe(only)
    expect(b.text).toBe(a.text)
  })
})
