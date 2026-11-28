import { describe, expect, it } from 'vitest'
import {
  libraryWindowStart,
  revealSteps,
  visibleBounds,
  windowStart,
  windowTitle,
} from './window-state'

const primary = { x: 0, y: 25, width: 1920, height: 1055 }
const right = { x: 1920, y: 0, width: 2560, height: 1440 }

describe('windowTitle', () => {
  it('adds the app name and version to the document title', () => {
    expect(windowTitle('DFYOM', '0.0.64')).toBe('DFYOM 0.0.64')
    expect(windowTitle('', '0.0.64')).toBe('DFYOM 0.0.64')
    expect(windowTitle('Bracket — Edited', '0.0.64')).toBe('Bracket — Edited — DFYOM 0.0.64')
  })
})

describe('visibleBounds', () => {
  it('keeps a window that fits its display', () => {
    const r = { x: 2000, y: 100, width: 1440, height: 900 }
    expect(visibleBounds(r, [primary, right], primary)).toEqual(r)
  })

  it('moves a window that sticks out back inside the display it overlaps most', () => {
    expect(
      visibleBounds({ x: 3800, y: 1000, width: 1440, height: 900 }, [primary, right], primary),
    ).toEqual({ x: 3040, y: 540, width: 1440, height: 900 })
  })

  it('centres a window whose display is gone on the primary display, no larger than it', () => {
    expect(
      visibleBounds({ x: 2000, y: 100, width: 2400, height: 900 }, [primary], primary),
    ).toEqual({ x: 0, y: 103, width: 1920, height: 900 })
  })
})

describe('windowStart', () => {
  const saved = {
    bounds: { x: 100, y: 100, width: 1300, height: 800 },
    maximized: true,
    fullScreen: false,
  }
  const base = { workAreas: [primary], primary, othersOpen: false }

  it('restores the remembered window as it was when no other window is open', () => {
    expect(windowStart({ ...base, source: undefined, saved })).toEqual(saved)
  })

  it('cascades from the source window, else from the remembered one, never maximized', () => {
    const source = { x: 200, y: 100, width: 1440, height: 900 }
    expect(windowStart({ ...base, source, saved })).toEqual({
      bounds: { x: 222, y: 122, width: 1440, height: 900 },
      maximized: false,
      fullScreen: false,
    })
    expect(windowStart({ ...base, othersOpen: true, source: undefined, saved })).toEqual({
      bounds: { x: 122, y: 122, width: 1300, height: 800 },
      maximized: false,
      fullScreen: false,
    })
  })

  it('uses the default size, centred, without anything to start from', () => {
    expect(windowStart({ ...base, source: undefined, saved: undefined })).toEqual({
      bounds: undefined,
      maximized: false,
      fullScreen: false,
    })
  })
})

describe('libraryWindowStart', () => {
  it('restores its own remembered bounds made visible, maximized as it was', () => {
    const saved = {
      bounds: { x: 3800, y: 1000, width: 1440, height: 900 },
      maximized: true,
      fullScreen: false,
    }
    expect(libraryWindowStart(saved, [primary, right], primary)).toEqual({
      bounds: { x: 3040, y: 540, width: 1440, height: 900 },
      maximized: true,
      fullScreen: false,
    })
  })

  it('without a record: the default size, centred', () => {
    expect(libraryWindowStart(undefined, [primary], primary)).toEqual({
      bounds: undefined,
      maximized: false,
      fullScreen: false,
    })
  })
})

describe('revealSteps (DF162)', () => {
  const start = { bounds: undefined, maximized: true, fullScreen: true }

  it('a window the user opened is focused and restored as it was', () => {
    expect(revealSteps(start, false)).toEqual({ inactive: false, maximize: true, fullScreen: true })
  })

  it('a window an agent opened takes no focus and never enters full screen', () => {
    expect(revealSteps(start, true)).toEqual({ inactive: true, maximize: true, fullScreen: false })
  })

  it('a window without a start is just shown', () => {
    expect(revealSteps(undefined, true)).toEqual({
      inactive: true,
      maximize: false,
      fullScreen: false,
    })
  })
})
