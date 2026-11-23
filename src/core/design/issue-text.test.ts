// Spec: docs/conventions/ui.md#selection-and-picking (DF43): visible text names items, never ids;
// fields read in plain words, never raw keys.
import { describe, expect, it } from 'vitest'
import { fieldWords, partIssueText } from './issue-text'
import type { PartDTO } from './part.dto'

const part = {
  operations: [
    { id: 'pocket1', name: 'Pocket 1' },
    { id: 'profile1', name: 'Outline' },
    { id: 'chamfer1', name: 'Chamfer 1' },
  ],
  features: [{ id: 'clones1', name: 'Clones 1' }],
} as unknown as PartDTO

const text = (path: (string | number)[], message: string, rule = 'positive') =>
  partIssueText(part, { path, rule, message })

describe('fieldWords', () => {
  it('reads keys as words', () => {
    expect(fieldWords(['depth'])).toBe('depth')
    expect(fieldWords(['slotWidth'])).toBe('slot width')
    expect(fieldWords(['shape', 'cornerRadius'])).toBe('corner radius')
    expect(fieldWords(['shape', 'center', 0])).toBe("shape's centre X")
    expect(fieldWords(['shape', 'center', '1'])).toBe("shape's centre Y")
    expect(fieldWords(['tabs', 'positions', 1])).toBe('tab 2 position')
    expect(fieldWords(['on'])).toBe('start surface')
    expect(fieldWords([])).toBe('')
  })
})

describe('partIssueText', () => {
  it('names the operation and the field, never the id or the path', () => {
    expect(text(['operations', 'pocket1', 'depth'], 'must end above the stock bottom')).toBe(
      'Pocket 1 depth: must end above the stock bottom',
    )
    expect(text(['operations', 'profile1', 'tabs', 'positions', 0], 'must be inside')).toBe(
      'Outline tab 1 position: must be inside',
    )
    expect(text(['features', 'clones1', 'rows'], 'is empty')).toBe('Clones 1 rows: is empty')
  })

  it('an item the part no longer has reads generically', () => {
    expect(text(['operations', 'gone1', 'depth'], 'must be greater than 0')).toBe(
      'An operation depth: must be greater than 0',
    )
  })

  it('a missing surface reference does not repeat the reference id', () => {
    const msg = 'hole1.floor is not a surface of the stock or an earlier operation'
    const on = text(['operations', 'chamfer1', 'on'], msg, 'referenced')
    expect(on).toBe(
      'Chamfer 1 start surface: is not a surface of the stock or an earlier operation',
    )
    const formula = text(['operations', 'pocket1', 'depth'], msg, 'referenced')
    expect(formula).toBe(
      'Pocket 1 depth: refers to a surface that is not on the stock or an earlier operation',
    )
    expect(formula).not.toContain('hole1')
  })

  it('paths outside a named item read as words', () => {
    expect(text(['stock', 'thickness'], 'too thin')).toBe('stock thickness: too thin')
    expect(text([], 'invalid value')).toBe('invalid value')
  })
})
