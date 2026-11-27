// Marks from Run (hardening DF135 C2, docs/modes/cut-state.md#marking): which plan operations a
// run finished from its record (each operation's first line, where it stopped), what a resumed
// run keeps, which design units that cuts in full, and what Run does: mark a real `done` run,
// offer a stopped one, nothing on the virtual machine, a changed plan or while a resume waits.
// The runs themselves (loopback and virtual machine) are in commands.test.ts.
import { describe, expect, it } from 'vitest'
import { planSetup } from '../plan/plan.fixture'
import type { PlanDTO } from '../plan/plan.dto'
import { carriedFinished, finishedOperations, finishedUnits, runCutMarks } from './cut-marks'
import { runPlanHash } from './plan-hash'
import type { LastRun } from './service'

const START = [
  { planOperationId: 'b', fromLine: 40 },
  { planOperationId: 'a', fromLine: 10 },
  { planOperationId: 'c', fromLine: 90 },
]

describe('finishedOperations', () => {
  it('a done run finished every streamed operation, in program order', () => {
    expect(finishedOperations(START, 'done', undefined)).toEqual(['a', 'b', 'c'])
  })

  it('a stopped run finished those before the operation in progress, never that one (Q197)', () => {
    expect(finishedOperations(START, 'stopped', 'b')).toEqual(['a'])
    expect(finishedOperations(START, 'failed', 'c')).toEqual(['a', 'b'])
    expect(finishedOperations(START, 'stopped', 'a')).toEqual([])
    expect(finishedOperations(START, 'stopped', undefined)).toEqual([])
  })
})

describe('carriedFinished', () => {
  const before: LastRun = {
    jobId: 'j1',
    planId: 'p',
    setupId: 's',
    outcome: 'failed',
    planHash: 'h',
    finished: ['a', 'b'],
  }
  const same = { planId: 'p', setupId: 's', planHash: 'h' }

  it('a resume keeps what the run before finished and it does not stream', () => {
    expect(carriedFinished(before, same, START.slice(0, 1))).toEqual(['a'])
    expect(carriedFinished(before, same, [{ planOperationId: 'c', fromLine: 1 }])).toEqual([
      'a',
      'b',
    ])
  })

  it('a run from the beginning, another setup or a changed program keeps nothing', () => {
    expect(carriedFinished(before, same, START)).toEqual([])
    expect(carriedFinished(before, { ...same, setupId: 't' }, [])).toEqual([])
    expect(carriedFinished(before, { ...same, planHash: 'x' }, [])).toEqual([])
    expect(carriedFinished(undefined, same, [])).toEqual([])
  })
})

describe('finishedUnits and runCutMarks', () => {
  /** A facing and a pocket with roughing: one setup. */
  async function plan() {
    const s = await planSetup({ part: false })
    await s.run('design.facing.add', { partId: s.partId, depth: '0.5' })
    await s.run('design.pocket.add', {
      partId: s.partId,
      on: 'facing1.floor',
      shape: { kind: 'rectangle', center: ['50', '30'], length: '40', width: '24' },
      depth: '4',
      roughing: true,
    })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const p = s.plan(planId)
    const opOf = (d: string) =>
      p.setups[0]!.operations.find((o) => o.designOperationIds.includes(d))!.id
    return { p, part: s.d.doc.parts[s.partId]!, opOf }
  }
  const lastRun = (p: PlanDTO, over: Partial<LastRun>): LastRun => ({
    jobId: 'j',
    planId: p.id,
    setupId: p.setups[0]!.id,
    outcome: 'done',
    planHash: runPlanHash(p, p.setups[0]!.id),
    finished: p.setups[0]!.operations.map((o) => o.id),
    real: true,
    ...over,
  })

  it('a real done run of an unchanged program marks every unit it cut', async () => {
    const { p, part } = await plan()
    expect(runCutMarks(lastRun(p, {}), p, part)).toEqual({
      kind: 'mark',
      planId: p.id,
      units: ['facing1', 'pocket1'],
    })
  })

  it('a partly cut unit is not marked: the roughing pass alone does not cut the pocket', async () => {
    const { p, part, opOf } = await plan()
    const partly = [opOf('facing1'), opOf('pocket1_roughing')]
    expect(finishedUnits(p, partly, part)).toEqual(['facing1'])
    const stopped = lastRun(p, {
      outcome: 'stopped',
      planOperationId: opOf('pocket1'),
      finished: partly,
    })
    expect(runCutMarks(stopped, p, part)).toEqual({
      kind: 'offer',
      planId: p.id,
      units: ['facing1'],
    })
  })

  it('the virtual machine, a changed plan, a pending resume or nothing new mark nothing', async () => {
    const { p, part } = await plan()
    const { real: _real, ...virtual } = lastRun(p, {})
    expect(runCutMarks(virtual, p, part)).toEqual({ kind: 'none', reason: 'notReal' })
    expect(runCutMarks(lastRun(p, { planHash: 'old' }), p, part)).toEqual({
      kind: 'none',
      reason: 'changed',
    })
    const interrupted = lastRun(p, {
      outcome: 'failed',
      interruption: {} as NonNullable<LastRun['interruption']>,
    })
    expect(runCutMarks(interrupted, p, part)).toEqual({ kind: 'none', reason: 'resumePending' })
    expect(runCutMarks(lastRun(p, { finished: [] }), p, part)).toEqual({
      kind: 'none',
      reason: 'nothing',
    })
    const marked = { ...part, alreadyCut: ['facing1', 'pocket1'] }
    expect(runCutMarks(lastRun(p, {}), p, marked)).toEqual({ kind: 'none', reason: 'nothing' })
    expect(runCutMarks(undefined, p, part)).toEqual({ kind: 'none', reason: 'notPlan' })
  })
})
