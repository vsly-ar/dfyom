// Safe links in the plan (hardening DF64, L2): plan.setup.update { retraction, clampHeight }, the
// links summary and findings of plan.warning.list, DF59's clamp warning and the export with
// minimum retraction. Doc: docs/modes/safe-links.md#agent-api-and-settings
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { exportPlan, withoutAppVersion } from '../post/plan-export'
import { createToolpathCache } from '../toolpath/cache'
import type { PlanWarning } from './checks'
import { expectUndoRedo, planSetup, type PlanSetup } from './plan.fixture'

const region2d = nodeRegion2d()
const ui = uiSource()

const circle = (x: string, y: string) => ({ kind: 'circle', center: [x, y], diameter: '16' })

/** A faced 100 × 60 × 20 block with two pockets on its floor, all with the 6 mm flat: one tool run. */
async function onePlan(): Promise<{ s: PlanSetup; planId: string; setupId: string }> {
  const toolpaths = createToolpathCache()
  const s = await planSetup({
    part: false,
    services: {
      region2d,
      toolpaths,
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    },
  })
  const partId = s.partId
  await s.run('design.facing.add', { partId, depth: '0.5' })
  for (const x of ['25', '75'])
    await s.run('design.pocket.add', {
      partId,
      on: 'facing1.floor',
      shape: circle(x, '30'),
      depth: '3',
      floorRadius: '0',
    })
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  for (const o of s.plan(planId).setups[0]!.operations)
    await s.run('plan.tool.assign', {
      planId,
      planOperationId: o.id,
      toolLibraryItemId: s.tools.flat6,
    })
  const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
    .value as { jobId: string }
  expectOk(await s.d.job(jobId).unwrap().result)
  return { s, planId, setupId: s.plan(planId).setups[0]!.id }
}

interface LinksRow {
  setupId: string
  links: {
    count: number
    low: number
    atClearance: number
    seconds: number | null
    savedSeconds: number | null
  } | null
}
const list = (s: PlanSetup, planId: string) =>
  s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[]; links: LinksRow[] }

async function exported(s: PlanSetup, planId: string, resumeFrom?: string) {
  return expectOk(
    await exportPlan(
      s.d.doc,
      planId,
      {
        workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
        toolpaths: createToolpathCache(),
        region2d,
      },
      resumeFrom === undefined ? {} : { resumeFrom },
    ),
  )
}

describe('plan.setup.update retraction / clampHeight', () => {
  it('stores minimum as absent, the clamp height as a length, null clears it', async () => {
    const { s, planId, setupId } = await onePlan()
    const setup = () => s.plan(planId).setups[0]!
    expect(setup()).not.toHaveProperty('retraction')
    await expectUndoRedo(s, 'plan.setup.update', { planId, setupId, retraction: 'full' })
    expect(setup().retraction).toBe('full')
    await s.run('plan.setup.update', { planId, setupId, retraction: 'minimum' })
    expect(setup()).not.toHaveProperty('retraction')
    await expectUndoRedo(s, 'plan.setup.update', { planId, setupId, clampHeight: '12' })
    expect(setup().clampHeight).toMatchObject({ kind: 'length', source: '12' })
    await s.run('plan.setup.update', { planId, setupId, clampHeight: null })
    expect(setup()).not.toHaveProperty('clampHeight')
    await s.failWith('plan.setup.update', { planId, setupId, clampHeight: '-1' }, 'model.invariant')
    await s.failWith(
      'plan.setup.update',
      { planId, setupId, retraction: 'some' },
      'input.malformed',
    )
  })
})

describe('plan.warning.list links', () => {
  it('summarises the links per setup and asks for the clamp height when it would help', async () => {
    const { s, planId, setupId } = await onePlan()
    const before = list(s, planId)
    expect(before.links).toHaveLength(1)
    const row = before.links[0]!
    expect(row.setupId).toBe(setupId)
    expect(row.links).toMatchObject({ count: 2 })
    expect(row.links!.low).toBeGreaterThanOrEqual(1)
    expect(row.links!.savedSeconds).toBeGreaterThan(0)
    // the facing ends past the stock edge: that link needs the clamp height
    const info = before.warnings.filter((w) => w.code === 'plan.links.clampHeightUnknown')
    expect(info).toHaveLength(1)
    expect(info[0]).toMatchObject({ severity: 'info', field: 'setup.clampHeight' })
    expect(info[0]!.params).toMatchObject({ setupId, links: 1 })

    await s.run('plan.setup.update', { planId, setupId, clampHeight: '0' })
    const known = list(s, planId)
    expect(known.links[0]!.links!.low).toBe(2)
    expect(known.warnings.some((w) => w.code === 'plan.links.clampHeightUnknown')).toBe(false)

    await s.run('plan.setup.update', { planId, setupId, retraction: 'full' })
    const full = list(s, planId)
    expect(full.links[0]!.links).toMatchObject({
      count: 2,
      low: 0,
      atClearance: 2,
      savedSeconds: 0,
    })
  })

  it("DF59: warns when the clearance height doesn't clear the clamps by the retract height", async () => {
    const { s, planId, setupId } = await onePlan()
    const clamp = () => list(s, planId).warnings.filter((w) => w.rule === 'clampsAboveClearance')
    expect(clamp()).toEqual([])
    await s.run('plan.setup.update', { planId, setupId, clampHeight: '8.5' })
    expect(clamp()).toHaveLength(1)
    expect(clamp()[0]).toMatchObject({ severity: 'warning', field: 'setup.clearanceHeight' })
    expect(clamp()[0]!.params).toMatchObject({ clampHeight: 8.5, needed: 10.5 })
    await s.run('plan.setup.update', { planId, setupId, clampHeight: '8' })
    expect(clamp()).toEqual([])
  })

  // workholding.md#links-and-safe-heights: modelled items supersede the clamp height
  it('with workholding items the links follow them and the clamp height is ignored', async () => {
    const { s, planId, setupId } = await onePlan()
    const low = () => list(s, planId).links.find((l) => l.setupId === setupId)!.links?.low
    await s.run('plan.setup.update', { planId, setupId, clampHeight: '12' })
    const rules = () => list(s, planId).warnings.map((w) => w.rule)
    expect(rules()).toContain('clampsAboveClearance')
    // the link over the uncut stock waits for clamps below the clearance height
    const before = low()!
    await s.run('plan.workholding.set', {
      planId,
      setupId,
      items: [{ kind: 'screw', center: ['95', '55'] }],
    })
    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
      .value as { jobId: string }
    expectOk(await s.d.job(jobId).unwrap().result)
    expect(rules()).not.toContain('clampsAboveClearance')
    expect(rules()).not.toContain('clampHeightUnknown')
    expect(low()).toBeGreaterThan(before)
    const out = await exported(s, planId)
    expect(out.lowLinks).toBeGreaterThan(0)
    expect(out.text).toContain('Every move checked')
    expect(out.text).not.toContain('Keep clamps below')
  })

  // alignment.md S12: the toolpaths are in the WCS, the stock field and the items in the setup frame
  it('a moved work zero keeps the field and the workholding items in the toolpaths frame', async () => {
    const { s, planId, setupId } = await onePlan()
    // a tall block off the stock's left side: clear of the pockets' link in the setup frame, but
    // under it if the link (shifted −40, −25 into the WCS) were read without the zero added back
    await s.run('plan.workholding.set', {
      planId,
      setupId,
      items: [{ kind: 'block', center: ['-18', '5'], length: '4', width: '4', top: '8' }],
    })
    const generate = async () => {
      const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
        .value as { jobId: string }
      expectOk(await s.d.job(jobId).unwrap().result)
    }
    await generate()
    const levels = (t: string) =>
      t
        .split('\n')
        .filter((l) => /^G0 Z-?[\d.]+$/.test(l))
        .map((l) => Number(l.slice(4)))
    const corner = await exported(s, planId)
    expect(corner.lowLinks).toBeGreaterThan(0)
    await s.run('plan.setup.update', { planId, setupId, zero: { at: ['40', '25'] } })
    await generate()
    const moved = await exported(s, planId)
    // the same links: the same levels and number of low links, the moves 40, 25 mm over
    expect(moved.lowLinks).toBe(corner.lowLinks)
    expect(levels(moved.text)).toEqual(levels(corner.text))
    // the moves are in the WCS: left of the moved zero
    expect(moved.text).toMatch(/ X-\d/)
  })
})

describe('export with minimum retraction', () => {
  it('lowers the links, writes the clamp line and adds the air-pass note; full is unchanged', async () => {
    const { s, planId, setupId } = await onePlan()
    await s.run('plan.setup.update', { planId, setupId, retraction: 'full' })
    const full = await exported(s, planId)
    expect(full.lowLinks).toBe(0)
    expect(full.text).not.toMatch(/Keep clamps below/)
    await s.run('plan.setup.update', { planId, setupId, retraction: 'minimum', clampHeight: '0' })
    const min = await exported(s, planId)
    expect(min.lowLinks).toBe(2)
    expect(min.text).toMatch(/Keep clamps below Z 0 mm: links pass 2 mm above them/)
    expect(min.text.split('\n').length).toBeLessThan(full.text.split('\n').length)
    // the cut lines are the same
    const cuts = (t: string) => t.split('\n').filter((l) => /^G1|^G2|^G3/.test(l))
    expect(cuts(withoutAppVersion(min.text))).toEqual(cuts(withoutAppVersion(full.text)))
  })

  it('a section resume starts its operation as generated, from the clearance height (M5)', async () => {
    const { s, planId, setupId } = await onePlan()
    await s.run('plan.setup.update', { planId, setupId, clampHeight: '0' })
    const second = s.plan(planId).setups[0]!.operations[2]!.id
    const resumed = await exported(s, planId, second)
    // one link left (none: the resumed operation is the last), nothing lowered
    expect(resumed.lowLinks).toBe(0)
    await s.run('plan.setup.update', { planId, setupId, retraction: 'full' })
    const full = await exported(s, planId, second)
    // the same program but for the header's clamp line
    const body = (t: string) => t.slice(t.indexOf('G90'))
    expect(body(resumed.text)).toBe(body(full.text))
  })
})
