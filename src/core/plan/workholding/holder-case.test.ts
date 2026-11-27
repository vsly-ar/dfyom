// The tool holder in the plan (hardening DF132 H2): a 25 mm toe clamp beside a pocket that the
// Ø6 tool clears but the ER11 nut hits. The exported program is checked by the independent G-code
// oracle with the stepped envelope, never only by the check itself.
// Spec: docs/modes/tool-holder.md (§ Checks, § Findings, § Testing)
import { describe, expect, it } from 'vitest'
import { Ok } from '../../../shared/result'
import { expectErrCode, expectOk } from '../../../shared/testing/result'
import { createInProcessWorkers } from '../../commands/jobs'
import { uiSource } from '../../commands/testing'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { len, libraryInput, machineValues } from '../../library/library.fixture'
import { exportPlan, withoutAppVersion } from '../../post/plan-export'
import { createToolpathCache } from '../../toolpath/cache'
import type { PlanWarning } from '../checks'
import { flat6, planSetup } from '../plan.fixture'
import { gcodeClearance } from './gcode-oracle.testing'

const region2d = nodeRegion2d()
const services = () => ({
  workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  toolpaths: createToolpathCache(),
  region2d,
})

const STOCK = {
  name: 'Hardwood',
  shape: 'block',
  length: '250',
  width: '100',
  thickness: '40',
  material: { name: 'Oak', class: 'hardwood' },
}

/** A 25 mm tall toe clamp on the left edge: pad X−18–10, Y36–64. */
const CLAMP = {
  kind: 'toeClamp',
  edge: 'uMin',
  at: '50',
  width: '28',
  grip: '10',
  reach: '18',
  top: '25',
}
const ORACLE_BOX = [{ x: [-18, 10], y: [36, 64], top: 25 }] as const

/**
 * A 6 mm deep pocket X16–54: its wall pass runs 9 mm from the clamp, so the Ø6 tool keeps 6 mm,
 * the Ø19 ER11 nut (25 mm stickout: the tool's flute length) none.
 */
async function holderCase(
  holder: object | undefined,
  opts: { toolpaths?: boolean; toolHolder?: object } = {},
) {
  const s = await planSetup({
    part: false,
    stock: STOCK,
    services: opts.toolpaths === true ? services() : { region2d },
  })
  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: {
      kind: 'rectangle',
      center: ['35', '50'],
      length: '38',
      width: '40',
      cornerRadius: '4',
    },
    depth: '6',
    floorRadius: '0',
  })
  await s.run('project.apply', {})
  const { kind: _, ...m } = machineValues()
  const machineId =
    holder === undefined
      ? s.machineId
      : (
          (await s.run('library.machine.add', {
            values: { ...libraryInput({ ...m, name: 'Shapeoko ER11' }), holder },
          })) as { id: string }
        ).id
  const planId = await s.create({ machineLibraryItemId: machineId })
  const setup = s.plan(planId).setups[0]!
  const op = setup.operations[0]!
  await s.run('plan.tool.assign', {
    planId,
    planOperationId: op.id,
    toolLibraryItemId:
      opts.toolHolder === undefined ? s.tools.flat6 : await ownHolderTool(s, opts.toolHolder),
  })
  await s.run('plan.workholding.set', { planId, setupId: setup.id, items: [CLAMP] })
  const warnings = () =>
    (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings
  return { s, planId, planOperationId: op.id, warnings }
}

/** DF132 H6: the Flat 6 as a library tool with its own holder (the override). */
async function ownHolderTool(
  s: { run: (name: string, args: object) => Promise<unknown> },
  holder: object,
): Promise<string> {
  const added = (await s.run('library.tool.add', {
    values: { ...libraryInput({ ...flat6(), name: 'Flat 6, own holder' }), holder },
  })) as { id: string }
  return added.id
}

/**
 * DF132 H6: a slim extension (Ø10 nut, 50 mm long) under the spindle's Ø52 body: 9 mm from the
 * clamp its nut keeps 4 mm, and the body is far above the clamp.
 */
const SLIM = { nutDiameter: '10', nutLength: '50', bodyDiameter: '52' }

describe('a clamp the Ø6 tool clears but the ER11 nut hits (DF132 H2)', () => {
  it('without a holder: exported as today, with the info that the nut is not checked', async () => {
    const { s, planId, warnings } = await holderCase(undefined)
    expect(warnings().filter((w) => w.code === 'plan.holder.unknown')).toEqual([
      expect.objectContaining({ severity: 'info', field: 'machine.holder' }),
    ])
    const text = withoutAppVersion(expectOk(await exportPlan(s.d.doc, planId, services())).text)
    // the tool alone clears the clamp by more than the margin
    expect(gcodeClearance(text, ORACLE_BOX, 3)).toBeGreaterThanOrEqual(2 - 0.011)
  })

  it('with an ER11: a holder collision blocks the export; a longer stickout exports and the oracle clears the nut', async () => {
    const { s, planId, planOperationId, warnings } = await holderCase({ preset: 'er11' })
    expect(warnings().map((w) => w.code)).not.toContain('plan.holder.unknown')
    const err = expectErrCode(await exportPlan(s.d.doc, planId, services()), 'plan.check')
    expect(err.message).toMatch(
      /^Pocket 1: the collet nut \(ER11, Ø19\) at Z[\d.]+ hits Toe clamp 1 near X[\d.]+ Y[\d.]+ \(tip Z-[\d.]+, Toe clamp 1 top Z25, margin 2 mm\): chuck the tool with at least 36 mm out or move the item$/,
    )
    expect(err.issues).toEqual([
      expect.objectContaining({
        rule: 'plan.workholding.collision',
        params: expect.objectContaining({
          kind: 'holder',
          part: 'nut',
          // the first hit (the first stepdown); the stickout for the deepest (25 + 6 + 5)
          neededStickout: 36,
        }),
      }),
    ])
    const hit = err.issues[0]!.params as Record<string, number>
    expect(hit['partZ']! - hit['lowestZ']!).toBe(25)
    // what the oracle says of the program the check refused: the tool clears, the nut does not
    await s.run('plan.operation.update', { planId, planOperationId, stickout: '36' })
    const text = withoutAppVersion(expectOk(await exportPlan(s.d.doc, planId, services())).text)
    const envelope = (stickout: number) => [
      { radius: 3, above: 0 },
      { radius: 9.5, above: stickout },
      { radius: 26, above: stickout + 12 },
    ]
    expect(gcodeClearance(text, ORACLE_BOX, 3)).toBeGreaterThanOrEqual(2 - 0.011)
    expect(gcodeClearance(text, ORACLE_BOX, envelope(25))).toBeLessThan(2)
    // with the stickout the finding names: the nut is above the clamp + margin on every move
    expect(gcodeClearance(text, ORACLE_BOX, envelope(36))).toBeGreaterThanOrEqual(2 - 0.011)
  })

  it('a shank over the collet capacity is a warning, never an error (Q183)', async () => {
    const { s, planId, planOperationId, warnings } = await holderCase({ preset: 'er11' })
    expect(warnings().map((w) => w.code)).not.toContain('plan.holder.shankTooLarge')
    const thick = (
      (await s.run('library.tool.add', {
        values: libraryInput({ ...flat6(), name: 'Flat 6, 8 shank', shankDiameter: len('8') }),
      })) as { id: string }
    ).id
    await s.run('plan.tool.assign', { planId, planOperationId, toolLibraryItemId: thick })
    expect(warnings().filter((w) => w.code === 'plan.holder.shankTooLarge')).toEqual([
      expect.objectContaining({
        severity: 'warning',
        planOperationId,
        field: 'tool',
        params: { shank: 8, maxShank: 7 },
        message: expect.stringContaining('larger than the ER11 collet takes (up to Ø7 mm)'),
      }),
    ])
  })
})

type Row = { id: string; stickoutNeeded: number | null; stickoutReason: unknown }

// DF132 H3: the clamp term in the minimum stickout (tool-holder.md#minimum-stickout-gains-the-clamp-term)
describe('the minimum stickout with the clamp under the ER11 nut (DF132 H3)', () => {
  const rowOf = (s: { query: (n: string, a: object) => unknown }, planId: string) =>
    (s.query('plan.operation.list', { planId }) as { operations: Row[] }).operations[0]!
  const generate = async (s: Awaited<ReturnType<typeof holderCase>>['s'], planId: string) => {
    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, uiSource()))
      .value as { jobId: string }
    expectOk(await s.d.job(jobId).unwrap().result)
  }

  it('without a holder: DF130 exactly (6 mm deep + 5), nothing to check', async () => {
    const { s, planId } = await holderCase(undefined, { toolpaths: true })
    await generate(s, planId)
    const row = rowOf(s, planId)
    expect(row.stickoutNeeded).toBe(11)
    expect(row.stickoutReason).toEqual({ kind: 'cut', planOperationId: row.id, clamps: 'none' })
    const text = withoutAppVersion(expectOk(await exportPlan(s.d.doc, planId, services())).text)
    expect(text).toContain('min stickout 11 mm')
    expect(text).not.toContain('(Holder:')
  })

  it('with an ER11: DF130 until the toolpath is current, then the clamp under the nut decides', async () => {
    const { s, planId, planOperationId, warnings } = await holderCase(
      { preset: 'er11' },
      { toolpaths: true },
    )
    expect(rowOf(s, planId)).toMatchObject({
      stickoutNeeded: 11,
      stickoutReason: { kind: 'cut', clamps: 'pending' },
    })
    await generate(s, planId)
    // clamp top 25 − the pocket floor −6 + 5 mm, beside the wall pass 9 mm from the clamp
    const row = rowOf(s, planId)
    expect(row.stickoutNeeded).toBeCloseTo(36, 6)
    expect(row.stickoutReason).toEqual({
      kind: 'workholding',
      planOperationId,
      clamps: 'checked',
      itemId: expect.any(String),
      itemName: 'Toe clamp 1',
      part: 'nut',
      x: expect.any(Number),
      y: expect.any(Number),
      // DF132 H5: the tip at the deciding move (the ghost stands there): the pocket's floor
      z: -6,
    })
    // the collision names the same number
    const hit = warnings().find((w) => w.code === 'plan.workholding.collision')!
    expect(hit.message).toContain('chuck the tool with at least 36 mm out')
    expect(hit.params['neededStickout']).toBeCloseTo(36, 6)
    // between the check's 2 mm margin and the read-out's 5 mm: the shortStickout warning names the clamp
    await s.run('plan.operation.update', { planId, planOperationId, stickout: '34' })
    await generate(s, planId)
    const short = warnings().filter((w) => w.rule === 'shortStickout')
    expect(short).toEqual([
      expect.objectContaining({
        code: 'plan.check',
        severity: 'warning',
        field: 'stickout',
        planOperationId,
        message: expect.stringContaining(
          'stickout 34 mm is shorter than the 36 mm Toe clamp 1 needs under the collet nut: the collet nut passes within 5 mm of its top; chuck the tool with at least 36 mm out',
        ),
        params: expect.objectContaining({ stickout: 34, needed: 36, part: 'nut' }),
      }),
    ])
    expect(warnings().map((w) => w.code)).not.toContain('plan.workholding.collision')
    // the program: the run's number in the header and marker, the holder line after the items
    await s.run('plan.operation.update', { planId, planOperationId, stickout: '36' })
    const text = withoutAppVersion(expectOk(await exportPlan(s.d.doc, planId, services())).text)
    expect(text).toContain('min stickout 36 mm')
    expect(text).toMatch(
      /\(Workholding: Toe clamp 1[^)]*\)\n\(Holder: ER11 nut dia 19 x 12 mm, body dia 52 mm\)\n/,
    )
    expect(warnings().filter((w) => w.rule === 'shortStickout')).toEqual([])
  })

  it('a stickout inside the margin: the collision, and only DF130’s own shortStickout', async () => {
    const { s, planId, planOperationId, warnings } = await holderCase(
      { preset: 'er11' },
      { toolpaths: true },
    )
    await s.run('plan.operation.update', { planId, planOperationId, stickout: '8' })
    await generate(s, planId)
    expect(warnings().filter((w) => w.rule === 'shortStickout')).toEqual([
      expect.objectContaining({ params: { stickout: 8, depth: 6, needed: 11 } }),
    ])
    expect(warnings().filter((w) => w.code === 'plan.workholding.collision')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('at least 36 mm out') }),
    ])
  })
})

// DF132 H4: the holder floor in the links (tool-holder.md#travel-links-at-clearance). Two small
// pockets of one tool run, far from the clamp, linked along X18: the Ø6 tool passes 7 mm from the
// clamp's pad (X−18–10), the ER11 nut (Ø19, 20 mm out) would pass over its 25 mm top.
async function linkCase(holder: object | undefined, toolHolder?: object) {
  const s = await planSetup({ part: false, stock: STOCK, services: services() })
  for (const y of ['6', '94'])
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'rectangle', center: ['18', y], length: '8', width: '8', cornerRadius: '3' },
      depth: '3',
      floorRadius: '0',
    })
  await s.run('project.apply', {})
  const { kind: _, ...m } = machineValues()
  const machineId =
    holder === undefined
      ? s.machineId
      : (
          (await s.run('library.machine.add', {
            values: { ...libraryInput({ ...m, name: 'Shapeoko ER11' }), holder },
          })) as { id: string }
        ).id
  const planId = await s.create({ machineLibraryItemId: machineId })
  const setup = s.plan(planId).setups[0]!
  const toolId = toolHolder === undefined ? s.tools.flat6 : await ownHolderTool(s, toolHolder)
  for (const op of setup.operations) {
    await s.run('plan.tool.assign', { planId, planOperationId: op.id, toolLibraryItemId: toolId })
    await s.run('plan.operation.update', { planId, planOperationId: op.id, stickout: '20' })
  }
  await s.run('plan.workholding.set', { planId, setupId: setup.id, items: [CLAMP] })
  const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, uiSource()))
    .value as { jobId: string }
  expectOk(await s.d.job(jobId).unwrap().result)
  const warnings = (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] })
    .warnings
  const text = withoutAppVersion(expectOk(await exportPlan(s.d.doc, planId, services())).text)
  return { warnings, text }
}
describe('a link beside the clamp under the ER11 nut (DF132 H4)', () => {
  const nut = [
    { radius: 3, above: 0 },
    { radius: 9.5, above: 20 },
    { radius: 26, above: 32 },
  ]
  it('without a holder the low link carries the nut over the clamp; with an ER11 the floor lifts it', async () => {
    const today = await linkCase(undefined)
    // the tool alone clears the clamp; the nut 20 mm above it would not
    expect(gcodeClearance(today.text, ORACLE_BOX, 3)).toBeGreaterThanOrEqual(2 - 0.011)
    expect(gcodeClearance(today.text, ORACLE_BOX, nut)).toBeLessThan(2)
    // the link crosses at the pockets' retract plane (Z2): the nut's bottom at Z22, under the
    // clamp's top + margin (27)
    expect(today.text).toContain('X18\nY5.5\nG0 Z2\nY94\n(Pocket 2)\n')
    const er11 = await linkCase({ preset: 'er11' })
    // the nut's bottom at the clamp's top + 5 mm: the link at 25 + 5 − 20
    expect(er11.text).toContain('X18\nY5.5\nG0 Z2\nZ10\nY94\n(Pocket 2)\n')
    // the H2 check agrees: no holder finding, no clamp shortStickout, the export passes
    expect(er11.warnings.map((w) => w.code)).not.toContain('plan.workholding.collision')
    expect(er11.warnings.filter((w) => w.rule === 'shortStickout')).toEqual([])
    // the link keeps the nut the read-out's 5 mm above the clamp: the number stays the stickout
    expect(er11.text).toContain('min stickout 20 mm')
    expect(gcodeClearance(er11.text, ORACLE_BOX, nut)).toBeGreaterThanOrEqual(2 - 0.011)
  })
})

// DF132 H6: a library tool's own holder overrides the machine's in the check, the read-out, the
// links and the program (tool-holder.md#model, § Implementation (H6)).
describe("a tool's own holder overrides the machine's (DF132 H6)", () => {
  it('an ER11 on the tool alone: the collision as with the machine ER11, no unknown info, its header line', async () => {
    const { s, planId, warnings } = await holderCase(undefined, { toolHolder: { preset: 'er11' } })
    // every tool of the setup has its own holder: nothing is left unchecked
    expect(warnings().map((w) => w.code)).not.toContain('plan.holder.unknown')
    const err = expectErrCode(await exportPlan(s.d.doc, planId, services()), 'plan.check')
    expect(err.message).toContain('the collet nut (ER11, Ø19)')
    expect(err.message).toContain('at least 36 mm out')
  })

  it("a slim extension on the tool clears the clamp the machine's ER11 nut hits", async () => {
    const { s, planId, planOperationId, warnings } = await holderCase(
      { preset: 'er11' },
      { toolpaths: true, toolHolder: SLIM },
    )
    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, uiSource()))
      .value as { jobId: string }
    expectOk(await s.d.job(jobId).unwrap().result)
    expect(warnings().map((w) => w.code)).not.toContain('plan.workholding.collision')
    // the read-out is the cut's (DF130's 11 mm), checked against the clamps with the tool's holder
    const row = (
      s.query('plan.operation.list', { planId }) as {
        operations: { stickoutNeeded: number; stickoutReason: unknown }[]
      }
    ).operations[0]!
    expect(row.stickoutNeeded).toBe(11)
    expect(row.stickoutReason).toMatchObject({ kind: 'cut', planOperationId, clamps: 'checked' })
    // the program names the tool's holder, not the machine's no operation runs in
    const text = withoutAppVersion(expectOk(await exportPlan(s.d.doc, planId, services())).text)
    expect(text).toContain('(Holder T1: Nut dia 10 x 50 mm, body dia 52 mm)')
    expect(text).not.toContain('(Holder: ER11')
    const envelope = [
      { radius: 3, above: 0 },
      { radius: 5, above: 25 },
      { radius: 26, above: 75 },
    ]
    expect(gcodeClearance(text, ORACLE_BOX, envelope)).toBeGreaterThanOrEqual(2 - 0.011)
  })

  it("a tool's ER11 lifts the link on a machine without a holder; a slim one keeps it low under the machine's ER11", async () => {
    const own = await linkCase(undefined, { preset: 'er11' })
    expect(own.text).toContain('X18\nY5.5\nG0 Z2\nZ10\nY94\n(Pocket 2)\n')
    expect(own.text).toContain('(Holder T1: ER11 nut dia 19 x 12 mm, body dia 52 mm)')
    const slim = await linkCase({ preset: 'er11' }, SLIM)
    // the Ø10 nut passes 8 mm from the pad with 3 mm to spare: the link stays at Z2
    expect(slim.text).toContain('X18\nY5.5\nG0 Z2\nY94\n(Pocket 2)\n')
    expect(slim.warnings.map((w) => w.code)).not.toContain('plan.workholding.collision')
  })
})
