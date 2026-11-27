// DF124 T2 (TG #409): a tapered ball end mill cuts Lines. Added to the library beside a ball end
// mill, it is the engraved pattern's auto tool (no V-bit: tapered balls rank next, Q152), a V-bit
// still ranks first; the width read-out is the ball-and-cone groove; the plan takes it with F11
// feeds and a suggested stepdown, plunges on request, and the export cuts to the deepest level and
// streams on the virtual machine. Doc: docs/modes/tapered-ball-nose.md#implementation-t2
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { uiSource } from '../commands/testing'
import { createInProcessWorkers } from '../commands/jobs'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { deg, len, libraryInput, num } from '../library/library.fixture'
import { taperedGrooveWidth } from '../library/tool'
import { exportPlan } from '../post/plan-export'
import { streamProgram } from '../run/grbl/sender.fixture'
import { createToolpathCache } from '../toolpath/cache'
import type { PlanWarning } from './checks'
import { loadPlan } from './plan'
import { opsOf, planSetup } from './plan.fixture'

const region2d = nodeRegion2d()
const ui = uiSource()

const TAPER = {
  name: 'R0.25 3.6°',
  type: 'taperedBallEndMill' as const,
  diameter: len('3.175'),
  tipDiameter: len('0.5'),
  taperAngle: deg('3.6'),
  fluteLength: len('22'),
  overallLength: len('38'),
  fluteCount: num('2'),
  toolMaterial: 'carbide' as const,
  presets: [],
}

const BALL = {
  name: 'Ball 1/8',
  type: 'ballEndMill' as const,
  diameter: len('3.175'),
  fluteLength: len('12'),
  overallLength: len('38'),
  fluteCount: num('2'),
  toolMaterial: 'carbide' as const,
  presets: [],
}

const BOARD = {
  name: 'Board',
  shape: 'block',
  length: '150',
  width: '100',
  thickness: '12',
  material: { name: 'Walnut', class: 'hardwood' },
}

interface OpView {
  id: string
  feeds: Record<string, { value: number; source: string } | null>
}

describe('DF124 T2: an engraved pattern with a tapered ball end mill', { timeout: 60_000 }, () => {
  it('auto choice, groove width, F11 feeds, plunge entry, export to the deepest level', async () => {
    const svc = {
      region2d,
      toolpaths: createToolpathCache(),
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    }
    const s = await planSetup({ part: false, services: svc, stock: BOARD })
    const add = async (values: object) =>
      ((await s.run('library.tool.add', { values: libraryInput(values) })) as { id: string }).id
    const ball = await add(BALL)
    const taper = await add(TAPER)
    await s.run('design.engraving.add', { partId: s.partId, depth: { min: '0.2', max: '1' } })
    await s.run('project.apply', {})
    // tapered balls rank before ball and flat end mills (Q152)
    const candidates = () =>
      (
        expectOk(
          s.d.query(
            'design.tool.candidates',
            { partId: s.partId, operationId: 'engraving1_line' },
            ui,
          ),
        ).value as { fitting: { toolLibraryItemId: string }[] }
      ).fitting.map((c) => c.toolLibraryItemId)
    expect(candidates()[0]).toBe(taper)
    expect(candidates()).toContain(ball)
    // the groove at 1 mm: 0.5 / cos 3.6° + 2 · 0.75 · tan 3.6° = 0.60 mm
    const dry = (await s.run('design.engraving.update', {
      partId: s.partId,
      featureId: 'engraving1',
      depth: { min: '0.2', max: '1' },
      dryRun: true,
    })) as { maxWidth?: number; warnings: { code: string }[] }
    expect(dry.maxWidth).toBe(Math.round(taperedGrooveWidth(0.5, 3.6, 3.175, 1) * 100) / 100)
    expect(dry.maxWidth).toBe(0.6)
    expect(dry.warnings.map((w) => w.code)).not.toContain('dfm.lineTooDeep')

    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const op = opsOf(s.plan(planId)).find((o) => o.designOperationIds.includes('engraving1_line'))!
    const snapshot = s.plan(planId).snapshots.find((x) => x.id === op.tool)
    expect(JSON.stringify(snapshot)).toContain(taper)
    // a tapered ball may plunge into a Line (its tip is backed by the cone)
    await s.run('plan.operation.update', {
      planId,
      planOperationId: op.id,
      strategy: { entry: 'plunge' },
    })
    const errors = (
      s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }
    ).warnings.filter((w) => w.severity === 'error')
    expect(errors).toEqual([])
    // F11 at 1 mm: De 0.6 mm, the 1/8" chip load × De / 3.175; the stepdown solved against De(ap)
    const view = (
      s.query('plan.operation.list', { planId }) as { operations: OpView[] }
    ).operations.find((o) => o.id === op.id)!
    const feed = view.feeds['feedRate']!
    expect(feed.source).toBe('calculator')
    expect(feed.value).toBeGreaterThan(0)
    expect(feed.value).toBeLessThan(1000)
    const stepdown = view.feeds['stepdown']!
    expect(stepdown.source).toBe('calculator')
    expect(stepdown.value).toBeLessThan(0.6)

    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
      .value as { jobId: string }
    const generated = expectOk(await s.d.job(jobId).unwrap().result) as {
      operations: { status: string }[]
    }
    expect(generated.operations.every((o) => o.status === 'generated')).toBe(true)
    const e = expectOk(await exportPlan(s.d.doc, planId, svc))
    const zs = e.lines.flatMap((l) =>
      [...l.matchAll(/Z(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])),
    )
    expect(Math.min(...zs.filter((z) => z < 0))).toBeCloseTo(-1, 3)
    expect(e.lines.some((l) => /tapered ball R0\.25 3\.6 deg/.test(l))).toBe(true)
    const machine = loadPlan(s.d.doc, planId, 'test').unwrap().machine.unwrap()
    const run = await streamProgram(e.lines, machine)
    expect(run.lines).toBe(e.lines.length)

    // a V-bit in the library still ranks first (Q152)
    const vbit = await add({
      ...TAPER,
      name: 'V-bit 60° 1/8',
      type: 'chamferMill',
      tipDiameter: undefined,
      taperAngle: undefined,
      angle: deg('60'),
      fluteLength: len('6'),
    })
    expect(candidates().slice(0, 2)).toEqual([vbit, taper])
  })
})
