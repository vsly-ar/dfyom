import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { newProjectDoc, parseProjectDoc } from './document'

describe('ProjectDoc', () => {
  it('starts as a plain JSON DTO with a name and unit system', () => {
    const doc = newProjectDoc({ name: 'Bracket', unitSystem: 'inch' })
    expect(doc).toEqual({ name: 'Bracket', unitSystem: 'inch' })
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc)
  })

  it('is deeply frozen so committed snapshots cannot be mutated', () => {
    expect(Object.isFrozen(newProjectDoc({ name: 'A', unitSystem: 'mm' }))).toBe(true)
  })

  it('parses untrusted data by shape', () => {
    expect(expectOk(parseProjectDoc({ name: 'A', unitSystem: 'mm' }, 'load'))).toEqual({
      name: 'A',
      unitSystem: 'mm',
    })
    const e = expectErrCode(
      parseProjectDoc({ name: 'A', unitSystem: 'cm' }, 'load'),
      'input.malformed',
    )
    expect(e.issues.map((i) => i.path.join('.'))).toEqual(['unitSystem'])
  })
})
