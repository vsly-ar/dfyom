// The tool holder in the plan (hardening DF132 H2): a 25 mm toe clamp beside a pocket that the
// Ø6 tool clears but the ER11 nut hits. The exported program is checked by the independent G-code
// oracle with the stepped envelope, never only by the check itself.
// Spec: docs/modes/tool-holder.md (§ Checks, § Findings, § Testing)
import { describe, expect, it } from 'vitest'
import { Ok } from '../../../shared/result'
import { expectErrCode, expectOk } from '../../../shared/testing/result'
import { createInProcessWorkers } from '../../commands/jobs'
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
async function holderCase(holder: object | undefined) {
  const s = await planSetup({ part: false, stock: STOCK, services: { region2d } })
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
    toolLibraryItemId: s.tools.flat6,
  })
  await s.run('plan.workholding.set', { planId, setupId: setup.id, items: [CLAMP] })
  const warnings = () =>
    (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings
  return { s, planId, planOperationId: op.id, warnings }
}

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
