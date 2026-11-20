import { describe, expect, it } from 'vitest'
import { closeNeedsProject } from './window-close'

describe('closeNeedsProject', () => {
  it('closes the project with its last window', () => {
    expect(closeNeedsProject('p1', [])).toBe('p1')
    expect(closeNeedsProject('p1', ['p2', undefined])).toBe('p1')
  })

  it('keeps the project while another window shows it', () => {
    expect(closeNeedsProject('p1', ['p1'])).toBeUndefined()
  })

  it('lets a window without a project close', () => {
    expect(closeNeedsProject(undefined, ['p1'])).toBeUndefined()
  })
})
