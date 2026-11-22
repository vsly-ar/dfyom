/**
 * Affine transforms of the SVG import: the `transform` attribute (matrix, translate, scale, rotate,
 * skewX, skewY) and composition. Matrices are SVG's `[a, b, c, d, e, f]`:
 * `x' = a·x + c·y + e`, `y' = b·x + d·y + f`.
 * Doc: docs/architecture/shapes.md#svg-import
 */
import { None, Some, type Option } from '../../../shared/result'

export type Affine = readonly [number, number, number, number, number, number]

export interface Pt {
  readonly x: number
  readonly y: number
}

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]

/** `m ∘ n`: apply `n` first, then `m`. */
export function compose(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

export const apply = (m: Affine, p: Pt): Pt => ({
  x: m[0] * p.x + m[2] * p.y + m[4],
  y: m[1] * p.x + m[3] * p.y + m[5],
})

/** The linear part only (for direction vectors). */
export const applyLinear = (m: Affine, v: Pt): Pt => ({
  x: m[0] * v.x + m[2] * v.y,
  y: m[1] * v.x + m[3] * v.y,
})

export const determinant = (m: Affine): number => m[0] * m[3] - m[1] * m[2]

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/
const deg = (a: number): number => (a * Math.PI) / 180

/**
 * Parses a `transform` attribute; None when it is malformed (SVG: the element is then drawn
 * without the transform; the importer warns). An empty list is the identity.
 */
export function parseTransform(src: string): Option<Affine> {
  let m: Affine = IDENTITY
  let s = src.trim()
  while (s.length > 0) {
    const head = /^([a-zA-Z]+)\s*\(/.exec(s)
    if (!head) return None
    const name = head[1]!
    s = s.slice(head[0].length)
    const args: number[] = []
    for (;;) {
      s = s.replace(/^[\s,]+/, '')
      if (s.startsWith(')')) {
        s = s.slice(1)
        break
      }
      const num = NUMBER.exec(s)
      if (!num) return None
      args.push(Number(num[0]))
      s = s.slice(num[0].length)
    }
    const t = transformOf(name, args)
    if (t.isNone()) return None
    m = compose(m, t.unwrap())
    s = s.replace(/^[\s,]+/, '')
  }
  return Some(m)
}

function transformOf(name: string, a: readonly number[]): Option<Affine> {
  const n = a.length
  switch (name) {
    case 'matrix':
      return n === 6 ? Some([a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!]) : None
    case 'translate':
      return n === 1 || n === 2 ? Some([1, 0, 0, 1, a[0]!, a[1] ?? 0]) : None
    case 'scale':
      return n === 1 || n === 2 ? Some([a[0]!, 0, 0, a[1] ?? a[0]!, 0, 0]) : None
    case 'rotate': {
      if (n !== 1 && n !== 3) return None
      const c = Math.cos(deg(a[0]!))
      const s = Math.sin(deg(a[0]!))
      const r: Affine = [c, s, -s, c, 0, 0]
      if (n === 1) return Some(r)
      const cx = a[1]!
      const cy = a[2]!
      return Some(compose(compose([1, 0, 0, 1, cx, cy], r), [1, 0, 0, 1, -cx, -cy]))
    }
    case 'skewX':
      return n === 1 ? Some([1, 0, Math.tan(deg(a[0]!)), 1, 0, 0]) : None
    case 'skewY':
      return n === 1 ? Some([1, Math.tan(deg(a[0]!)), 0, 1, 0, 0]) : None
    default:
      return None
  }
}
