// Operation tool field (v0.2 A4): model, set/lock/unlock with undo, candidates, snapshot.update,
// DFM with the tool and the auto choice as the apply hook. Doc: docs/modes/design-v0.2.md#operation-tool
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { None, Some } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import type { ApplyOutcome } from '../commands/apply'
import { createDispatcher } from '../commands/dispatcher'
import { inProcessWorkers } from '../commands/jobs'
import {
  APP_HOOKS,
  createRegistry,
  designApplyWarnings,
  PROJECT_COMMANDS,
  PROJECT_QUERIES,
} from '../commands/registry'
import { fakeClock, fakeIds, uiSource } from '../commands/testing'
import type { DfmWarning } from '../geometry/model'
import { LIBRARY_COMMANDS, LIBRARY_QUERIES } from '../library/commands'
import { Library } from '../library/library'
import { createMemoryLibraryStorage } from '../library/memory-storage'
import type { ToolType } from '../library/tool.dto'
import { newProjectDoc, type UnitSystem } from '../project/document'
import { Quantity } from '../quantity/quantity'
import { testStock } from './design.fixture'
import { loadPart } from './load'
import { operationFromDTO, operationToDTO } from './operation'
import type { DesignToolDTO, OperationDTO } from './part.dto'
import { checkGeneralizedTool, designToolFromDTO, designToolToDTO, generalizedLabel } from './tool'
import { designToolAutoChoice, toolRechoicePending } from './tool-commands'

const ui = uiSource()

const rect = (length: string, width: string, cornerRadius = '4') => ({
  kind: 'rectangle',
  center: ['50', '30'],
  length,
  width,
  cornerRadius,
})

/** `library.tool.add` values (quantity strings, mm). */
function toolInput(type: ToolType, diameter: string, extra: Record<string, unknown> = {}) {
  return {
    name: `${diameter} mm ${type}`,
    type,
    diameter,
    fluteLength: '25',
    overallLength: '60',
    fluteCount: '2',
    ...(type === 'drill' && { pointAngle: '118' }),
    ...(type === 'bullNoseEndMill' && { cornerRadius: '1' }),
    ...extra,
  }
}
const aluPreset = {
  name: 'Alu',
  materialClass: 'aluminum',
  spindleSpeed: '18000',
  feedRate: '800',
  plungeRate: '200',
}

/** A project with one part on the 100 × 60 × 20 test stock, the auto choice as apply hook. */
async function setup(units: UnitSystem = 'mm', rechoice = false) {
  const library = expectOk(await Library.open(createMemoryLibraryStorage()))
  const registry = expectOk(
    createRegistry({
      commands: [...PROJECT_COMMANDS, ...LIBRARY_COMMANDS],
      queries: [...PROJECT_QUERIES, ...LIBRARY_QUERIES],
      hooks: APP_HOOKS,
      applyHooks: [designToolAutoChoice],
      applyWarnings: designApplyWarnings,
      ...(rechoice ? { pendingSources: [toolRechoicePending] } : {}),
    }),
  )
  const d = createDispatcher({
    registry,
    doc: newProjectDoc({ name: 'Bracket', unitSystem: units }),
    ids: fakeIds(),
    clock: fakeClock(Date.UTC(2026, 10, 21)),
    services: { workers: inProcessWorkers, library },
  })
  const run = async (name: string, args: object) =>
    expectOk(await d.dispatch(name, args, ui)).value as Record<string, unknown>
  const failWith = async (name: string, args: object, code: Parameters<typeof expectErrCode>[1]) =>
    expectErrCode(await d.dispatch(name, args, ui), code)
  const stock = await run('library.stock.add', { values: testStock() })
  const { partId } = (await run('design.part.add', {
    name: 'Bracket',
    stockLibraryItemId: stock['id'],
  })) as { partId: string }
  const addTool = async (type: ToolType, diameter: string, extra: Record<string, unknown> = {}) =>
    (await run('library.tool.add', { values: toolInput(type, diameter, extra) }))['id'] as string
  const op = (id: string): OperationDTO => d.doc.parts[partId]!.operations.find((o) => o.id === id)!
  const apply = async () => (await run('project.apply', {})) as unknown as ApplyOutcome
  const pocket = (extra: object = {}) =>
    run('design.pocket.add', { partId, shape: rect('40', '25'), depth: '5', ...extra })
  const warnings = () =>
    (expectOk(d.query('design.warning.list', { partId }, ui)).value as { warnings: DfmWarning[] })
      .warnings
  const candidates = (operationId: string) =>
    expectOk(d.query('design.tool.candidates', { partId, operationId }, ui)).value as {
      fitting: { toolLibraryItemId: string; reasons: string[] }[]
      unfitting: { toolLibraryItemId: string; rule: string; fluteCount: number }[]
      nearMatch: string | null
      generalized: DesignToolDTO | null
      current: { tool: DesignToolDTO; locked: boolean; fits: boolean; rule?: string } | null
    }
  const undo = () => run('history.undo', {})
  const redo = () => run('history.redo', {})
  const pending = () =>
    (
      expectOk(d.query('project.pending.get', {}, ui)).value as {
        changes: Record<string, unknown>[]
      }
    ).changes
  return {
    pending,
    d,
    library,
    partId,
    run,
    failWith,
    addTool,
    op,
    apply,
    pocket,
    warnings,
    candidates,
    undo,
    redo,
  }
}
type Setup = Awaited<ReturnType<typeof setup>>

const generalized = (type: ToolType, diameter: string, cornerRadius?: string) => ({
  kind: 'generalized',
  type,
  diameter,
  ...(cornerRadius === undefined ? {} : { cornerRadius }),
})
const lenDto = (source: string) =>
  expectOk(Quantity.parse(source, { kind: 'length', defaultUnit: 'mm' })).toDTO()
const src = (q: unknown) => (q as { source: string }).source
const toolOf = (s: Setup, id: string) => s.op(id).tool
const snapshotOf = (s: Setup, id: string) => {
  const t = toolOf(s, id)
  return t?.kind === 'specific' ? s.d.doc.snapshots[t.snapshotId] : undefined
}

describe('tool field model', () => {
  it('v0.1 records load and save unchanged (no tool keys); tool and lock round-trip', () => {
    const v01 = {
      kind: 'facing',
      id: 'facing1',
      name: 'Facing 1',
      depth: lenDto('0.5'),
    } as unknown as OperationDTO
    const op = expectOk(operationFromDTO(v01))
    expect(op.tool.isNone()).toBe(true)
    expect(op.toolLocked).toBe(false)
    expect(operationToDTO(op)).toEqual(v01)
    const withTool = { ...v01, tool: { kind: 'specific', snapshotId: 's1' }, toolLocked: true }
    expect(operationToDTO(expectOk(operationFromDTO(withTool as OperationDTO)))).toEqual(withTool)
  })

  it('a generalized tool: diameter > 0; RE only and required for a bull nose, 0 < RE < DC/2', () => {
    const q = (s: string) => expectOk(Quantity.parse(s, { kind: 'length', defaultUnit: 'mm' }))
    const deg = (s: string) => expectOk(Quantity.parse(s, { kind: 'angle', defaultUnit: 'deg' }))
    const g = (type: ToolType, d: string, re?: string, angle?: string) =>
      checkGeneralizedTool({
        kind: 'generalized',
        type,
        diameter: q(d),
        cornerRadius: re === undefined ? None : Some(q(re)),
        angle: angle === undefined ? None : Some(deg(angle)),
      })
    expectOk(g('flatEndMill', '6'))
    expectOk(g('bullNoseEndMill', '6', '1'))
    const rules = (r: ReturnType<typeof g>) =>
      expectErrCode(r, 'model.invariant').issues.map((i) => `${i.path.join('.')} ${i.rule}`)
    expect(rules(g('flatEndMill', '0'))).toEqual(['diameter positive'])
    expect(rules(g('bullNoseEndMill', '6'))).toEqual(['cornerRadius required'])
    expect(rules(g('bullNoseEndMill', '6', '3'))).toEqual(['cornerRadius range'])
    expect(rules(g('drill', '6', '1'))).toEqual(['cornerRadius notAllowed'])
    // chamfer mill (v0.4 C1): angle required, 30°–150°, and only for a chamfer mill
    expectOk(g('chamferMill', '12', undefined, '90'))
    expect(rules(g('chamferMill', '12'))).toEqual(['angle required'])
    expect(rules(g('chamferMill', '12', undefined, '160'))).toEqual(['angle range'])
    expect(rules(g('flatEndMill', '6', undefined, '90'))).toEqual(['angle notAllowed'])
    // a broken record is reported under `tool`
    const bad = {
      kind: 'facing',
      id: 'facing1',
      name: 'F',
      depth: lenDto('1'),
      tool: {
        kind: 'generalized',
        type: 'bullNoseEndMill',
        diameter: lenDto('6'),
      },
    } as unknown as OperationDTO
    expect(expectErrCode(operationFromDTO(bad), 'model.invariant').issues[0]?.path).toEqual([
      'tool',
      'cornerRadius',
    ])
    expect(designToolFromDTO({ kind: 'specific', snapshotId: 'x' }).isOk()).toBe(true)
  })

  it('a specific tool whose snapshot is missing makes the part input.malformed', async () => {
    const s = await setup()
    await s.pocket()
    const doc = produce(s.d.doc, (d) => {
      d.parts[s.partId]!.operations[0]!.tool = { kind: 'specific', snapshotId: 'gone' }
    })
    expectErrCode(loadPart(doc, s.partId, 'test'), 'input.malformed')
  })
})

describe('design.operation.tool.set / lock / unlock', () => {
  it('sets a generalized tool and locks it; undo and redo restore', async () => {
    const s = await setup()
    await s.pocket()
    const before = s.d.doc
    const r = await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'pocket1',
      tool: generalized('flatEndMill', '1/4"'),
    })
    expect(r).toHaveProperty('warnings')
    expect(s.op('pocket1')).toMatchObject({
      tool: { kind: 'generalized', type: 'flatEndMill' },
      toolLocked: true,
    })
    expect(src((toolOf(s, 'pocket1') as { diameter: unknown }).diameter)).toBe('1/4"')
    const after = s.d.doc
    await s.undo()
    expect(s.d.doc).toEqual(before)
    await s.redo()
    expect(s.d.doc).toEqual(after)
  })

  it('a library tool takes a snapshot in the command (reused while current); undo removes it', async () => {
    const s = await setup()
    const id = await s.addTool('flatEndMill', '6')
    await s.pocket()
    await s.pocket()
    const set = (operationId: string) =>
      s.run('design.operation.tool.set', {
        partId: s.partId,
        operationId,
        tool: { kind: 'specific', toolLibraryItemId: id },
      })
    await set('pocket1')
    expect(snapshotOf(s, 'pocket1')).toMatchObject({ kind: 'tool', libraryItemId: id })
    await set('pocket2')
    expect(toolOf(s, 'pocket2')).toEqual(toolOf(s, 'pocket1'))
    const snapshots = Object.keys(s.d.doc.snapshots)
    expect(snapshots).toHaveLength(2) // stock + one tool
    // replacing the tool of both drops the unused snapshot
    for (const o of ['pocket1', 'pocket2'])
      await s.run('design.operation.tool.set', {
        partId: s.partId,
        operationId: o,
        tool: generalized('flatEndMill', '6'),
      })
    expect(Object.keys(s.d.doc.snapshots)).toHaveLength(1)
    await s.undo()
    await s.undo()
    expect(Object.keys(s.d.doc.snapshots)).toHaveLength(2)
  })

  it('errors: unknown or non-tool library item → input.malformed; invalid generalized values → model.invariant', async () => {
    const s = await setup()
    await s.pocket()
    const args = (tool: object) => ({ partId: s.partId, operationId: 'pocket1', tool })
    const e = await s.failWith(
      'design.operation.tool.set',
      args({ kind: 'specific', toolLibraryItemId: 'stock-1' }),
      'input.malformed',
    )
    expect(e.issues[0]?.path).toEqual(['tool', 'toolLibraryItemId'])
    const m = await s.failWith(
      'design.operation.tool.set',
      args(generalized('bullNoseEndMill', '6', '4')),
      'model.invariant',
    )
    expect(m.issues[0]).toMatchObject({ path: ['tool', 'cornerRadius'], rule: 'range' })
    await s.failWith(
      'design.operation.tool.set',
      args(generalized('flatEndMill', 'abc')),
      'quantity.syntax',
    )
  })

  it('a generalized chamfer mill (v0.4 C1): angle stored, labelled; it does not fit a pocket', async () => {
    const s = await setup()
    await s.pocket()
    const args = (tool: object) => ({ partId: s.partId, operationId: 'pocket1', tool })
    const r = await s.run(
      'design.operation.tool.set',
      args({ ...generalized('chamferMill', '12'), angle: '90' }),
    )
    const tool = toolOf(s, 'pocket1') as DesignToolDTO
    expect(tool).toMatchObject({ kind: 'generalized', type: 'chamferMill' })
    expect(src((tool as { angle: unknown }).angle)).toBe('90')
    const g = expectOk(designToolFromDTO(tool))
    expect(g.kind === 'generalized' && generalizedLabel(g)).toBe('90° chamfer mill Ø12 mm')
    expect(designToolToDTO(g)).toEqual(tool)
    expect((r as { warnings: DfmWarning[] }).warnings.map((w) => w.code)).toContain('dfm.toolUnfit')
    const m = await s.failWith(
      'design.operation.tool.set',
      args(generalized('chamferMill', '12')),
      'model.invariant',
    )
    expect(m.issues[0]).toMatchObject({ path: ['tool', 'angle'], rule: 'required' })
  })

  it('lock pins the current tool (none yet: model.invariant); unlock keeps the tool', async () => {
    const s = await setup()
    await s.pocket()
    const op = { partId: s.partId, operationId: 'pocket1' }
    const e = await s.failWith('design.operation.tool.lock', op, 'model.invariant')
    expect(e.issues[0]?.rule).toBe('noTool')
    await s.apply()
    const chosen = toolOf(s, 'pocket1')
    expect(chosen).toBeDefined()
    expect(s.op('pocket1').toolLocked).toBeUndefined()
    await s.run('design.operation.tool.lock', op)
    expect(s.op('pocket1')).toMatchObject({ tool: chosen, toolLocked: true })
    await s.run('design.operation.tool.unlock', op)
    expect(s.op('pocket1').toolLocked).toBeUndefined()
    expect(toolOf(s, 'pocket1')).toEqual(chosen)
    await s.undo()
    expect(s.op('pocket1').toolLocked).toBe(true)
  })

  it('design.<kind>.add with a tool locks it and returns it; update keeps the tool', async () => {
    const s = await setup()
    const r = await s.pocket({ tool: generalized('flatEndMill', '6') })
    expect(r).toMatchObject({
      operationId: 'pocket1',
      tool: { kind: 'generalized', type: 'flatEndMill' },
      toolLocked: true,
    })
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '7' })
    expect(s.op('pocket1')).toMatchObject({ tool: { kind: 'generalized' }, toolLocked: true })
  })
})

describe('DFM with the tool through the commands', () => {
  it('a locked tool that stops fitting warns dfm.toolUnfit; the parameters stay', async () => {
    const s = await setup()
    await s.addTool('flatEndMill', '6')
    await s.pocket({ tool: generalized('flatEndMill', '6') })
    expect(s.warnings().map((w) => w.code)).not.toContain('dfm.toolUnfit')
    const r = await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      shape: rect('40', '25', '2'),
    })
    const w = (r['warnings'] as DfmWarning[]).find((x) => x.code === 'dfm.toolUnfit')
    expect(w).toMatchObject({ parameter: 'tool', params: { rule: 'cornerRadius', locked: true } })
    expect(w?.message).toContain('6 mm flat end mill')
  })

  it('a generalized tool missing from the library: dfm.toolNotInLibrary; a specific tool reach drives dfm.reach', async () => {
    const s = await setup()
    await s.pocket({ tool: generalized('flatEndMill', '8') })
    expect(s.warnings().find((w) => w.code === 'dfm.toolNotInLibrary')).toMatchObject({
      severity: 'info',
      params: { tool: '8 mm flat end mill' },
    })
    const short = await s.addTool('flatEndMill', '6', { stickout: '12' })
    await s.addTool('flatEndMill', '5', { stickout: '30' })
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '15' })
    // generalized 8 mm: no matching library tool → no reach reading
    expect(s.warnings().map((w) => w.code)).not.toContain('dfm.reach')
    await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'pocket1',
      tool: { kind: 'specific', toolLibraryItemId: short },
    })
    expect(s.warnings().find((w) => w.code === 'dfm.reach')).toMatchObject({
      params: { depth: 15, reach: 12 },
    })
  })
})

describe('design.tool.candidates', () => {
  it('fitting library tools in auto-choice order, the generalized pick and the current fit', async () => {
    const s = await setup()
    const small = await s.addTool('flatEndMill', '4')
    const big = await s.addTool('flatEndMill', '8')
    const preset = await s.addTool('flatEndMill', '3', { presets: [aluPreset] })
    await s.addTool('flatEndMill', '10') // radius 5 > cornerRadius 4
    await s.addTool('drill', '6')
    await s.pocket()
    const c = s.candidates('pocket1')
    expect(c.fitting.map((f) => f.toolLibraryItemId)).toEqual([preset, big, small])
    expect(c.fitting[0]?.reasons[0]).toBe('has a preset for aluminium')
    expect(c.generalized).toMatchObject({ kind: 'generalized', type: 'flatEndMill' })
    expect(src((c.generalized as { diameter: unknown }).diameter)).toBe('8 mm')
    expect(c.current).toBeNull()
    await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'pocket1',
      tool: generalized('flatEndMill', '12'),
    })
    expect(s.candidates('pocket1').current).toMatchObject({
      locked: true,
      fits: false,
      rule: 'cornerRadius',
    })
  })

  it('lists the library tools of the type that do not fit, nearest first, and the near match (DF42)', async () => {
    const s = await setup()
    const wexme = await s.addTool('flatEndMill', '6.22', { fluteCount: '1' })
    const eight = await s.addTool('flatEndMill', '8')
    await s.addTool('bullNoseEndMill', '6') // a profile needs a flat end mill: not listed
    await s.addTool('drill', '6') // nor a drill
    // a 6 mm slot (given: by default it would follow the library, DF51): only a tool ≤ 6 mm
    // fits, so auto takes the generalized 6 mm
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: rect('84', '44', '5'),
      slotWidth: '6',
    })
    await s.apply()
    expect(toolOf(s, 'profile1')).toMatchObject({ kind: 'generalized', type: 'flatEndMill' })
    const c = s.candidates('profile1')
    expect(c.fitting).toEqual([])
    expect(c.unfitting.map((u) => [u.toolLibraryItemId, u.rule, u.fluteCount])).toEqual([
      [wexme, 'width', 1],
      [eight, 'width', 2],
    ])
    // 6.22 mm is within 20 % of 6 mm; offered, never taken: the slot is 6 mm wide
    expect(c.nearMatch).toBe(wexme)
    expect(s.warnings().some((w) => w.code === 'dfm.toolNotInLibrary')).toBe(true)
    // the agent's way: tool.set takes the listed id, locks it, and the fit check warns
    await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'profile1',
      tool: { kind: 'specific', toolLibraryItemId: wexme },
    })
    expect(s.op('profile1').toolLocked).toBe(true)
    expect(s.warnings().find((w) => w.code === 'dfm.toolUnfit')).toMatchObject({
      params: { rule: 'width', toolDiameter: 6.22, size: 6 },
    })
    // a specific tool has no near match
    expect(s.candidates('profile1').nearMatch).toBeNull()
  })

  it('the dogfood case: a 6.42 mm slot keeps its generalized 6 mm; the 6.22 mm tool fits and is the near match', async () => {
    const s = await setup()
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: rect('84', '44', '5'),
      slotWidth: '6.42',
    })
    await s.apply()
    // the largest standard size ≤ 6.42 mm (the series has no 6.42; next is 8)
    expect(src((toolOf(s, 'profile1') as { diameter: unknown }).diameter)).toBe('6 mm')
    const wexme = await s.addTool('flatEndMill', '6.22', {
      fluteCount: '1',
      fluteLength: '20',
      stickout: '30.9',
      shankDiameter: '6.35',
    })
    const c = s.candidates('profile1')
    // a library edit changes no tool; the library tool is listed and offered
    expect(c.fitting.map((f) => f.toolLibraryItemId)).toEqual([wexme])
    expect(c.nearMatch).toBe(wexme)
    // DF54: the next Apply of an edit of the operation takes the library tool
    await s.run('design.profile.update', {
      partId: s.partId,
      operationId: 'profile1',
      tabs: { count: '3' },
    })
    const out = await s.apply()
    expect(snapshotOf(s, 'profile1')).toMatchObject({ libraryItemId: wexme })
    expect(out.toolChanges).toEqual([
      expect.objectContaining({ operationId: 'profile1', reason: 'libraryFits' }),
    ])
  })

  it('near match: same type (bull nose: same RE), within 20 %, an exact match none', async () => {
    const s = await setup()
    await s.addTool('flatEndMill', '7.5') // 25 % off the 6 mm: too far
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: rect('84', '44', '5'),
      slotWidth: '6',
    })
    await s.apply()
    const near = () => s.candidates('profile1').nearMatch
    expect(near()).toBeNull()
    const close = await s.addTool('flatEndMill', '6.35')
    expect(near()).toBe(close)
    await s.addTool('flatEndMill', '6.005') // matches within 0.01 mm: the plan takes it
    expect(near()).toBeNull()
  })
})

describe('auto choice (apply hook design.toolAutoChoice)', () => {
  it('prefers a fitting library tool (preset → largest → id); reports from: null, reason unset', async () => {
    const s = await setup()
    await s.addTool('flatEndMill', '6')
    const preset = await s.addTool('flatEndMill', '4', { presets: [aluPreset] })
    await s.pocket()
    const out = await s.apply()
    expect(snapshotOf(s, 'pocket1')).toMatchObject({ libraryItemId: preset })
    expect(s.op('pocket1').toolLocked).toBeUndefined()
    expect(out.toolChanges).toEqual([
      {
        partId: s.partId,
        operationId: 'pocket1',
        from: null,
        to: toolOf(s, 'pocket1'),
        reason: 'unset',
      },
    ])
  })

  it('no fitting library tool: the largest fitting standard size (bull nose RE = floorRadius; drill = hole)', async () => {
    const s = await setup()
    await s.addTool('drill', '3') // fits nothing below
    await s.pocket({ floorRadius: '1' })
    await s.run('design.drilling.add', { partId: s.partId, center: ['10', '10'], diameter: '5.5' })
    await s.run('design.drilling.add', {
      partId: s.partId,
      center: ['20', '10'],
      diameter: '7',
      bottom: 'flat',
      depth: '4',
    })
    await s.run('design.profile.add', { partId: s.partId, shape: rect('84', '44', '5') })
    await s.apply()
    const g = (id: string) =>
      toolOf(s, id) as { type: string; diameter: unknown; cornerRadius?: unknown }
    expect(g('pocket1')).toMatchObject({ kind: 'generalized', type: 'bullNoseEndMill' })
    expect([src(g('pocket1').diameter), src(g('pocket1').cornerRadius)]).toEqual(['8 mm', '1 mm'])
    expect([g('drill1').type, src(g('drill1').diameter)]).toEqual(['drill', '5.5 mm'])
    // flat bottom: helical boring, the largest standard end mill in (3.5, 7)
    expect([g('drill2').type, src(g('drill2').diameter)]).toEqual(['flatEndMill', '6 mm'])
    expect([g('profile1').type, src(g('profile1').diameter)]).toEqual(['flatEndMill', '6 mm'])
  })

  it('inch projects choose from the inch series', async () => {
    const s = await setup('inch')
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: rect('2', '1', '1/8'),
      depth: '1/4',
    })
    await s.apply()
    expect(src((toolOf(s, 'pocket1') as { diameter: unknown }).diameter)).toBe('1/4"')
  })

  it('keeps an unlocked tool that still fits; replaces one that stops fitting (reason = failed rule); undo restores it', async () => {
    const s = await setup()
    await s.pocket()
    await s.apply()
    const first = toolOf(s, 'pocket1')
    expect(src((first as { diameter: unknown }).diameter)).toBe('8 mm')
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '6' })
    expect((await s.apply()).toolChanges).toEqual([])
    expect(toolOf(s, 'pocket1')).toEqual(first)
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      shape: rect('40', '25', '2'),
    })
    const out = await s.apply()
    expect(out.toolChanges).toEqual([
      expect.objectContaining({ operationId: 'pocket1', from: first, reason: 'cornerRadius' }),
    ])
    expect(src((toolOf(s, 'pocket1') as { diameter: unknown }).diameter)).toBe('4 mm')
    await s.undo()
    expect(toolOf(s, 'pocket1')).toEqual(first)
  })

  it('never changes a locked tool; unlocking replaces it on the next Apply if it does not fit', async () => {
    const s = await setup()
    await s.pocket({ tool: generalized('flatEndMill', '12') })
    expect((await s.apply()).toolChanges).toEqual([])
    expect(src((toolOf(s, 'pocket1') as { diameter: unknown }).diameter)).toBe('12')
    await s.run('design.operation.tool.unlock', { partId: s.partId, operationId: 'pocket1' })
    const out = await s.apply()
    expect(out.toolChanges[0]).toMatchObject({ reason: 'cornerRadius' })
    expect(src((toolOf(s, 'pocket1') as { diameter: unknown }).diameter)).toBe('8 mm')
  })

  it('nothing fits at all: the current tool is kept and dfm.toolUnfit warns; the Apply succeeds', async () => {
    const s = await setup()
    await s.pocket({ shape: rect('40', '25', '0.2') })
    const out = await s.apply()
    expect(out.toolChanges).toEqual([])
    expect(toolOf(s, 'pocket1')).toBeUndefined()
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      shape: rect('40', '25', '4'),
    })
    await s.apply()
    const chosen = toolOf(s, 'pocket1')
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      shape: rect('40', '25', '0'),
    })
    expect((await s.apply()).toolChanges).toEqual([])
    expect(toolOf(s, 'pocket1')).toEqual(chosen)
    expect(s.warnings().find((w) => w.code === 'dfm.toolUnfit')).toMatchObject({
      params: { locked: false },
    })
  })

  it('checks against an unlocked tool with pending changes are marked pendingApply until Apply', async () => {
    const s = await setup()
    await s.pocket({ tool: generalized('flatEndMill', '12') })
    await s.apply()
    const unfit = () => s.warnings().find((w) => w.code === 'dfm.toolUnfit')
    expect(unfit()).toMatchObject({ params: { locked: true } })
    expect(unfit()).not.toHaveProperty('pendingApply') // locked: final
    await s.run('design.operation.tool.unlock', { partId: s.partId, operationId: 'pocket1' })
    expect(unfit()).toMatchObject({ params: { locked: false }, pendingApply: true })
    await s.apply()
    expect(unfit()).toBeUndefined()
  })

  it('opening makes auto tools pending only when Apply would change them (X2 F6)', async () => {
    const s = await setup()
    await s.addTool('flatEndMill', '8')
    await s.pocket() // never applied: no tool yet
    await s.pocket({ tool: generalized('flatEndMill', '6') }) // locked: never re-chosen
    await s.pocket({ shape: rect('40', '25', '0') }) // nothing fits: not pending (DF52)
    const registry = expectOk(
      createRegistry({
        commands: [...PROJECT_COMMANDS, ...LIBRARY_COMMANDS],
        queries: [...PROJECT_QUERIES, ...LIBRARY_QUERIES],
        applyHooks: [designToolAutoChoice],
        pendingSources: [toolRechoicePending],
      }),
    )
    const d = createDispatcher({
      registry,
      doc: s.d.doc,
      ids: fakeIds(),
      clock: fakeClock(0),
      services: { workers: inProcessWorkers, library: s.library },
    })
    const pending = () =>
      expectOk(d.query('project.pending.get', {}, ui)).value as { changes: unknown[] }
    expect(pending().changes).toEqual([
      expect.objectContaining({
        kind: 'design',
        partId: s.partId,
        operationId: 'pocket1',
        field: 'tool',
        label: 'Pocket 1: tool',
        source: { kind: 'system', id: 'open' },
      }),
    ])
    const out = expectOk(await d.dispatch('project.apply', {}, ui)).value as ApplyOutcome
    expect(out.toolChanges).toEqual([
      expect.objectContaining({ operationId: 'pocket1', from: null, reason: 'unset' }),
    ])
    expect(pending().changes).toEqual([])
  })

  it('X2 F6: a library tool added later re-chooses an unlocked generalized tool on the next Apply, once', async () => {
    const s = await setup('mm', true)
    await s.pocket()
    await s.pocket({ tool: generalized('flatEndMill', '8') }) // locked
    await s.apply()
    expect(toolOf(s, 'pocket1')).toMatchObject({ kind: 'generalized' })
    expect(s.pending()).toEqual([])
    const six = await s.addTool('flatEndMill', '6')
    expect(s.pending()).toEqual([
      expect.objectContaining({ operationId: 'pocket1', field: 'tool', label: 'Pocket 1: tool' }),
    ])
    const out = await s.apply()
    expect(out.toolChanges).toEqual([
      expect.objectContaining({ operationId: 'pocket1', reason: 'libraryFits' }),
    ])
    expect(snapshotOf(s, 'pocket1')).toMatchObject({ libraryItemId: six })
    expect(toolOf(s, 'pocket2')).toMatchObject({ kind: 'generalized' })
    expect(s.d.doc.parts[s.partId]!.operations[1]!.toolLocked).toBe(true)
    // stable: nothing left to re-choose, and an Apply now changes nothing
    expect(s.pending()).toEqual([])
    // one undoable step: undo brings the generalized tool and the key back
    await s.undo()
    expect(toolOf(s, 'pocket1')).toMatchObject({ kind: 'generalized' })
    expect(s.pending()).toEqual([
      expect.objectContaining({ operationId: 'pocket1', field: 'tool' }),
    ])
  })

  it('X2 F6: an operation pending through an edit gets no second key', async () => {
    const s = await setup('mm', true)
    await s.pocket()
    await s.apply()
    await s.addTool('flatEndMill', '6')
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '6' })
    expect(s.pending()).toEqual([
      expect.objectContaining({ operationId: 'pocket1', field: 'depth' }),
    ])
    expect((await s.apply()).toolChanges).toEqual([
      expect.objectContaining({ operationId: 'pocket1', reason: 'libraryFits' }),
    ])
  })

  it('X2 F6: a removed library tool gives way to another library tool; with none it stays', async () => {
    const s = await setup('mm', true)
    const six = await s.addTool('flatEndMill', '6')
    await s.pocket()
    await s.apply()
    expect(snapshotOf(s, 'pocket1')).toMatchObject({ libraryItemId: six })
    const four = await s.addTool('flatEndMill', '4')
    expect(s.pending()).toEqual([]) // the 6 mm still fits and is in the library: kept
    const revision = (id: string) =>
      (expectOk(s.d.query('library.tool.get', { id }, ui)).value as { revision: number }).revision
    await s.run('library.tool.remove', { id: six, revision: revision(six), confirm: true })
    expect(s.pending()).toEqual([
      expect.objectContaining({ operationId: 'pocket1', field: 'tool' }),
    ])
    const out = await s.apply()
    expect(out.toolChanges).toEqual([
      expect.objectContaining({ operationId: 'pocket1', reason: 'libraryRemoved' }),
    ])
    expect(snapshotOf(s, 'pocket1')).toMatchObject({ libraryItemId: four })
    // the last one removed: nothing else fits, the snapshot stays (Plan uses its copy)
    await s.run('library.tool.remove', { id: four, revision: revision(four), confirm: true })
    expect(s.pending()).toEqual([])
    expect(snapshotOf(s, 'pocket1')).toMatchObject({ libraryItemId: four })
  })

  it('X2 F6: a locked library tool stays when it is removed from the library', async () => {
    const s = await setup('mm', true)
    const six = await s.addTool('flatEndMill', '6')
    await s.addTool('flatEndMill', '4')
    await s.pocket({ tool: { kind: 'specific', toolLibraryItemId: six } })
    await s.apply()
    const item = expectOk(s.d.query('library.tool.get', { id: six }, ui)).value as {
      revision: number
    }
    await s.run('library.tool.remove', { id: six, revision: item.revision, confirm: true })
    expect(s.pending()).toEqual([])
    expect(snapshotOf(s, 'pocket1')).toMatchObject({ libraryItemId: six })
  })

  it('replacing a library tool drops its snapshot when no operation uses it', async () => {
    const s = await setup()
    await s.addTool('flatEndMill', '8')
    await s.pocket()
    await s.apply()
    const old = toolOf(s, 'pocket1') as { snapshotId: string }
    expect(s.d.doc.snapshots[old.snapshotId]).toBeDefined()
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      shape: rect('40', '25', '2'),
    })
    await s.apply()
    expect(toolOf(s, 'pocket1')).toMatchObject({ kind: 'generalized' })
    expect(s.d.doc.snapshots[old.snapshotId]).toBeUndefined()
  })
})

describe('design.snapshot.update', () => {
  it('a tool snapshot takes the library values (lock kept); undo restores; unchanged is a no-op', async () => {
    const s = await setup()
    const id = await s.addTool('flatEndMill', '6')
    await s.pocket({ tool: { kind: 'specific', toolLibraryItemId: id } })
    const snapId = (toolOf(s, 'pocket1') as { snapshotId: string }).snapshotId
    const before = s.d.doc
    await s.run('design.snapshot.update', { snapshotId: snapId })
    expect(s.d.doc).toBe(before)
    const item = expectOk(s.d.query('library.tool.get', { id }, ui)).value as { revision: number }
    await s.run('library.tool.update', {
      id,
      revision: item.revision,
      values: toolInput('flatEndMill', '6', { name: 'renamed', stickout: '30' }),
    })
    // library edits never change the design's copy
    expect(snapshotOf(s, 'pocket1')).toMatchObject({ values: { name: '6 mm flatEndMill' } })
    const r = await s.run('design.snapshot.update', { snapshotId: snapId })
    expect(r).toHaveProperty('warnings')
    expect(snapshotOf(s, 'pocket1')).toMatchObject({ values: { name: 'renamed' } })
    expect(s.op('pocket1').toolLocked).toBe(true)
    await s.undo()
    expect(snapshotOf(s, 'pocket1')).toMatchObject({ values: { name: '6 mm flatEndMill' } })
  })

  it('the stock snapshot too; unknown snapshot or removed library item → input.malformed', async () => {
    const s = await setup()
    const stockSnap = s.d.doc.parts[s.partId]!.stock
    const stockId = s.d.doc.snapshots[stockSnap]!.libraryItemId
    const item = expectOk(s.d.query('library.stock.get', { id: stockId }, ui)).value as {
      revision: number
    }
    await s.run('library.stock.update', {
      id: stockId,
      revision: item.revision,
      values: testStock('25'),
    })
    await s.run('design.snapshot.update', { snapshotId: stockSnap })
    expect(src((s.d.doc.snapshots[stockSnap]!.values as { thickness: unknown }).thickness)).toBe(
      '25',
    )
    const e = await s.failWith('design.snapshot.update', { snapshotId: 'nope' }, 'input.malformed')
    expect(e.issues[0]?.rule).toBe('unknownSnapshot')
    await s.run('library.stock.remove', { id: stockId, revision: 2, confirm: true })
    const r = await s.failWith(
      'design.snapshot.update',
      { snapshotId: stockSnap },
      'input.malformed',
    )
    expect(r.issues[0]?.rule).toBe('unknownItem')
  })
})

// Doc: docs/modes/design-v0.4.md#implementation-c2 (auto tool choice of a chamfer)
describe('auto choice for a chamfer', () => {
  const chamfered = async (s: Setup) => {
    await s.run('design.drilling.add', { partId: s.partId, center: ['30', '30'], diameter: '6' })
    await s.run('design.chamfer.add', { partId: s.partId, edgeOf: 'drill1' })
  }

  it('takes a fitting library chamfer mill of the chamfer angle', async () => {
    const s = await setup()
    await s.addTool('chamferMill', '12', { angle: '60' })
    const v90 = await s.addTool('chamferMill', '10', { angle: '90' })
    await chamfered(s)
    await s.apply()
    expect(snapshotOf(s, 'chamfer1')).toMatchObject({ libraryItemId: v90 })
  })

  it('falls back to a generalized chamfer mill of the chamfer angle', async () => {
    const s = await setup()
    await chamfered(s)
    await s.apply()
    const t = toolOf(s, 'chamfer1') as { kind: string; type: string; angle?: unknown }
    expect(t).toMatchObject({ kind: 'generalized', type: 'chamferMill' })
    expect(src(t.angle)).toBe('90°')
  })
})

// Doc: docs/modes/design-v0.2.md#tool-choice-fixes-df51-df52-df54-df55 (agent test TG #232)
describe('tool choice fixes (DF51, DF52, DF54, DF55)', () => {
  /** The user's 1/4″ end mills: wexme 1F (stickout 31) and the extralong (stickout 62). */
  const quarterInch = async (s: Setup, wexmeStickout = '31') => ({
    wexme: await s.addTool('flatEndMill', '6.22', {
      name: 'wexme 1/4 1F',
      fluteCount: '1',
      fluteLength: '22',
      stickout: wexmeStickout,
      overallLength: '50',
    }),
    extralong: await s.addTool('flatEndMill', '6.31', {
      name: 'extralong 1/4',
      fluteLength: '45',
      stickout: '62',
      overallLength: '100',
    }),
  })
  const slot = (s: Setup) => src((s.op('profile1') as { slotWidth?: unknown }).slotWidth)
  const profile = (s: Setup, extra: object = {}) =>
    s.run('design.profile.add', { partId: s.partId, shape: rect('84', '44', '5'), ...extra })

  it('DF51: the default slot widens to the narrowest wider library end mill that fits', async () => {
    const s = await setup()
    const { wexme } = await quarterInch(s)
    await profile(s)
    expect(slot(s)).toBe('6.22 mm')
    await s.apply()
    // 6.31 is wider than the 6.22 mm slot: the wexme is the only fit
    expect(snapshotOf(s, 'profile1')).toMatchObject({ libraryItemId: wexme })
    expect(s.warnings().filter((w) => w.parameter === 'tool')).toEqual([])
  })

  it('DF51: a narrower tool that does not reach is skipped; given, fitting or no tools keep it', async () => {
    const s = await setup()
    // 15 mm stickout: short of the 20 mm stock + breakthrough
    const { extralong } = await quarterInch(s, '15')
    await profile(s)
    expect(slot(s)).toBe('6.31 mm')
    await s.apply()
    expect(snapshotOf(s, 'profile1')).toMatchObject({ libraryItemId: extralong })
    // a given slot width is the user's
    const given = await setup()
    await quarterInch(given)
    await profile(given, { slotWidth: '6' })
    expect(slot(given)).toBe('6')
    // a library tool fits 6 mm: the default stays
    const fitting = await setup()
    await quarterInch(fitting)
    await fitting.addTool('flatEndMill', '3.175')
    await profile(fitting)
    expect(slot(fitting)).toBe('6 mm')
    // an empty library: the default
    const empty = await setup()
    await profile(empty)
    expect(slot(empty)).toBe('6 mm')
  })

  it('DF51: inch projects round up to 0.001″; a given wider flat end mill sets the slot', async () => {
    const s = await setup('inch')
    // the 1/4″ default slot takes both 1/4″ tools
    await quarterInch(s)
    await profile(s)
    expect(slot(s)).toBe('1/4"')
    const wide = await setup('inch')
    await wide.addTool('flatEndMill', '6.5')
    await profile(wide)
    // 6.5 mm = 0.25591″
    expect(slot(wide)).toBe('0.256"')
    const t = await setup()
    const { extralong } = await quarterInch(t)
    await profile(t, { tool: { kind: 'specific', toolLibraryItemId: extralong } })
    expect(slot(t)).toBe('6.31 mm')
    expect(t.warnings().filter((w) => w.code === 'dfm.toolUnfit')).toEqual([])
  })

  it('DF52: an operation no tool fits gets none and dfm.noFittingTool names the rule', async () => {
    const s = await setup()
    await s.addTool('flatEndMill', '6')
    const added = (await s.pocket({ shape: rect('40', '25', '0') })) as { warnings: DfmWarning[] }
    expect(added.warnings.find((w) => w.code === 'dfm.noFittingTool')).toMatchObject({
      operation: 'pocket1',
      parameter: 'tool',
      severity: 'warning',
      params: { rule: 'cornerRadius', cornerRadius: 0, tool: '1 mm flat end mill' },
    })
    const out = await s.apply()
    expect(out.toolChanges).toEqual([])
    expect(s.op('pocket1').tool).toBeUndefined()
    // rounding the corners makes a tool fit: the warning goes, Apply chooses one
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      shape: rect('40', '25', '3'),
    })
    expect(s.warnings().some((w) => w.code === 'dfm.noFittingTool')).toBe(false)
    await s.apply()
    expect(s.op('pocket1').tool).toBeDefined()
  })

  it('DF54: a hole edited so a library end mill fits drops its generalized tool', async () => {
    const s = await setup()
    const sixteenth = await s.addTool('flatEndMill', '1.5875')
    await s.run('design.drilling.add', {
      partId: s.partId,
      center: ['20', '20'],
      diameter: '1.33',
      bottom: 'flat',
      depth: '3',
    })
    await s.apply()
    // 1.5875 is wider than the Ø 1.33 hole: the generalized 1 mm bores it
    expect(toolOf(s, 'drill1')).toMatchObject({ kind: 'generalized', type: 'flatEndMill' })
    await s.run('design.drilling.update', {
      partId: s.partId,
      operationId: 'drill1',
      diameter: '1.6',
    })
    const out = await s.apply()
    expect(snapshotOf(s, 'drill1')).toMatchObject({ libraryItemId: sixteenth })
    expect(out.toolChanges).toEqual([
      expect.objectContaining({ operationId: 'drill1', reason: 'libraryFits' }),
    ])
    expect(s.warnings().some((w) => w.code === 'dfm.toolNotInLibrary')).toBe(false)
    // a locked generalized tool stays
    await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'drill1',
      tool: generalized('flatEndMill', '1'),
    })
    await s.run('design.drilling.update', { partId: s.partId, operationId: 'drill1', depth: '4' })
    await s.apply()
    expect(toolOf(s, 'drill1')).toMatchObject({ kind: 'generalized' })
  })

  it('DF55: within a size the shortest reach wins, the size first', async () => {
    const s = await setup()
    const { wexme, extralong } = await quarterInch(s)
    const eighth = await s.addTool('flatEndMill', '3.175', { stickout: '12' })
    await s.run('design.facing.add', { partId: s.partId, depth: '1' })
    await s.apply()
    expect(snapshotOf(s, 'facing1')).toMatchObject({ libraryItemId: wexme })
    const c = s.candidates('facing1')
    expect(c.fitting.map((f) => f.toolLibraryItemId)).toEqual([wexme, extralong, eighth])
    expect(c.fitting[0]!.reasons).toContain('stickout 31 mm')
  })
})
