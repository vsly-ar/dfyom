// Engraved patterns E2 headless: a preset SVG (wood grain, data-level stops per line) imported and
// cut as one Line with depth from its levels (`{ min, max }`), through `dfyom batch` and the agent's
// tools only: design.shape.import, design.line.add, the plan (V-bit from the library), the
// toolpath and the export, whose Z varies between the shallowest and the deepest level.
// Spec: docs/modes/engraved-patterns.md#implementation-e2
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { tempDir } from '../host/host.fixture'
import { spawnCli } from './cli.fixture'
import { agentSession, type CallResult } from './exit-criteria.fixture'
import { MACHINE } from './exit-criteria.v04.fixture'

const t = tempDir('dfyom-e2e-line-levels-')
afterAll(() => t.cleanup())

const PRESET = fileURLToPath(
  new URL('../../core/design/engraving/presets/wood-grain.svg', import.meta.url),
)

const V_BIT = {
  name: 'V-bit 60 × 6',
  type: 'chamferMill',
  diameter: '6',
  angle: '60',
  fluteLength: '6',
  overallLength: '50',
  fluteCount: '2',
  toolMaterial: 'carbide',
  presets: [
    {
      name: 'Plywood',
      materialClass: 'sheetGood',
      spindleSpeed: '18000',
      feedRate: '1500',
      plungeRate: '400',
      stepdown: '0.5',
    },
  ],
}

describe(
  'E2: a preset SVG with levels as a variable-depth Line, headless',
  { timeout: 180_000 },
  () => {
    it('imports the wood grain preset, plans it 0.2–1 mm and exports varying depth', async () => {
      const cli = spawnCli(['batch'], t.dir)
      const call = async (name: string, args: object = {}): Promise<CallResult> => {
        cli.send({ name, args })
        return (await cli.next()) as unknown as CallResult
      }
      const { ok, waitJob } = agentSession(call)

      const stock = (
        await ok<{ id: string }>('library.stock.add', {
          values: {
            name: 'Birch plywood 6',
            shape: 'block',
            length: '120',
            width: '80',
            thickness: '6',
            material: { name: 'Birch plywood', class: 'sheetGood' },
          },
        })
      ).value.id
      await ok('library.tool.add', { values: V_BIT })
      const machine = (await ok<{ id: string }>('library.machine.add', { values: MACHINE })).value
        .id
      const created = await ok<{ revision: number }>('project.create', {
        name: 'Grain lid',
        unitSystem: 'mm',
      })
      const { partId } = (
        await ok<{ partId: string }>('design.part.add', {
          name: 'Lid',
          stockLibraryItemId: stock,
          expectedRevision: created.value.revision,
        })
      ).value
      await ok('design.shape.import', { partId, path: PRESET })
      const { shapes } = (
        await ok<{ shapes: { id: string; bounds: { min: number[]; max: number[] } }[] }>(
          'design.shape.list',
          { partId },
        )
      ).value
      expect(shapes.length).toBeGreaterThan(1)
      // every line where the drawing put it, the tile moved to the middle of the lid
      const at = (b: { min: number[]; max: number[] }, k: 0 | 1) =>
        String((b.min[k]! + b.max[k]!) / 2 + (k === 0 ? 40 : 30))
      const added = (
        await ok<{ operationId: string }>('design.line.add', {
          partId,
          paths: shapes.map((s) => ({ shapeId: s.id, center: [at(s.bounds, 0), at(s.bounds, 1)] })),
          depth: { min: '0.2', max: '1' },
        })
      ).value
      expect(added.operationId).toBe('line1')

      const { planId } = (
        await ok<{ planId: string }>('plan.create', { partId, machineLibraryItemId: machine })
      ).value
      const { plan } = (
        await ok<{ plan: { setups: { id: string; operations: { kind: string }[] }[] } }>(
          'plan.get',
          { planId },
        )
      ).value
      const setup = plan.setups[0]!
      expect(setup.operations.map((o) => o.kind)).toEqual(['line'])
      const gen = await ok<{ jobId: string }>('plan.toolpath.generate', { planId })
      const generated = (await waitJob(gen.value.jobId)) as { ok: boolean }
      expect(generated.ok, JSON.stringify(generated)).toBe(true)
      const target = join(t.dir, 'grain-lid.nc')
      const exported = (
        await ok<{ warnings: unknown[] }>('plan.export', { planId, setupId: setup.id, target })
      ).value
      expect(exported.warnings).toEqual([])
      // the cutting moves (below the top): deepest at level 1, shallowest at the faded ends (0.1)
      const program = readFileSync(target, 'utf8')
      const zs = [...program.matchAll(/Z(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]))
      const cuts = zs.filter((z) => z < 0)
      expect(Math.min(...cuts)).toBeCloseTo(-1, 3)
      expect(new Set(cuts.map((z) => z.toFixed(2))).size).toBeGreaterThan(10)
      expect(cuts.some((z) => z > -0.35)).toBe(true)
      await ok('project.save', { target: join(t.dir, 'grain-lid.dfyom') })
      cli.end()
      expect(await cli.exited).toMatchObject({ code: 0, stderr: '' })
    })
  },
)
