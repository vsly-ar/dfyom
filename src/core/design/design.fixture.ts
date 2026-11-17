// Test-only setup for design commands: a library with one stock and a project with one part.
// Not app code. Doc: docs/modes/design.md#implementation-task-25
import { expect } from 'vitest'
import type { AppError } from '../../shared/errors/app-error'
import type { ErrorCode } from '../../shared/errors/codes'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createDispatcher, type Dispatcher } from '../commands/dispatcher'
import { inProcessWorkers } from '../commands/jobs'
import { createAppRegistry } from '../commands/registry'
import { fakeClock, fakeIds, uiSource } from '../commands/testing'
import { Library } from '../library/library'
import { len } from '../library/library.fixture'
import { createMemoryLibraryStorage } from '../library/memory-storage'
import { newProjectDoc, type UnitSystem } from '../project/document'
import type { OperationDTO, PartDTO } from './part.dto'

const ui = uiSource()

/** The geometry test part's stock: 100 × 60 × 20 (docs/architecture/geometry.md#testing). */
export const testStock = (thickness = '20') => ({
  name: 'Test block',
  shape: 'block' as const,
  length: len('100'),
  width: len('60'),
  thickness: len(thickness),
  material: { name: '6061-T6', class: 'aluminum' as const },
})

export interface DesignSetup {
  readonly d: Dispatcher
  readonly partId: string
  /** Dispatch a command that must succeed; returns its value. */
  run(name: string, args: object): Promise<unknown>
  /** Dispatch a command that must fail with `code`. */
  fail(name: string, args: object, code: ErrorCode): Promise<AppError>
  part(): PartDTO
  op(id: string): OperationDTO
  undo(): Promise<void>
  redo(): Promise<void>
}

export async function designSetup(
  opts: { units?: UnitSystem; thickness?: string } = {},
): Promise<DesignSetup> {
  const library = expectOk(await Library.open(createMemoryLibraryStorage()))
  const d = createDispatcher({
    registry: expectOk(createAppRegistry()),
    doc: newProjectDoc({ name: 'Bracket', unitSystem: opts.units ?? 'mm' }),
    ids: fakeIds(),
    clock: fakeClock(Date.UTC(2026, 10, 17, 10)),
    services: { workers: inProcessWorkers, library },
  })
  const run = async (name: string, args: object) => expectOk(await d.dispatch(name, args, ui)).value
  const stock = (await run('library.stock.add', { values: testStock(opts.thickness) })) as {
    id: string
  }
  const { partId } = (await run('design.part.add', {
    name: 'Bracket',
    stockLibraryItemId: stock.id,
  })) as { partId: string }
  const part = () => d.doc.parts[partId]!
  return {
    d,
    partId,
    run,
    fail: async (name, args, code) => expectErrCode(await d.dispatch(name, args, ui), code),
    part,
    op: (id) => {
      const op = part().operations.find((o) => o.id === id)
      expect(op, id).toBeDefined()
      return op!
    },
    undo: async () => {
      expect(expectOk(await d.dispatch('history.undo', {}, ui)).value).not.toEqual({
        entrySeq: null,
      })
    },
    redo: async () => {
      expect(expectOk(await d.dispatch('history.redo', {}, ui)).value).not.toEqual({
        entrySeq: null,
      })
    },
  }
}

/** The geometry test part (testing/test-part.ts) built through the design commands. */
export async function buildTestPart(s: DesignSetup): Promise<void> {
  const partId = s.partId
  await s.run('design.facing.add', { partId, depth: '0.5' })
  await s.run('design.pocket.add', {
    partId,
    shape: {
      kind: 'rectangle',
      center: ['50', '30'],
      length: '40',
      width: '25',
      cornerRadius: '4',
    },
    depth: '8',
    floorRadius: '2',
  })
  const drill = (x: string, y: string, extra: object) =>
    s.run('design.drilling.add', { partId, center: [x, y], diameter: '6', ...extra })
  await drill('15', '15', {})
  await drill('85', '15', { bottom: 'flat', depth: '12' })
  await drill('15', '45', { bottom: 'drillPoint', depth: '12' })
  await drill('85', '45', { bottom: 'drillPoint', depth: '12', pointAngle: '118' })
  await s.run('design.profile.add', {
    partId,
    shape: {
      kind: 'rectangle',
      center: ['50', '30'],
      length: '84',
      width: '44',
      cornerRadius: '5',
    },
    slotWidth: '6',
    tabs: { count: '4', width: '8', thickness: '3' },
  })
}
