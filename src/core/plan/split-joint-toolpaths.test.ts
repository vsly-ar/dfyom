// Split parts 4d (docs/modes/split-parts.md#implementation-4d), the toolpaths of the new joints:
// a 190 × 90 board of 12 mm plywood split across by one line with a finger joint, then with a
// half lap. Every piece is planned with no error, generated, exported setup by setup (goldens) and
// streamed through the virtual machine; the outline tool reaches every finger corner (T-bones),
// the lap pockets stop at the lap plane, the female's from its bottom setup.
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { exportPlan } from '../post/plan-export'
import { streamProgram } from '../run/grbl/sender.fixture'
import { createToolpathCache } from '../toolpath/cache'
import type { Toolpath } from '../toolpath/model'
import type { PlanWarning } from './checks'
import { loadPlan } from './plan'
import { opsOf, planSetup } from './plan.fixture'

const region2d = nodeRegion2d()
const ui = uiSource()

const BOARD = {
  name: 'Board',
  shape: 'block' as const,
  length: '200',
  width: '100',
  thickness: '12',
  material: { name: 'Birch plywood', class: 'sheetGood' as const },
}

async function board() {
  const svc = {
    region2d,
    toolpaths: createToolpathCache(),
    workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  }
  const s = await planSetup({ part: false, services: svc, stock: BOARD })
  await s.run('design.profile.add', {
    partId: s.partId,
    shape: {
      kind: 'rectangle',
      center: ['100', '50'],
      length: '190',
      width: '90',
      cornerRadius: '3',
    },
    slotWidth: '6',
    tabs: { count: '4', width: '6', thickness: '2' },
  })
  return { s, svc }
}

type Setup = Awaited<ReturnType<typeof board>>

/** Plans every piece, generates, exports each setup (golden) and streams it; the lowest Z per op. */
async function runPieces({ s, svc }: Setup, label: string) {
  await s.run('project.apply', {})
  const pieces = Object.values(s.d.doc.parts)
    .filter((p) => p.derivedFrom?.partId === s.partId)
    .sort((a, b) => a.derivedFrom!.index - b.derivedFrom!.index)
  expect(pieces).toHaveLength(2)
  const lowest = new Map<string, number>()
  const directions: string[][] = []
  for (const piece of pieces) {
    const planId = (
      (await s.run('plan.create', {
        partId: piece.id,
        machineLibraryItemId: s.machineId,
      })) as { planId: string }
    ).planId
    const errors = (
      s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }
    ).warnings.filter((w) => w.severity === 'error')
    expect(errors, piece.name).toEqual([])
    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
      .value as { jobId: string }
    const gen = expectOk(await s.d.job(jobId).unwrap().result) as {
      operations: { status: string }[]
    }
    expect(gen.operations.every((o) => o.status === 'generated')).toBe(true)
    for (const op of opsOf(s.plan(planId))) {
      const tp = (
        s.query('plan.toolpath.get', { planId, planOperationId: op.id }) as { toolpath: Toolpath }
      ).toolpath
      const zs = tp.passes.flatMap((p) => p.moves.map((m) => (m.kind === 'drill' ? 0 : m.to[2])))
      lowest.set(`${piece.derivedFrom!.index}:${op.designOperationIds[0]}`, Math.min(...zs))
    }
    const setups = s.plan(planId).setups
    directions.push(setups.map((x) => x.direction ?? '+z'))
    const machine = loadPlan(s.d.doc, planId, 'test').unwrap().machine.unwrap()
    for (const setup of setups) {
      const e = expectOk(await exportPlan(s.d.doc, planId, svc as never, { setupId: setup.id }))
      const run = await streamProgram(e.lines, machine)
      expect(run.lines).toBe(e.lines.length)
      const side = (setup.direction ?? '+z') === '+z' ? 'top' : 'bottom'
      await expect(e.lines.join('\n') + '\n').toMatchFileSnapshot(
        `__golden__/split-${label}-${piece.derivedFrom!.index}-${side}.nc`,
      )
    }
  }
  return { lowest, directions }
}

describe('split parts 4d: joint toolpaths', () => {
  it('a finger joint: both pieces from the top, goldens, machine', async () => {
    const b = await board()
    await b.s.run('design.split.set', {
      partId: b.s.partId,
      split: { lines: [{ axis: 'x', at: '100' }], joint: 'finger' },
    })
    const { lowest, directions } = await runPieces(b, 'finger')
    expect(directions).toEqual([['+z'], ['+z']])
    // the outline cut through (tabs aside) in both pieces
    expect(lowest.get('1:split1_outline')).toBeLessThan(-11.9)
    expect(lowest.get('2:split1_outline')).toBeLessThan(-11.9)
  }, 60_000)

  it('a half lap: the male from its top, the female from its bottom, goldens, machine', async () => {
    const b = await board()
    await b.s.run('design.split.set', {
      partId: b.s.partId,
      split: { lines: [{ axis: 'x', at: '100' }], joint: 'halfLap' },
    })
    const { lowest, directions } = await runPieces(b, 'lap')
    expect(directions).toEqual([['+z'], ['-z', '+z']])
    // both lap pockets end on the lap plane, 6 mm from their face
    expect(lowest.get('1:split1_lap1')).toBeCloseTo(-6, 6)
    expect(lowest.get('2:split1_lap1')).toBeCloseTo(-6, 6)
  }, 60_000)
})
