import { describe, expect, it } from 'vitest'
import { newProjectDoc } from '../core/project/document'
import {
  libraryHandlesMenuAction,
  libraryProjectContext,
  parseLibraryTarget,
  parseLibraryWindowState,
  sameProjectContext,
} from './library-context'

describe('parseLibraryTarget', () => {
  it('keeps a known tab and an item id, drops anything else', () => {
    expect(parseLibraryTarget({ kind: 'tool', itemId: 'tool-1' })).toEqual({
      kind: 'tool',
      itemId: 'tool-1',
    })
    expect(parseLibraryTarget({ kind: 'holder', itemId: 3 })).toEqual({})
    expect(parseLibraryTarget('tool')).toEqual({})
    expect(parseLibraryTarget(undefined)).toEqual({})
  })
})

describe('parseLibraryWindowState', () => {
  it('accepts a draft name or null and a tab', () => {
    expect(parseLibraryWindowState({ draft: 'Flat 6', tab: 'tool' })).toEqual({
      draft: 'Flat 6',
      tab: 'tool',
    })
    expect(parseLibraryWindowState({ draft: null, tab: 'stock' })).toEqual({
      draft: null,
      tab: 'stock',
    })
    expect(parseLibraryWindowState({ draft: 1, tab: 'tool' })).toBeUndefined()
    expect(parseLibraryWindowState({ draft: null, tab: 'x' })).toBeUndefined()
  })
})

describe('libraryProjectContext', () => {
  it('names the project, its unit system and the items it uses', () => {
    const doc = newProjectDoc({ name: 'Bracket', unitSystem: 'inch' })
    const c = libraryProjectContext('p1', doc)
    expect(c).toEqual({ key: 'p1', name: 'Bracket', unitSystem: 'inch', used: [] })
    expect(sameProjectContext(c, { ...c, used: [] })).toBe(true)
    expect(sameProjectContext(c, { ...c, used: ['tool-1'] })).toBe(false)
    expect(sameProjectContext(c, null)).toBe(false)
    expect(sameProjectContext(null, null)).toBe(true)
  })
})

describe('libraryHandlesMenuAction', () => {
  it('runs save, apply, text undo and the shortcut list itself; the rest goes to a project window', () => {
    expect(libraryHandlesMenuAction('project.save')).toBe(true)
    expect(libraryHandlesMenuAction('project.apply')).toBe(true)
    expect(libraryHandlesMenuAction('edit.undo')).toBe(true)
    expect(libraryHandlesMenuAction('project.new')).toBe(false)
    expect(libraryHandlesMenuAction('mode.plan')).toBe(false)
  })
})
