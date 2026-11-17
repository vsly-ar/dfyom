import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { newProjectDoc } from '../project/document'
import { crashCommand, generateName, renameProject, setUnitSystem } from './commands.fixture'
import { applyDocPatches } from './history'
import { expectUndoLaw, fakeClock, fakeIds, runCommand } from './testing'

const doc = newProjectDoc({ name: 'Bracket', unitSystem: 'mm' })

describe('runCommand', () => {
  it('runs a document command without a dispatcher and returns patches', () => {
    const r = runCommand(doc, renameProject, { name: 'Plate' })
    expect(expectOk(r.result)).toEqual({ name: 'Plate' })
    expect(r.next).toEqual({ name: 'Plate', unitSystem: 'mm', parts: {}, snapshots: {}, plans: {} })
    expect(r.patches).toEqual([{ op: 'replace', path: ['name'], value: 'Plate' }])
    expect(r.inversePatches).toEqual([{ op: 'replace', path: ['name'], value: 'Bracket' }])
    expect(doc.name).toBe('Bracket')
  })

  it('Err → no patches, document unchanged', () => {
    const r = runCommand(doc, renameProject, { name: ' ' })
    expectErrCode(r.result, 'model.invariant')
    expect(r.next).toBe(doc)
    expect(r.patches).toEqual([])
    expect(r.inversePatches).toEqual([])
  })

  it('malformed args → input.malformed', () => {
    const r = runCommand(doc, renameProject, { name: 3 })
    expectErrCode(r.result, 'input.malformed')
    expect(r.next).toBe(doc)
  })

  it('a stray throw → internal.unexpected, document unchanged', () => {
    const r = runCommand(doc, crashCommand, {})
    expectErrCode(r.result, 'internal.unexpected')
    expect(r.next).toBe(doc)
  })

  it('committed documents are frozen', () => {
    expect(Object.isFrozen(runCommand(doc, renameProject, { name: 'P' }).next)).toBe(true)
  })

  it('uses deterministic fake ids and clock', () => {
    const r = runCommand(doc, generateName, {}, { ids: fakeIds(), clock: fakeClock(1000) })
    expect(r.next.name).toBe('name-1@1000')
  })
})

describe('undo law', () => {
  const cases = [
    [renameProject, { name: 'Plate' }],
    [setUnitSystem, { unitSystem: 'inch' }],
    [generateName, {}],
  ] as const
  it.each(cases)('%s: apply(next, inverse) ≡ doc and apply(doc, patches) ≡ next', (def, args) => {
    expectUndoLaw(doc, def, args)
  })

  it('holds by direct patch application too', () => {
    const r = runCommand(doc, setUnitSystem, { unitSystem: 'inch' })
    expect(expectOk(applyDocPatches(r.next, r.inversePatches))).toEqual(doc)
    expect(expectOk(applyDocPatches(doc, r.patches))).toEqual(r.next)
  })
})
