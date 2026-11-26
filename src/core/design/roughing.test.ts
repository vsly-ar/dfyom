// Roughing passes on pockets (hardening DF122, slice R1) through the design commands:
// `roughing` on design.pocket.add / .update owns `<id>_roughing` right before the pocket (its
// geometry the pocket's, kept in sync), stored only when on; off, remove and move carry it along
// in one undo step; it is edited only through its owner except its name and tool; its tool fits
// by width (≤ 0.6 × the narrowest width, no corner rule) and the auto choice takes the largest;
// `dfm.roughingNoGain` when it is not larger than the pocket's; the pattern's margins.
// Spec: docs/modes/roughing.md#model, docs/modes/roughing.md#implementation-r1
import { describe, expect, it } from 'vitest'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { designSetup, type DesignSetup } from './design.fixture'

const region2d = nodeRegion2d()
const setup = () => designSetup({ services: { region2d } })

interface Result {
  operationId?: string
  operationIds?: string[]
  warnings: { code: string; operation: string; parameter?: string; params: { rule?: string } }[]
}

/** 60 × 40 with R 1.5 corners, 8 mm deep (the doc's pocket). */
const POCKET = {
  shape: {
    kind: 'rectangle',
    center: ['40', '25'],
    length: '60',
    width: '40',
    cornerRadius: '1.5',
  },
  depth: '8',
}

const add = async (s: DesignSetup, args: object = {}) =>
  (await s.run('design.pocket.add', { partId: s.partId, ...POCKET, ...args })) as Result
const update = async (s: DesignSetup, args: object, id = 'pocket1') =>
  (await s.run('design.pocket.update', { partId: s.partId, operationId: id, ...args })) as Result
const ids = (s: DesignSetup) => s.part().operations.map((o) => o.id)
const op = (s: DesignSetup, id: string) =>
  s.part().operations.find((o) => o.id === id) as unknown as Record<string, unknown>
const src = (v: unknown) => (v as { source?: string } | undefined)?.source
const toolDiameter = (s: DesignSetup, id: string) =>
  src((op(s, id)['tool'] as { diameter?: unknown } | undefined)?.diameter)
const setTool = async (s: DesignSetup, id: string, diameter: string) =>
  (await s.run('design.operation.tool.set', {
    partId: s.partId,
    operationId: id,
    tool: { kind: 'generalized', type: 'flatEndMill', diameter },
  })) as Result

describe('pocket roughing (DF122 R1)', () => {
  it('on: <id>_roughing right before the pocket, same geometry, roughingOf; stored only when on', async () => {
    const s = await setup()
    await add(s)
    expect(op(s, 'pocket1')).not.toHaveProperty('roughingPass')
    await update(s, { roughing: true })
    expect(ids(s)).toEqual(['pocket1_roughing', 'pocket1'])
    const r = op(s, 'pocket1_roughing')
    const p = op(s, 'pocket1')
    expect(p['roughingPass']).toEqual({})
    expect(r).toMatchObject({
      kind: 'pocket',
      name: 'Pocket 1 · roughing',
      roughing: true,
      roughingOf: 'pocket1',
      on: p['on'],
      shape: p['shape'],
      depth: p['depth'],
      floorRadius: p['floorRadius'],
    })
    expect(r).not.toHaveProperty('leave')
    expect(r).not.toHaveProperty('featureId')
  })

  it('add with roughing; geometry edits and margins follow; a rename follows the default name', async () => {
    const s = await setup()
    const out = await add(s, { roughing: { wall: '0.5' } })
    expect(out.operationId).toBe('pocket1')
    expect(ids(s)).toEqual(['pocket1_roughing', 'pocket1'])
    expect(src((op(s, 'pocket1_roughing')['leave'] as { wall?: unknown }).wall)).toBe('0.5')
    await update(s, { depth: '6', through: true, name: 'Lid recess' })
    const r = op(s, 'pocket1_roughing')
    expect(src(r['depth'])).toBe('6')
    expect(r['through']).toBe(true)
    expect(r['name']).toBe('Lid recess · roughing')
    // true keeps the margins; an object replaces them
    await update(s, { roughing: true })
    expect(src((op(s, 'pocket1_roughing')['leave'] as { wall?: unknown }).wall)).toBe('0.5')
    await update(s, { roughing: { floor: '1' } })
    expect(op(s, 'pocket1_roughing')['leave']).toEqual({ floor: expect.anything() })
  })

  it('off, remove and move carry the roughing pocket in one undo step each', async () => {
    const s = await setup()
    await s.run('design.drilling.add', { partId: s.partId, center: ['5', '5'], diameter: '3' })
    await add(s, { roughing: true })
    expect(ids(s)).toEqual(['drill1', 'pocket1_roughing', 'pocket1'])
    await update(s, { roughing: false })
    expect(ids(s)).toEqual(['drill1', 'pocket1'])
    expect(op(s, 'pocket1')).not.toHaveProperty('roughingPass')
    await s.undo()
    expect(ids(s)).toEqual(['drill1', 'pocket1_roughing', 'pocket1'])
    await s.run('design.operation.move', { partId: s.partId, operationId: 'pocket1', toIndex: 0 })
    expect(ids(s)).toEqual(['pocket1_roughing', 'pocket1', 'drill1'])
    await s.undo()
    expect(ids(s)).toEqual(['drill1', 'pocket1_roughing', 'pocket1'])
    await s.run('design.operation.remove', { partId: s.partId, operationId: 'pocket1' })
    expect(ids(s)).toEqual(['drill1'])
    await s.undo()
    expect(ids(s)).toEqual(['drill1', 'pocket1_roughing', 'pocket1'])
  })

  it('the roughing pocket is edited through its owner, except its name and tool', async () => {
    const s = await setup()
    await add(s, { roughing: true })
    const refused = async (name: string, args: object) => {
      const e = await s.fail(
        name,
        { partId: s.partId, operationId: 'pocket1_roughing', ...args },
        'design.featureOwned',
      )
      expect(e.issues[0]?.rule).toBe('roughingOwned')
    }
    await refused('design.pocket.update', { depth: '3' })
    await refused('design.operation.remove', {})
    await refused('design.operation.move', { toIndex: 1 })
    await update(s, { name: 'Bulk' }, 'pocket1_roughing')
    expect(op(s, 'pocket1_roughing')['name']).toBe('Bulk')
    // a custom name is kept when the owner changes
    await update(s, { depth: '5' })
    expect(op(s, 'pocket1_roughing')['name']).toBe('Bulk')
    await setTool(s, 'pocket1_roughing', '6')
    expect(toolDiameter(s, 'pocket1_roughing')).toBe('6')
    // the tool survives owner edits
    await update(s, { depth: '4' })
    expect(toolDiameter(s, 'pocket1_roughing')).toBe('6')
  })

  it('margins are checked: wall ≥ 0, floor ≥ 0 and under the depth', async () => {
    const s = await setup()
    await add(s)
    const bad = async (roughing: object, rule: string) => {
      const e = await s.fail(
        'design.pocket.update',
        { partId: s.partId, operationId: 'pocket1', roughing },
        'model.invariant',
      )
      expect(e.issues.map((i) => i.rule)).toContain(rule)
    }
    await bad({ wall: '-0.1' }, 'nonNegative')
    await bad({ floor: '8' }, 'floorRange')
    expect(ids(s)).toEqual(['pocket1'])
  })

  it('auto tools: the largest end mill within 0.6 × the width roughs (Ø 12 in 40 mm), a Ø 3 the R 1.5 corners', async () => {
    const s = await setup()
    const out = await add(s, { roughing: true })
    expect(out.warnings.filter((w) => w.operation === 'pocket1_roughing')).toEqual([])
    await s.run('project.apply', {})
    expect(toolDiameter(s, 'pocket1_roughing')).toBe('12 mm')
    expect(toolDiameter(s, 'pocket1')).toBe('3 mm')
  })

  it('fit: over 0.6 × the width is roughingWidth, wider than the pocket is width; no corner rule', async () => {
    const s = await setup()
    await add(s, { roughing: true })
    const rule = (r: Result) =>
      r.warnings.find((w) => w.code === 'dfm.toolUnfit' && w.operation === 'pocket1_roughing')
        ?.params.rule
    expect(rule(await setTool(s, 'pocket1_roughing', '30'))).toBe('roughingWidth')
    expect(rule(await setTool(s, 'pocket1_roughing', '45'))).toBe('width')
    expect(rule(await setTool(s, 'pocket1_roughing', '20'))).toBeUndefined()
  })

  it('dfm.roughingNoGain when the roughing tool is not larger than the pocket’s', async () => {
    const s = await setup()
    await add(s, { roughing: true })
    await setTool(s, 'pocket1', '3')
    const gain = (r: Result) =>
      r.warnings
        .filter((w) => w.code === 'dfm.roughingNoGain')
        .map((w) => [w.operation, w.parameter])
    expect(gain(await setTool(s, 'pocket1_roughing', '3'))).toEqual([['pocket1_roughing', 'tool']])
    expect(gain(await setTool(s, 'pocket1_roughing', '8'))).toEqual([])
  })

  it('patterns: roughing { wall, floor } is stored on the feature and copied to the roughing pocket', async () => {
    const s = await setup()
    await s.run('design.pattern.add', {
      partId: s.partId,
      lattice: 'hex',
      cell: { kind: 'circle', diameter: '10' },
      spacing: { gap: '2' },
      depth: '3',
      roughing: { wall: '0.3' },
    })
    expect(
      src((s.part().features?.[0] as unknown as { roughing: { wall: unknown } }).roughing.wall),
    ).toBe('0.3')
    expect(src((op(s, 'pattern1_roughing')['leave'] as { wall?: unknown }).wall)).toBe('0.3')
    await s.run('design.pattern.update', {
      partId: s.partId,
      featureId: 'pattern1',
      roughing: true,
    })
    expect(src((op(s, 'pattern1_roughing')['leave'] as { wall?: unknown }).wall)).toBe('0.3')
    await s.run('design.pattern.update', {
      partId: s.partId,
      featureId: 'pattern1',
      roughing: false,
    })
    expect(ids(s)).toEqual(['pattern1_pocket'])
  })
})

// DF122 R4: inside/outside profiles own a roughing profile the same way
describe('profile roughing (DF122 R4)', () => {
  const PROFILE = {
    shape: {
      kind: 'rectangle',
      center: ['40', '25'],
      length: '50',
      width: '30',
      cornerRadius: '3',
    },
    side: 'inside',
    slotWidth: '6',
  }
  const addProfile = async (s: DesignSetup, args: object = {}) =>
    (await s.run('design.profile.add', { partId: s.partId, ...PROFILE, ...args })) as Result
  const updateProfile = async (s: DesignSetup, args: object) =>
    (await s.run('design.profile.update', {
      partId: s.partId,
      operationId: 'profile1',
      ...args,
    })) as Result

  it('on: profile1_roughing before it with its shape, side, slot, depth and tabs; off removes it', async () => {
    const s = await setup()
    await addProfile(s, { roughing: { floor: '1' } })
    expect(ids(s)).toEqual(['profile1_roughing', 'profile1'])
    const p = op(s, 'profile1')
    expect(op(s, 'profile1_roughing')).toMatchObject({
      kind: 'profile',
      name: 'Profile 1 · roughing',
      roughing: true,
      roughingOf: 'profile1',
      shape: p['shape'],
      side: 'inside',
      slotWidth: p['slotWidth'],
      tabs: p['tabs'],
    })
    await updateProfile(s, { side: 'outside', depth: '4' })
    expect(op(s, 'profile1_roughing')).toMatchObject({
      side: 'outside',
      depth: op(s, 'profile1')['depth'],
    })
    await updateProfile(s, { roughing: false })
    expect(ids(s)).toEqual(['profile1'])
    expect(op(s, 'profile1')).not.toHaveProperty('roughingPass')
  })

  it('a groove (side on) takes no roughing; a through skin is > 0; the tool fits the slot, no corner rule', async () => {
    const s = await setup()
    await addProfile(s)
    const bad = async (args: object, rule: string) => {
      const e = await s.fail(
        'design.profile.update',
        { partId: s.partId, operationId: 'profile1', ...args },
        'model.invariant',
      )
      expect(e.issues.map((i) => i.rule)).toContain(rule)
    }
    await bad({ side: 'on', roughing: true }, 'notForGroove')
    await bad({ roughing: { floor: '0' } }, 'floorRange')
    expect(ids(s)).toEqual(['profile1'])
    await updateProfile(s, { roughing: true })
    const rule = (r: Result) =>
      r.warnings.find((w) => w.code === 'dfm.toolUnfit' && w.operation === 'profile1_roughing')
        ?.params.rule
    expect(rule(await setTool(s, 'profile1_roughing', '8'))).toBe('width')
    expect(rule(await setTool(s, 'profile1_roughing', '6'))).toBeUndefined()
    const gain = await setTool(s, 'profile1', '6')
    expect(gain.warnings.some((w) => w.code === 'dfm.roughingNoGain')).toBe(true)
  })
})
