import { describe, expect, it } from 'vitest'
import { apply, compose, IDENTITY, parseTransform, type Affine } from './transform'
import { parseLength, rootViewport, userLength, type Viewport } from './units'

const close = (m: Affine, n: Affine): void =>
  m.forEach((v, i) => expect(v, `entry ${i}`).toBeCloseTo(n[i]!, 12))

describe('parseTransform', () => {
  it('reads every transform kind and composes lists left to right', () => {
    close(parseTransform('matrix(1 2 3 4 5 6)').unwrap(), [1, 2, 3, 4, 5, 6])
    close(parseTransform('translate(5)').unwrap(), [1, 0, 0, 1, 5, 0])
    close(parseTransform('scale(2, 3)').unwrap(), [2, 0, 0, 3, 0, 0])
    close(parseTransform('scale(2)').unwrap(), [2, 0, 0, 2, 0, 0])
    close(parseTransform('rotate(90)').unwrap(), [0, 1, -1, 0, 0, 0])
    close(parseTransform('skewX(45)').unwrap(), [1, 0, 1, 1, 0, 0])
    close(parseTransform('skewY(45)').unwrap(), [1, 1, 0, 1, 0, 0])
    // rotate about (10, 0): (10, 0) stays
    const r = parseTransform('rotate(90 10 0)').unwrap()
    expect(apply(r, { x: 10, y: 0 }).x).toBeCloseTo(10, 12)
    expect(apply(r, { x: 10, y: 0 }).y).toBeCloseTo(0, 12)
    // translate then scale: the scale applies first to points
    const l = parseTransform('translate(10,0) scale(2)').unwrap()
    expect(apply(l, { x: 1, y: 1 })).toEqual({ x: 12, y: 2 })
    close(parseTransform('  ').unwrap(), IDENTITY)
    close(compose(IDENTITY, [1, 2, 3, 4, 5, 6]), [1, 2, 3, 4, 5, 6])
  })

  it('refuses malformed lists', () => {
    for (const s of ['rotate(', 'scale()', 'matrix(1 2 3)', 'spin(4)', 'translate(1,2,3)', 'x'])
      expect(parseTransform(s).isNone(), s).toBe(true)
  })
})

describe('lengths', () => {
  it('reads CSS units; user lengths are px', () => {
    expect(parseLength('10mm')).toEqual({ value: 10, unit: 'mm' })
    expect(parseLength(' 2.5IN ')).toEqual({ value: 2.5, unit: 'in' })
    expect(parseLength('50%')).toEqual({ value: 50, unit: '%' })
    expect(parseLength('10em')).toBeUndefined()
    expect(parseLength('abc')).toBeUndefined()
    expect(userLength('10')).toBe(10)
    expect(userLength('1in')).toBeCloseTo(96, 12)
    expect(userLength('25.4mm')).toBeCloseTo(96, 12)
    expect(userLength('50%')).toBeUndefined()
  })
})

const vp = (
  input: Parameters<typeof rootViewport>[0],
  unit: 'mm' | 'in' | 'px96' | 'px72' = 'px96',
): Viewport => {
  const r = rootViewport(input, unit)
  if ('err' in r) throw new Error(r.err)
  return r.ok
}

describe('rootViewport', () => {
  it('maps a mm page with a viewBox: y up from the bottom edge', () => {
    const v = vp({ width: '250mm', height: '178mm', viewBox: '0 0 250 178' })
    expect(v.size).toEqual({ width: 250, height: 178 })
    expect(v.unit).toBe('mm')
    expect(v.assumed).toBe(false)
    expect(apply(v.matrix, { x: 10, y: 0 })).toEqual({ x: 10, y: 178 })
    expect(apply(v.matrix, { x: 0, y: 178 })).toEqual({ x: 0, y: 0 })
  })

  it('scales the viewBox onto an inch page and offsets its origin', () => {
    const v = vp({ width: '2in', height: '1in', viewBox: '10 20 200 100' })
    expect(v.scale[0]).toBeCloseTo(50.8 / 200, 12)
    const p = apply(v.matrix, { x: 10, y: 120 })
    expect(p.x).toBeCloseTo(0, 12)
    expect(p.y).toBeCloseTo(0, 12)
  })

  it('assumes 96 dpi for unitless files, overridable', () => {
    const a = vp({ width: '96', height: '96' })
    expect(a.assumed).toBe(true)
    expect(a.unit).toBe('px96')
    expect(a.size!.width).toBeCloseTo(25.4, 12)
    expect(vp({ viewBox: '0 0 72 72' }, 'px72').size!.width).toBeCloseTo(25.4, 12)
    expect(vp({ viewBox: '0 0 10 10' }, 'mm').size).toEqual({ width: 10, height: 10 })
    expect(vp({ width: '100px', height: '50px' }, 'in').size).toEqual({ width: 2540, height: 1270 })
    // no size and no viewBox: user units at the option, flipped about y = 0
    const n = vp({}, 'mm')
    expect(n.size).toBeUndefined()
    expect(apply(n.matrix, { x: 3, y: 4 })).toEqual({ x: 3, y: -4 })
  })

  it('derives a missing width or height from the viewBox aspect', () => {
    expect(vp({ width: '100mm', viewBox: '0 0 200 100' }).size).toEqual({ width: 100, height: 50 })
    expect(vp({ height: '100mm', viewBox: '0 0 200 100' }).size).toEqual({
      width: 200,
      height: 100,
    })
  })

  it('applies preserveAspectRatio (meet centred by default, none, slice, min/max)', () => {
    const page = { width: '200mm', height: '100mm', viewBox: '0 0 100 100' }
    const meet = vp(page)
    expect(meet.scale).toEqual([1, 1])
    expect(apply(meet.matrix, { x: 0, y: 100 })).toEqual({ x: 50, y: 0 })
    const none = vp({ ...page, preserveAspectRatio: 'none' })
    expect(none.scale).toEqual([2, 1])
    const min = vp({ ...page, preserveAspectRatio: 'xMinYMin meet' })
    expect(apply(min.matrix, { x: 0, y: 100 })).toEqual({ x: 0, y: 0 })
    const slice = vp({ ...page, preserveAspectRatio: 'xMaxYMax slice' })
    expect(slice.scale).toEqual([2, 2])
  })

  it('refuses malformed viewBoxes and sizes', () => {
    expect(rootViewport({ viewBox: '0 0 0 10' }, 'px96')).toEqual({ err: 'viewBox' })
    expect(rootViewport({ viewBox: '0 0 a 10' }, 'px96')).toEqual({ err: 'viewBox' })
    expect(rootViewport({ viewBox: '0 0 10' }, 'px96')).toEqual({ err: 'viewBox' })
    expect(rootViewport({ width: '-5mm' }, 'px96')).toEqual({ err: 'size' })
  })
})
