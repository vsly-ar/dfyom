import { describe, expect, it } from 'vitest'
import {
  fitDistance,
  fitPose,
  isClick,
  mouseButtons,
  MOUSE_PRESETS,
  ORBIT_STEP,
  presetDirection,
  viewportKey,
  type KeyLike,
} from './camera'

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
})

describe('view presets', () => {
  it('look along the CAD axes (Z up)', () => {
    const top = presetDirection('top')
    expect(top[2]).toBeCloseTo(1, 5)
    expect(top[1]).toBeLessThan(0) // +Y up on screen
    expect(presetDirection('front')).toEqual([0, -1, 0])
    expect(presetDirection('right')).toEqual([1, 0, 0])
    const iso = presetDirection('iso')
    for (const c of iso) expect(Math.abs(c)).toBeCloseTo(1 / Math.sqrt(3), 9)
    expect(iso[0] > 0 && iso[1] < 0 && iso[2] > 0).toBe(true) // front-right-top
  })

  it('fit distance shows the bounding sphere in the narrower angle', () => {
    // 90° vertical fov, square: r / sin 45°
    expect(fitDistance(10, 90, 1, 1)).toBeCloseTo(10 / Math.SQRT1_2, 6)
    // a tall, narrow viewport needs more distance than a wide one
    expect(fitDistance(10, 30, 0.5)).toBeGreaterThan(fitDistance(10, 30, 2))
    expect(fitDistance(10, 30, 2)).toBeCloseTo(fitDistance(10, 30, 1), 6)
  })

  it('fit pose centres the box and backs off along the direction', () => {
    const box = { min: [0, 0, -20], max: [100, 60, 0] } as const
    const pose = fitPose([0, 0, 1], box, 1, 30)
    expect(pose.target).toEqual([50, 30, -10])
    expect(pose.position[0]).toBe(50)
    expect(pose.position[1]).toBe(30)
    const r = Math.hypot(100, 60, 20) / 2
    expect(pose.position[2] + 10).toBeCloseTo(fitDistance(r, 30, 1), 6)
  })
})

describe('mouse presets (ui.md decision 10)', () => {
  it('maps every preset as in the table', () => {
    expect(mouseButtons('default', false)).toEqual({ left: 'orbit', middle: 'pan', right: 'pan' })
    expect(mouseButtons('fusion', false).middle).toBe('pan')
    expect(mouseButtons('fusion', true).middle).toBe('orbit')
    expect(mouseButtons('blender', false).middle).toBe('orbit')
    expect(mouseButtons('blender', true).middle).toBe('pan')
  })

  it('never drags with the left button outside the default preset (left click selects)', () => {
    for (const p of MOUSE_PRESETS.filter((p) => p !== 'default')) {
      expect(mouseButtons(p, false).left).toBe('none')
      expect(mouseButtons(p, true).left).toBe('none')
    }
  })

  it('a click is a press and release without drag', () => {
    expect(isClick({ x: 10, y: 10 }, { x: 12, y: 13 })).toBe(true)
    expect(isClick({ x: 10, y: 10 }, { x: 20, y: 10 })).toBe(false)
    expect(isClick(null, { x: 0, y: 0 })).toBe(false)
  })
})

describe('viewport keys', () => {
  it('1–4 presets, F fit, +/− zoom, Escape', () => {
    expect(viewportKey(key('1'))).toEqual({ kind: 'preset', preset: 'top' })
    expect(viewportKey(key('2'))).toEqual({ kind: 'preset', preset: 'front' })
    expect(viewportKey(key('3'))).toEqual({ kind: 'preset', preset: 'right' })
    expect(viewportKey(key('4'))).toEqual({ kind: 'preset', preset: 'iso' })
    expect(viewportKey(key('f'))).toEqual({ kind: 'fit' })
    expect(viewportKey(key('F', { shiftKey: true }))).toEqual({ kind: 'fit' })
    expect(viewportKey(key('+'))).toEqual({ kind: 'zoom', direction: 1 })
    expect(viewportKey(key('-'))).toEqual({ kind: 'zoom', direction: -1 })
    expect(viewportKey(key('Escape'))).toEqual({ kind: 'escape' })
  })

  it('arrows orbit, Shift+arrows pan, only when the region itself has focus', () => {
    const left = viewportKey(key('ArrowLeft'))
    expect(left).toMatchObject({ kind: 'orbit', azimuth: ORBIT_STEP })
    expect(viewportKey(key('ArrowUp'))).toMatchObject({ kind: 'orbit', polar: -ORBIT_STEP })
    expect(viewportKey(key('ArrowRight', { shiftKey: true }))).toEqual({ kind: 'pan', x: 1, y: 0 })
    expect(viewportKey(key('ArrowLeft'), false)).toBeUndefined()
  })

  it('leaves app shortcuts and other keys alone', () => {
    expect(viewportKey(key('1', { metaKey: true }))).toBeUndefined()
    expect(viewportKey(key('f', { ctrlKey: true }))).toBeUndefined()
    expect(viewportKey(key('z'))).toBeUndefined()
  })
})
