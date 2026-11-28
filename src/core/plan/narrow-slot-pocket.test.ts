// DF144 (TG #492): a through pocket cutting a strip off the stock, a slot a little wider than the
// tool (6.3 mm for the 6 mm flat, narrower than D + 2 × the 0.2 mm allowance) running past both
// stock ends, 0.5 mm from the front edge. The roughing lost the slot (its wall piece shrunk by the
// allowance kept only the two ends past the stock) and the finishing ring plunged into the
// middle of the slot and cut it whole, at the full depth in one pass.
// Spec: docs/modes/plan-v0.3.md#narrow-parts-roughed-at-the-wall-df144
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { toGeneratorInputs } from '../toolpath/inputs'
import type { Toolpath } from '../toolpath/model'
import { generateRequest } from '../toolpath/request'
import { Heightmap } from '../toolpath/testing/oracles'
import { pocketDeepCuts, regionCoverage } from '../toolpath/testing/region-coverage'
import { planOperationInputs } from './inputs'
import { planSetup } from './plan.fixture'

const region2d = nodeRegion2d()

async function cutOff() {
  const s = await planSetup({ part: false, services: { region2d } })
  await s.run('design.pocket.add', {
    partId: s.partId,
    on: 'stock.top',
    shape: {
      kind: 'rectangle',
      center: ['50', '3.65'],
      length: '111',
      width: '6.3',
      cornerRadius: '3',
    },
    depth: '20',
    floorRadius: '0',
    through: true,
  })
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const op = s.plan(planId).setups[0]!.operations[0]!
  await s.run('plan.operation.update', {
    planId,
    planOperationId: op.id,
    strategy: { entry: 'ramp' },
  })
  const [input] = expectOk(planOperationInputs(s.d.doc, planId, [op.id], region2d))
  const req = expectOk(toGeneratorInputs(input!, region2d))
  if (req.kind !== 'regionPocket') throw new Error('regionPocket expected')
  const tp = expectOk(generateRequest(req, undefined, () => Ok(region2d)))
  return { inp: req.inputs[0]!, tp }
}

/** The 100 × 60 stock (air beyond it), in the setup's WCS (zero at its front-left top corner). */
const stock = () => new Heightmap(100, 60, 0.25)

const finishPlunges = (tp: Toolpath) =>
  tp.passes
    .filter((p) => p.kind === 'finish')
    .flatMap((p) => p.moves)
    .filter((m) => m.kind === 'line')

describe('a slot narrower than the tool + 2 × the allowance (DF144)', () => {
  it('roughs the slot level by level; no move meets more than the stepdown', async () => {
    const { inp, tp } = await cutOff()
    expect(inp.tool.diameter).toBe(6)
    expect(inp.strategy.finishAllowance).toBeGreaterThan((6.3 - 6) / 2)
    expect(inp.operation.depth).toBeGreaterThan(inp.cutting.stepdown * 2)
    expect(pocketDeepCuts(tp, inp, { heightmap: stock(), origin: [0, 0] }).slice(0, 5)).toEqual([])
    // every rough level cuts along the slot's middle, not only its two ends past the stock
    const rough = tp.passes.filter((p) => p.kind === 'rough')
    for (const p of rough)
      expect(
        p.moves.some((m) => m.kind === 'line' && Math.abs(m.to[0] - 50) < 45 && m.to[1] > 3),
      ).toBe(true)
    expect(finishPlunges(tp).length).toBeGreaterThan(0)
  })

  it('the stock in the slot is cut to the floor; nothing outside it', async () => {
    const { inp, tp } = await cutOff()
    const { region, onZ, depth } = inp.operation
    const c0 = expectOk(region2d.offset(region, inp.tool.diameter / 2))
    const cov = regionCoverage(region, c0, tp, inp.tool, { length: 100, width: 60 }, onZ - depth)
    expect(cov.gouge).toBe(0)
    expect(cov.leftover).toBeLessThan(1)
  })
})
