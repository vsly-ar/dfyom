// The stepped countersink (v0.4 F7, D41): `csMethod: stepped` + `csStepdown` on a countersink
// hole, expanded to a chamfer with a stepdown; rules, the info note, persistence, and one tool
// for the hole and its terraces (auto choice, a tool set on the drill role).
// Spec: docs/modes/design-v0.4.md#stepped-countersink-f7-d41
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import type { DfmWarning } from '../geometry/model'
import { designSetup, type DesignSetup } from './design.fixture'
import { loadPart } from './load'

const feature = (s: DesignSetup) =>
  s.part().features!.find((f) => f.id === 'hole1') as Record<string, unknown>
const exact = (q: unknown) => {
  const e = (q as { exact: { num: string; den: string } }).exact
  return Number(e.num) / Number(e.den)
}
const rules = (e: { issues: readonly { path: readonly unknown[]; rule: string }[] }) =>
  e.issues.map((i) => [i.path.join('.'), i.rule])

async function addHole(s: DesignSetup, args: object) {
  return (await s.run('design.hole.add', { partId: s.partId, center: ['30', '30'], ...args })) as {
    operationIds: string[]
    warnings: DfmWarning[]
  }
}

const tool = (values: object) => ({
  fluteLength: '20',
  overallLength: '60',
  fluteCount: '2',
  ...values,
})

describe('stepped countersink (F7)', () => {
  it('expands to a chamfer with a stepdown (default 1 mm) and notes the terraces', async () => {
    const s = await designSetup()
    const out = await addHole(s, { fastener: 'M3', type: 'countersink', csMethod: 'stepped' })
    expect(out.operationIds).toEqual(['hole1_drill', 'hole1_countersink'])
    expect(s.op('hole1_countersink')).toMatchObject({
      kind: 'chamfer',
      edgeOf: 'hole1_drill',
      stepdown: { source: '1 mm' },
    })
    expect(feature(s)).toMatchObject({ csMethod: 'stepped', csStepdown: { source: '1 mm' } })
    // M3: cone (7.12 − 3.4) / 2 / tan 45° = 1.86 mm → 2 terraces of 0.93 mm
    expect(out.warnings.filter((w) => w.code === 'dfm.countersinkStepped')).toEqual([
      expect.objectContaining({
        severity: 'info',
        operation: 'hole1_countersink',
        parameter: 'csMethod',
        params: { stepdown: 0.93, terraces: 2, feature: 'hole1' },
      }),
    ])
    // a plain countersink has neither
    await addHole(s, { fastener: 'M3', type: 'countersink', center: ['60', '30'] })
    expect(s.op('hole2_countersink')).not.toHaveProperty('stepdown')
    expect(s.part().features![1]).not.toHaveProperty('csMethod')
  })

  it('inch default 1/32"; csStepdown alone switches to stepped, chamfer drops it', async () => {
    const s = await designSetup({ units: 'inch' })
    await addHole(s, { fastener: 'M4', type: 'countersink', csMethod: 'stepped' })
    expect(s.op('hole1_countersink')).toMatchObject({ stepdown: { source: '1/32"' } })
    await s.run('design.hole.update', { partId: s.partId, featureId: 'hole1', csMethod: 'chamfer' })
    expect(s.op('hole1_countersink')).not.toHaveProperty('stepdown')
    await s.run('design.hole.update', {
      partId: s.partId,
      featureId: 'hole1',
      csStepdown: '0.5 mm',
    })
    expect(feature(s)).toMatchObject({ csMethod: 'stepped', csStepdown: { source: '0.5 mm' } })
    // a later edit keeps the method and stepdown
    await s.run('design.hole.update', { partId: s.partId, featureId: 'hole1', csAngle: '82' })
    expect(exact(s.op('hole1_countersink')['stepdown' as never])).toBe(0.5)
  })

  it('rules: not for another type or method, at least 0.1 mm (mapped to csStepdown)', async () => {
    const s = await designSetup()
    const add = (args: object) =>
      s.fail(
        'design.hole.add',
        { partId: s.partId, center: ['30', '30'], fastener: 'M3', ...args },
        'model.invariant',
      )
    expect(rules(await add({ type: 'counterbore', csMethod: 'stepped' }))).toEqual([
      ['csMethod', 'notForType'],
    ])
    expect(rules(await add({ csStepdown: '1' }))).toEqual([['csStepdown', 'notForType']])
    expect(rules(await add({ type: 'countersink', csMethod: 'chamfer', csStepdown: '1' }))).toEqual(
      [['csStepdown', 'notForMethod']],
    )
    const small = await add({ type: 'countersink', csStepdown: '0.05' })
    expect(small.issues).toEqual([
      expect.objectContaining({ path: ['csStepdown'], rule: 'range', params: expect.anything() }),
    ])
  })

  it('persists: the record loads, stepdown and method kept', async () => {
    const s = await designSetup()
    await addHole(s, { fastener: 'M5', type: 'countersink', csStepdown: '0.8' })
    const loaded = expectOk(loadPart(s.d.doc, s.partId, 'test'))
    const hole = loaded.features[0]!.feature as unknown as {
      head: { csStepdown: { isSome(): boolean; unwrap(): { canonical: number } } }
    }
    expect(hole.head.csStepdown.unwrap().canonical).toBe(0.8)
    const cs = loaded.part.operations.find((o) => o.id === 'hole1_countersink')!
    expect(cs.kind === 'chamfer' && cs.stepdown.unwrap().canonical).toBe(0.8)
  })

  it('one tool: the hole is bored by the end mill that cuts the terraces', async () => {
    const s = await designSetup()
    await s.run('library.tool.add', {
      values: tool({ name: 'Drill 3.4', type: 'drill', diameter: '3.4', pointAngle: '118' }),
    })
    const mill = (await s.run('library.tool.add', {
      values: tool({ name: '2.5 mm end mill', type: 'flatEndMill', diameter: '2.5' }),
    })) as { id: string }
    await s.run('library.tool.add', {
      values: tool({ name: 'V-bit 90', type: 'chamferMill', diameter: '12', angle: '90' }),
    })
    await addHole(s, { fastener: 'M3', type: 'countersink' })
    await addHole(s, {
      fastener: 'M3',
      type: 'countersink',
      csMethod: 'stepped',
      center: ['60', '30'],
    })
    await s.run('project.apply', {})
    const toolOf = (id: string) => {
      const t = s.op(id).tool
      return t?.kind === 'specific' ? s.d.doc.snapshots[t.snapshotId]!.libraryItemId : t
    }
    // the plain countersink: drill and chamfer mill; the stepped one: the end mill twice
    expect(toolOf('hole1_drill')).not.toBe(mill.id)
    expect(s.op('hole1_countersink').tool).not.toEqual(s.op('hole1_drill').tool)
    expect(toolOf('hole2_drill')).toBe(mill.id)
    expect(s.op('hole2_countersink').tool).toEqual(s.op('hole2_drill').tool)
    // a tool set on the drill role moves the unlocked countersink along (one command)
    await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'hole2_drill',
      tool: { kind: 'generalized', type: 'flatEndMill', diameter: '3' },
    })
    expect(s.op('hole2_countersink')).toMatchObject({
      tool: { kind: 'generalized', type: 'flatEndMill', diameter: { source: '3' } },
    })
    expect(s.op('hole2_countersink')).not.toHaveProperty('toolLocked')
    // a drill locked on the drill role does not fit the terraces: the countersink keeps its own
    await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'hole2_drill',
      tool: { kind: 'generalized', type: 'drill', diameter: '3.4' },
    })
    expect(s.op('hole2_countersink')).toMatchObject({ tool: { type: 'flatEndMill' } })
  })

  it('dfm.chamferNoTool says the library has no end mill small enough', async () => {
    const s = await designSetup()
    await s.run('library.tool.add', {
      values: tool({ name: '6 mm end mill', type: 'flatEndMill', diameter: '6' }),
    })
    const out = await addHole(s, { fastener: 'M3', type: 'countersink', csMethod: 'stepped' })
    expect(out.warnings.find((w) => w.code === 'dfm.chamferNoTool')).toMatchObject({
      operation: 'hole1_countersink',
      parameter: 'stepdown',
      params: expect.objectContaining({ stepped: 1 }),
    })
  })
})
