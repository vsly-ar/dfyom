// Window choice for New / Open and the new window's cascade. Spec: docs/conventions/ui.md#project-files
import { describe, expect, it } from 'vitest'
import { cascadeBounds, isOpeningCommand, openTarget, type OpenRequest } from './window-open'

const request = (r: Partial<OpenRequest>): OpenRequest => ({
  name: 'project.open',
  senderKey: undefined,
  openKey: undefined,
  windowKeys: [],
  bindsNone: false,
  ...r,
})

describe('openTarget', () => {
  it('reuses an empty window and opens a new one from a window with a project', () => {
    expect(openTarget(request({ windowKeys: [undefined] }))).toEqual({ kind: 'here' })
    expect(
      openTarget(request({ name: 'project.create', senderKey: 'a', windowKeys: ['a'] })),
    ).toEqual({ kind: 'newWindow' })
  })

  it('focuses the window already showing the file, the asking one included', () => {
    expect(openTarget(request({ senderKey: 'a', openKey: 'b', windowKeys: ['a', 'b'] }))).toEqual({
      kind: 'focus',
      key: 'b',
    })
    expect(openTarget(request({ openKey: 'b', windowKeys: [undefined, 'b'] }))).toEqual({
      kind: 'focus',
      key: 'b',
    })
    expect(openTarget(request({ senderKey: 'a', openKey: 'a', windowKeys: ['a'] }))).toEqual({
      kind: 'focus',
      key: 'a',
    })
  })

  it('a file open without a window (an agent session only) goes by the window rule', () => {
    expect(openTarget(request({ senderKey: 'a', openKey: 'b', windowKeys: ['a'] }))).toEqual({
      kind: 'newWindow',
    })
  })

  it('discarding recovered changes binds nothing and runs in the asking window', () => {
    expect(
      openTarget(
        request({
          name: 'project.recovery.resolve',
          senderKey: 'a',
          windowKeys: ['a'],
          bindsNone: true,
        }),
      ),
    ).toEqual({ kind: 'here' })
  })

  it('knows the opening commands', () => {
    expect(isOpeningCommand('project.recovery.resolve')).toBe(true)
    expect(isOpeningCommand('project.close')).toBe(false)
    expect(isOpeningCommand(42)).toBe(false)
  })
})

describe('cascadeBounds', () => {
  const work = { x: 0, y: 25, width: 1920, height: 1055 }

  it('steps right and down with the same size', () => {
    expect(cascadeBounds({ x: 100, y: 100, width: 1440, height: 900 }, work)).toEqual({
      x: 122,
      y: 122,
      width: 1440,
      height: 900,
    })
  })

  it('wraps to the work area corner when the window would leave it', () => {
    expect(cascadeBounds({ x: 470, y: 150, width: 1440, height: 900 }, work)).toEqual({
      x: 0,
      y: 25,
      width: 1440,
      height: 900,
    })
  })

  it('never exceeds the work area and keeps the default without a source window', () => {
    expect(cascadeBounds({ x: 0, y: 25, width: 3000, height: 2000 }, work)).toEqual({
      x: 0,
      y: 25,
      width: 1920,
      height: 1055,
    })
    expect(cascadeBounds(undefined, work)).toBeUndefined()
  })
})
