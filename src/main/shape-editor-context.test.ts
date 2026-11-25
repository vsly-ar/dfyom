// The Shape Editor window's pure plumbing: requests, targets, closing with the project, menu items.
// Doc: docs/conventions/ui.md#shape-editor-window-df94
import { describe, expect, it } from 'vitest'
import {
  closedProjects,
  parseShapeEditorRequest,
  shapeEditorHandlesMenuAction,
  shapeEditorTarget,
} from './shape-editor-context'

describe('parseShapeEditorRequest', () => {
  it('takes a part with or without a shape', () => {
    expect(parseShapeEditorRequest({ partId: 'part1', shapeId: 'shape2' })).toEqual({
      partId: 'part1',
      shapeId: 'shape2',
    })
    expect(parseShapeEditorRequest({ partId: 'part1', shapeId: null })).toEqual({
      partId: 'part1',
      shapeId: null,
    })
    expect(parseShapeEditorRequest({ partId: 'part1' })).toEqual({
      partId: 'part1',
      shapeId: null,
    })
  })

  it('drops malformed requests', () => {
    expect(parseShapeEditorRequest(null)).toBeUndefined()
    expect(parseShapeEditorRequest([])).toBeUndefined()
    expect(parseShapeEditorRequest({ shapeId: 'shape1' })).toBeUndefined()
    expect(parseShapeEditorRequest({ partId: '' })).toBeUndefined()
    expect(parseShapeEditorRequest({ partId: 'p', shapeId: 3 })).toBeUndefined()
    expect(parseShapeEditorRequest({ partId: 'x'.repeat(201) })).toBeUndefined()
  })
})

describe('shapeEditorTarget', () => {
  const last = { partId: 'part2', shapeId: 'shape4', seq: 3 }

  it('opens the requested shape', () => {
    expect(shapeEditorTarget(last, { partId: 'part1', shapeId: 'shape1' }, 4)).toEqual({
      partId: 'part1',
      shapeId: 'shape1',
      seq: 4,
    })
  })

  it('without a shape, reopens the last one of the project, else the part alone', () => {
    expect(shapeEditorTarget(last, { partId: 'part1', shapeId: null }, 5)).toEqual({
      ...last,
      seq: 5,
    })
    expect(shapeEditorTarget(undefined, { partId: 'part1', shapeId: null }, 1)).toEqual({
      partId: 'part1',
      shapeId: null,
      seq: 1,
    })
  })
})

describe('closedProjects', () => {
  it('lists the editors whose project is no longer open', () => {
    expect(closedProjects(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c'])
    expect(closedProjects(new Map([['a', 1]]).keys(), ['a'])).toEqual([])
  })
})

describe('shapeEditorHandlesMenuAction', () => {
  it('runs undo, redo and its own menu item; passes the rest to the project window', () => {
    expect(shapeEditorHandlesMenuAction('edit.undo')).toBe(true)
    expect(shapeEditorHandlesMenuAction('edit.redo')).toBe(true)
    expect(shapeEditorHandlesMenuAction('window.shapeEditor')).toBe(true)
    expect(shapeEditorHandlesMenuAction('project.save')).toBe(false)
    expect(shapeEditorHandlesMenuAction('project.apply')).toBe(false)
    expect(shapeEditorHandlesMenuAction('mode.plan')).toBe(false)
  })
})
