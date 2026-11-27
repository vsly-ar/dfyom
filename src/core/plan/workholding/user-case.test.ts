// The user's case (workholding.md § Testing): two toe clamps 28 × 28 × 12 mm on the X ends of a
// 250 × 100 × 40 hardwood stock; a facing, a pocket and an outside profile. The exported program
// is checked by an independent G-code oracle (true arcs), never only by the check itself.
// Spec: docs/modes/workholding.md
import { describe, expect, it } from 'vitest'
import { Ok } from '../../../shared/result'
import { expectErrCode, expectOk } from '../../../shared/testing/result'
import { createInProcessWorkers } from '../../commands/jobs'
import { uiSource } from '../../commands/testing'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { exportPlan, withoutAppVersion } from '../../post/plan-export'
import { createToolpathCache } from '../../toolpath/cache'
import type { PlanWarning } from '../checks'
import { len, libraryInput } from '../../library/library.fixture'
import { flat6, planSetup, type PlanSetup } from '../plan.fixture'
import { gcodeClearance } from './gcode-oracle.testing'

const region2d = nodeRegion2d()

const STOCK = {
  name: 'Hardwood',
  shape: 'block',
  length: '250',
  width: '100',
  thickness: '40',
  material: { name: 'Oak', class: 'hardwood' },
}

/** Two toe clamps on the X ends: pads 28 × 28 (10 on the stock, 18 beyond), 12 mm tall. */
const USER_CLAMPS = [
  { kind: 'toeClamp', edge: 'uMin', at: '50', width: '28', grip: '10', reach: '18', top: '12' },
  { kind: 'toeClamp', edge: 'uMax', at: '50', width: '28', grip: '10', reach: '18', top: '12' },
]

/** The clamps' pads as the oracle sees them (machine frame of the setup, mm). */
const ORACLE_BOXES = [
  { x: [-18, 10], y: [36, 64], top: 12 },
  { x: [240, 268], y: [36, 64], top: 12 },
] as const

async function userCase(
  opts: { outline?: string; toolpaths?: boolean } = {},
): Promise<{ s: PlanSetup; planId: string; setupId: string }> {
  const s = await planSetup({
    part: false,
    stock: STOCK,
    services: opts.toolpaths === true ? services() : { region2d },
  })
  const partId = s.partId
  await s.run('design.facing.add', { partId, depth: '0.5' })
  await s.run('design.pocket.add', {
    partId,
    on: 'facing1.floor',
    shape: {
      kind: 'rectangle',
      center: ['125', '50'],
      length: '150',
      width: '50',
      cornerRadius: '6',
    },
    depth: '10',
    floorRadius: '0',
  })
  await s.run('design.profile.add', {
    partId,
    shape: {
      kind: 'rectangle',
      center: ['125', '50'],
      length: opts.outline ?? '200',
      width: '80',
      cornerRadius: '5',
    },
    tabs: { count: '4', width: '8', thickness: '3' },
  })
  await s.run('project.apply', {})
  // a 6 mm flat long enough to cut through 40 mm
  const long6 = (
    (await s.run('library.tool.add', {
      values: libraryInput({
        ...flat6(),
        name: 'Long flat 6',
        fluteLength: len('45'),
        overallLength: len('80'),
      }),
    })) as { id: string }
  ).id
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  for (const op of s.plan(planId).setups[0]!.operations)
    await s.run('plan.tool.assign', { planId, planOperationId: op.id, toolLibraryItemId: long6 })
  return { s, planId, setupId: s.plan(planId).setups[0]!.id }
}

const findings = (s: PlanSetup, planId: string) =>
  (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings.filter((w) =>
    w.code.startsWith('plan.workholding'),
  )

const services = () => ({
  workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  toolpaths: createToolpathCache(),
  region2d,
})

interface SetResult {
  items: {
    id: string
    name: string
    kind: string
    summary: string
    bounds: number[][]
    top: number
  }[]
  clearanceHeight: string
  findings: PlanWarning[]
}

describe("the user's case: 2 toe clamps 28 × 28 × 12 on a 250 × 100 × 40 hardwood stock", () => {
  it('without items: one info finding', async () => {
    const { s, planId } = await userCase()
    expect(findings(s, planId).map((f) => [f.code, f.severity])).toEqual([
      ['plan.workholding.none', 'info'],
    ])
  })

  it('keeps out of the clamps, raises the clearance, and every exported move clears them (oracle)', async () => {
    const { s, planId, setupId } = await userCase()
    const r = (await s.run('plan.workholding.set', {
      planId,
      setupId,
      items: USER_CLAMPS,
    })) as SetResult
    expect(r.items.map((i) => [i.id, i.name, i.summary])).toEqual([
      ['wh1', 'Toe clamp 1', 'left Y50 grip 10 top Z12'],
      ['wh2', 'Toe clamp 2', 'right Y50 grip 10 top Z12'],
    ])
    expect(r.items[0]!.bounds).toEqual([
      [-18, 36],
      [10, 64],
    ])
    expect(r.items[0]!.top).toBe(12)
    expect(r.clearanceHeight).toBe('14 mm')
    // what plan.warning.list says of the setup: the facing's uncut material under the clamps
    // (design review R13: one finding per operation, naming both clamps), and the machine's
    // missing holder (DF132 Q181: info, only in a setup with items)
    expect(r.findings.map((f) => f.code)).toEqual([
      'plan.holder.unknown',
      'plan.workholding.unmachined',
    ])
    const sv = services()
    const e = expectOk(await exportPlan(s.d.doc, planId, sv))
    const text = withoutAppVersion(e.text)
    expect(text).toContain('(Workholding: Toe clamp 1: left Y50 grip 10 top Z12)')
    expect(text).toContain('(Workholding: Toe clamp 2: right Y50 grip 10 top Z12)')
    expect(text).toContain('(Every move checked: 2 mm clear of the workholding)')
    expect(text).not.toContain('Keep clamps')
    // the program's clearance follows the clamps: 12 + 2 mm
    expect(text).toMatch(/^G0 Z14$/m)
    // the independent oracle: every executed move ≥ the margin from both clamps
    expect(gcodeClearance(text, ORACLE_BOXES, 3)).toBeGreaterThanOrEqual(2 - 0.011)
    // the facing leaves the material under the clamps uncut and says so
    const after = findings(s, planId)
    const uncut = after.filter((f) => f.code === 'plan.workholding.unmachined')
    expect(uncut.map((f) => f.params['itemIds'])).toEqual(['wh1,wh2'])
    expect(uncut[0]!.params['itemId']).toBeUndefined()
    expect(uncut[0]!.message).toMatch(
      /^Facing 1 \(planOp-\d+\) leaves [\d.]+ mm² uncut under Toe clamp 1 \([\d.]+ mm², X-?[\d.]+–[\d.]+ Y[\d.]+–[\d.]+\) and Toe clamp 2 \(/,
    )
    const [a, b] = [uncut[0]!.params['area'], uncut[0]!.params['xMin']]
    expect(typeof a === 'number' && a > 0).toBe(true)
    expect(b).toBeCloseTo(-1, 3)
    expect(after.filter((f) => f.severity === 'error')).toEqual([])
  })

  // DF81 (docs/modes/alignment.md S12): the header's item positions are in the WCS, as on the DRO
  it('one clamp: the uncut finding names it with its bounds and keeps itemId (R13)', async () => {
    const { s, planId, setupId } = await userCase()
    await s.run('plan.workholding.set', { planId, setupId, items: [USER_CLAMPS[0]] })
    const uncut = findings(s, planId).filter((f) => f.code === 'plan.workholding.unmachined')
    expect(uncut).toHaveLength(1)
    expect(uncut[0]!.params).toMatchObject({ itemId: 'wh1', itemIds: 'wh1' })
    expect(uncut[0]!.message).toMatch(
      /^Facing 1 \(planOp-\d+\) leaves [\d.]+ mm² uncut under Toe clamp 1 \(X-?[\d.]+–[\d.]+ Y[\d.]+–[\d.]+\)$/,
    )
  })

  it('with a moved work zero the header names the items in the WCS, the set result in the setup frame', async () => {
    const { s, planId, setupId } = await userCase()
    const items = [
      ...USER_CLAMPS,
      { kind: 'screw', center: ['125', '-20'], headDiameter: '8', top: '0' },
    ]
    await s.run('plan.workholding.set', { planId, setupId, items })
    const header = async () =>
      withoutAppVersion(expectOk(await exportPlan(s.d.doc, planId, services())).text)
        .split('\n')
        .filter((l) => l.startsWith('(Workholding: '))
    expect(await header()).toEqual([
      '(Workholding: Toe clamp 1: left Y50 grip 10 top Z12)',
      '(Workholding: Toe clamp 2: right Y50 grip 10 top Z12)',
      '(Workholding: Screw 1: X125 Y-20 head 8 top Z0)',
    ])
    await s.run('plan.setup.update', { planId, setupId, zero: { at: ['40', '25'] } })
    // every position shifts by the zero (X −40, Y −25); sizes and heights do not
    expect(await header()).toEqual([
      '(Workholding: Toe clamp 1: left Y25 grip 10 top Z12)',
      '(Workholding: Toe clamp 2: right Y25 grip 10 top Z12)',
      '(Workholding: Screw 1: X85 Y-45 head 8 top Z0)',
    ])
    // the set result echoes the items as entered: the setup frame, beside the fields
    const r = (await s.run('plan.workholding.set', { planId, setupId, items })) as SetResult
    expect(r.items.map((i) => i.summary)).toEqual([
      'left Y50 grip 10 top Z12',
      'right Y50 grip 10 top Z12',
      'X125 Y-20 head 8 top Z0',
    ])
  })

  it('a profile through a clamp is a cut collision that blocks the export', async () => {
    const { s, planId, setupId } = await userCase({ outline: '236' })
    await s.run('plan.workholding.set', { planId, setupId, items: USER_CLAMPS })
    const err = expectErrCode(await exportPlan(s.d.doc, planId, services()), 'plan.check')
    expect(err.message).toMatch(/Profile 1: a cut at Z-?[0-9.]+ hits Toe clamp 1/)
    expect(err.issues[0]!.rule).toBe('plan.workholding.collision')
  })

  // DF90 B-4: plan.get gives the clearance the program uses beside the stored setting
  it('plan.get: the effective clearance and its reason beside the stored setting', async () => {
    const { s, planId, setupId } = await userCase()
    const effective = () =>
      (s.query('plan.get', { planId }) as { effectiveClearance: unknown[] }).effectiveClearance
    expect(effective()).toEqual([{ setupId, clearanceHeight: 10, reason: 'default' }])
    await s.run('plan.workholding.set', { planId, setupId, items: USER_CLAMPS })
    expect(effective()).toEqual([
      { setupId, clearanceHeight: 14, reason: 'workholding', item: 'Toe clamp 1', margin: 2 },
    ])
    // the setting stays as stored (it applies again without the items)
    expect(s.plan(planId).setups[0]!.clearanceHeight.source).toBe('10 mm')
    await s.run('plan.setup.update', { planId, setupId, clearanceHeight: '20' })
    expect(effective()).toEqual([{ setupId, clearanceHeight: 20, reason: 'set' }])
  })

  // DF90 B-5: the set result reads as "OK" only when the moves were checked
  it('plan.workholding.set returns the collision of current toolpaths and names the unchecked', async () => {
    const { s, planId, setupId } = await userCase({ outline: '236', toolpaths: true })
    const set = async () =>
      (await s.run('plan.workholding.set', {
        planId,
        setupId,
        items: USER_CLAMPS,
      })) as SetResult & { movesUnchecked: string[] }
    // no toolpaths yet: nothing checked, every operation named
    const cold = await set()
    expect(cold.findings.filter((f) => f.code === 'plan.workholding.collision')).toEqual([])
    expect(cold.movesUnchecked).toEqual(['Facing 1', 'Pocket 1', 'Profile 1'])
    await s.run('plan.workholding.set', { planId, setupId, items: [] })
    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, uiSource()))
      .value as { jobId: string }
    expectOk(await s.d.job(jobId).unwrap().result)
    // the profile's toolpath does not depend on the clamps: checked at once, as the export does
    const warm = await set()
    expect(warm.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'plan.workholding.collision',
          message: expect.stringMatching(/Profile 1: a cut at Z-?[0-9.]+ hits Toe clamp 1/),
        }),
      ]),
    )
    // the facing and pocket keep out of the new clamps: they regenerate
    expect(warm.movesUnchecked).toEqual(['Facing 1', 'Pocket 1'])
  })

  // DF78 S12 (docs/modes/alignment.md#frames): what the operator reads on the machine
  it('with a moved work zero the collision is reported in the WCS, in the list and the export', async () => {
    const { s, planId, setupId } = await userCase({ outline: '236', toolpaths: true })
    await s.run('plan.workholding.set', { planId, setupId, items: USER_CLAMPS })
    const hit = async () => {
      const { jobId } = expectOk(
        await s.d.dispatch('plan.toolpath.generate', { planId }, uiSource()),
      ).value as { jobId: string }
      expectOk(await s.d.job(jobId).unwrap().result)
      const listed = findings(s, planId).filter((f) => f.code === 'plan.workholding.collision')
      const err = expectErrCode(await exportPlan(s.d.doc, planId, services()), 'plan.check')
      return { listed, exported: err.issues }
    }
    const xy = (p: unknown) => {
      const q = p as Record<string, number>
      return [Math.round(q['x']! * 1000) / 1000, Math.round(q['y']! * 1000) / 1000] as const
    }
    const points = (ps: readonly unknown[], dx = 0, dy = 0) =>
      ps
        .map(xy)
        .map(([x, y]) => `${Math.round((x + dx) * 100) / 100},${Math.round((y + dy) * 100) / 100}`)
        .sort()
    const corner = await hit()
    expect(corner.listed.length).toBeGreaterThan(0)
    await s.run('plan.setup.update', { planId, setupId, zero: { at: ['40', '25'] } })
    const moved = await hit()
    // the same hits (the facing's keep-out stays round the clamps: footprints are in the setup
    // frame, not shifted by the zero), each 40, 25 mm over: the setup-frame point less the zero
    expect(
      points(
        moved.listed.map((f) => f.params),
        40,
        25,
      ),
    ).toEqual(points(corner.listed.map((f) => f.params)))
    expect(
      points(
        moved.exported.map((i) => i.params),
        40,
        25,
      ),
    ).toEqual(points(corner.exported.map((i) => i.params)))
    // the message says the WCS point too; the left clamp is left of the moved zero
    const m = (f: PlanWarning) => {
      const [x, y] = xy(f.params)
      return `near X${Math.round(x * 100) / 100} Y${Math.round(y * 100) / 100}`
    }
    for (const f of moved.listed) expect(f.message).toContain(m(f))
    expect(Math.min(...moved.listed.map((f) => xy(f.params)[0]))).toBeLessThan(0)
  })

  it('a clearance height the user set below the clamps is an error until set back to auto', async () => {
    const { s, planId, setupId } = await userCase()
    await s.run('plan.workholding.set', { planId, setupId, items: USER_CLAMPS })
    await s.run('plan.setup.update', { planId, setupId, clearanceHeight: '10' })
    expect(findings(s, planId).map((f) => f.code)).toContain('plan.workholding.clearanceLow')
    expectErrCode(await exportPlan(s.d.doc, planId, services()), 'plan.check')
    await s.run('plan.setup.update', { planId, setupId, clearanceHeight: 'auto' })
    expect(findings(s, planId).map((f) => f.code)).not.toContain('plan.workholding.clearanceLow')
  })
})

// v0.4-llm-first W6 (workholding.md § Automatic arrangement): four toe clamps placed for the case
describe("auto: 'toeClamps' on the user's case", () => {
  const generate = async (s: PlanSetup, planId: string) => {
    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, uiSource()))
      .value as { jobId: string }
    expectOk(await s.d.job(jobId).unwrap().result)
  }
  const auto = async (s: PlanSetup, planId: string, setupId: string) =>
    (await s.run('plan.workholding.set', { planId, setupId, auto: 'toeClamps' })) as SetResult

  it('needs toolpaths; then four clamps on the short edges in the waste, and the export clears them (oracle)', async () => {
    const { s, planId, setupId } = await userCase({ toolpaths: true })
    const cold = await s.failWith(
      'plan.workholding.set',
      { planId, setupId, auto: 'toeClamps' },
      'plan.workholding',
    )
    expect(cold.issues[0]!.rule).toBe('noToolpaths')
    expect(cold.message).toContain('Generate the toolpaths of Top first')
    await generate(s, planId)
    // the long edges have 10 mm of waste beside the outline: too little for a 10 mm grip + margin
    const r = await auto(s, planId, setupId)
    expect(r.items.map((i) => [i.id, i.name, i.summary])).toEqual([
      ['wh1', 'Toe clamp 1', 'left Y25 grip 10 top Z25'],
      ['wh2', 'Toe clamp 2', 'left Y75 grip 10 top Z25'],
      ['wh3', 'Toe clamp 3', 'right Y25 grip 10 top Z25'],
      ['wh4', 'Toe clamp 4', 'right Y75 grip 10 top Z25'],
    ])
    expect(r.clearanceHeight).toBe('27 mm')
    expect(r.findings.filter((f) => f.severity === 'error')).toEqual([])
    await generate(s, planId)
    expect(findings(s, planId).filter((f) => f.severity === 'error')).toEqual([])
    // design review R13: the facing's material under the four clamps is one grouped finding
    const uncut = findings(s, planId).filter((f) => f.code === 'plan.workholding.unmachined')
    expect(uncut.map((f) => f.params['itemIds'])).toEqual(['wh1,wh2,wh3,wh4'])
    expect(uncut[0]!.message).toMatch(
      /uncut under Toe clamp 1 \(.*\), Toe clamp 2 \(.*\), Toe clamp 3 \(.*\) and Toe clamp 4 \(/,
    )
    const text = withoutAppVersion(expectOk(await exportPlan(s.d.doc, planId, services())).text)
    const boxes = r.items.map((i) => ({
      x: [i.bounds[0]![0]!, i.bounds[1]![0]!] as const,
      y: [i.bounds[0]![1]!, i.bounds[1]![1]!] as const,
      top: i.top,
    }))
    expect(gcodeClearance(text, boxes, 3)).toBeGreaterThanOrEqual(2 - 0.011)
    // again: the toe clamps are replaced (new ids), the other items stay
    await s.run('plan.workholding.set', {
      planId,
      setupId,
      items: [...r.items.map((i) => ({ id: i.id, kind: 'toeClamp' })), { kind: 'surface' }],
    })
    const again = await auto(s, planId, setupId)
    expect(again.items.map((i) => [i.id, i.kind])).toEqual([
      ['wh5', 'surface'],
      ['wh6', 'toeClamp'],
      ['wh7', 'toeClamp'],
      ['wh8', 'toeClamp'],
      ['wh9', 'toeClamp'],
    ])
  })

  it('a turned setup: the same clamps on its front and back (the setup frame)', async () => {
    const { s, planId, setupId } = await userCase({ toolpaths: true })
    await s.run('plan.setup.update', { planId, setupId, rotation: 90 })
    await generate(s, planId)
    const r = await auto(s, planId, setupId)
    expect(r.items.map((i) => i.summary)).toEqual([
      'front X25 grip 10 top Z25',
      'front X75 grip 10 top Z25',
      'back X25 grip 10 top Z25',
      'back X75 grip 10 top Z25',
    ])
    await generate(s, planId)
    expect(findings(s, planId).filter((f) => f.severity === 'error')).toEqual([])
    expectOk(await exportPlan(s.d.doc, planId, services()))
  })

  it('no room: refused with every edge named, nothing changed; a vise and both items and auto are refused', async () => {
    const { s, planId, setupId } = await userCase({ outline: '236', toolpaths: true })
    await generate(s, planId)
    const e = await s.failWith(
      'plan.workholding.set',
      { planId, setupId, auto: 'toeClamps' },
      'plan.workholding',
    )
    expect(e.message).toMatch(
      /^Four toe clamps do not fit in Top clear of the toolpaths and in the waste/,
    )
    expect(e.issues.map((i) => [i.rule, i.message.split(' ')[0]])).toEqual([
      ['noRoom', 'front'],
      ['noRoom', 'back'],
      ['noRoom', 'left'],
      ['noRoom', 'right'],
    ])
    expect(s.plan(planId).setups[0]!.workholding).toBeUndefined()
    await s.run('plan.workholding.set', { planId, setupId, items: [{ kind: 'vise' }] })
    const v = await s.failWith(
      'plan.workholding.set',
      { planId, setupId, auto: 'toeClamps' },
      'plan.workholding',
    )
    expect(v.issues[0]!.rule).toBe('vise')
    const x = await s.failWith(
      'plan.workholding.set',
      { planId, setupId, items: [], auto: 'toeClamps' },
      'input.malformed',
    )
    expect(x.issues[0]).toMatchObject({ path: ['auto'], rule: 'exclusive' })
  })
})
