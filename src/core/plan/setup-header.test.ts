// Doc: docs/architecture/grbl.md#setup-header-hardening-df58
import { describe, expect, it } from 'vitest'
import { DIRECTIONS, type Direction } from '../geometry/face'
import type { Vec3 } from '../geometry/model'
import { setupFrame, type WcsRotation } from '../toolpath/wcs'
import { setupCorner, setupHeader, setupMotion } from './setup-header'

const stock = { length: 250, width: 100, thickness: 20 }
const s = (direction: Direction, rotation: WcsRotation = 0) => ({ direction, rotation })

type Mat = [Vec3, Vec3, Vec3]
const mul = (a: Mat, b: Mat): Mat =>
  a.map((r) =>
    [0, 1, 2].map((j) => r[0] * b[0][j]! + r[1] * b[1][j]! + r[2] * b[2][j]!),
  ) as unknown as Mat
const I: Mat = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]
const rx = (q: number): Mat =>
  q === 90
    ? [
        [1, 0, 0],
        [0, 0, -1],
        [0, 1, 0],
      ]
    : q === -90
      ? [
          [1, 0, 0],
          [0, 0, 1],
          [0, -1, 0],
        ]
      : [
          [1, 0, 0],
          [0, -1, 0],
          [0, 0, -1],
        ]
const ry = (q: number): Mat =>
  q === 90
    ? [
        [0, 0, 1],
        [0, 1, 0],
        [-1, 0, 0],
      ]
    : q === -90
      ? [
          [0, 0, -1],
          [0, 1, 0],
          [1, 0, 0],
        ]
      : [
          [-1, 0, 0],
          [0, 1, 0],
          [0, 0, -1],
        ]
const rz = (q: number): Mat => {
  const c = Math.round(Math.cos((q * Math.PI) / 180))
  const n = Math.round(Math.sin((q * Math.PI) / 180))
  return [
    [c, -n, 0],
    [n, c, 0],
    [0, 0, 1],
  ]
}

/** The rotation (machine coordinates) a motion text describes, read the way an operator would. */
function motionMatrix(text: string): Mat {
  const [first, then] = text.split(', then ')
  const turn = (t: string | undefined): Mat =>
    t === undefined
      ? I
      : t === 'turn 90 deg CCW'
        ? rz(90)
        : t === 'turn 90 deg CW'
          ? rz(-90)
          : t === 'turn 180 deg'
            ? rz(180)
            : (() => {
                throw new Error(`unknown turn ${t}`)
              })()
  const tips: Record<string, Mat> = {
    'same orientation': I,
    'flip about X': rx(180),
    'flip about Y': ry(180),
    'tip its front side up': rx(-90), // the side towards the operator (−Y) rolls up to +Z
    'tip its back side up': rx(90),
    'tip its right side up': ry(-90),
    'tip its left side up': ry(90),
  }
  const tip = tips[first!]
  if (tip === undefined) return turn(first)
  return mul(turn(then), tip)
}

/** Where a part direction sits on the machine in a setup: rows = machine X, Y, Z in the part. */
function axes(d: Direction, r: WcsRotation): Mat {
  const f = setupFrame(d, r, stock)
  return [f.u, f.v, f.n] as Mat
}

describe('setupMotion (DF58)', () => {
  it('names the enclosure test: bottom first, then the top is a flip about X', () => {
    expect(setupMotion(s('-z'), s('+z'), stock)).toBe('flip about X')
    expect(setupMotion(s('+z'), s('-z'), stock)).toBe('flip about X')
  })

  it('names turns, tips and the unchanged orientation', () => {
    expect(setupMotion(s('+z'), s('+z'), stock)).toBe('same orientation')
    expect(setupMotion(s('+z'), s('+z', 180), stock)).toBe('turn 180 deg')
    expect(setupMotion(s('+z'), s('-y'), stock)).toBe('tip its front side up')
    expect(setupMotion(s('-z'), s('+z', 180), stock)).toBe('flip about Y')
  })

  it('property: every description, done to the stock, gives the setup orientation', () => {
    const rotations: WcsRotation[] = [0, 90, 180, 270]
    for (const d1 of DIRECTIONS)
      for (const r1 of rotations)
        for (const d2 of DIRECTIONS)
          for (const r2 of rotations) {
            const text = setupMotion(s(d1, r1), s(d2, r2), stock)
            // a part direction's machine coordinates: setup 1 A1·p, after the motion R·A1·p
            const before = axes(d1, r1)
            const after = mul(motionMatrix(text), before)
            const want = axes(d2, r2)
            for (let i = 0; i < 3; i++)
              for (let j = 0; j < 3; j++)
                expect(after[i]![j]! + 0, `${d1}/${r1} → ${d2}/${r2}: ${text}`).toBeCloseTo(
                  want[i]![j]!,
                  9,
                )
          }
  })
})

describe('setupCorner / setupHeader (DF58)', () => {
  it('names the part corner at the work zero', () => {
    expect(setupCorner(s('+z'), stock)).toBe('front left')
    expect(setupCorner(s('-z'), stock)).toBe('back left')
  })

  it('builds the header of each setup: number, faces, motion, corner, stock on the machine', () => {
    const setups = [s('-z'), s('+z', 90)]
    const named = stock
    expect(setupHeader(setups, 0, named)).toEqual({
      number: 1,
      count: 2,
      up: 'bottom',
      front: 'back',
      right: 'right',
      corner: 'back left',
      stock: [250, 100, 20],
    })
    const top = setupHeader(setups, 1, named)
    expect(top).toMatchObject({ number: 2, count: 2, up: 'top', stock: [100, 250, 20] })
    expect(top.fromFirst).toBe(setupMotion(setups[0]!, setups[1]!, stock))
    expect(top.fromFirst).toMatch(/^flip about X, then turn 90 deg C?CW$/)
  })
})
