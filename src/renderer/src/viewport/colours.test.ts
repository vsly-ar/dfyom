import { describe, expect, it } from 'vitest'
import {
  FALLBACK,
  isOutlined,
  mix,
  MIX,
  paletteFrom,
  PALETTE_TOKENS,
  parseColour,
  surfaceColour,
  toLinear,
  vertexColours,
  type Palette,
} from './colours'
import { sampleMesh } from './sample-mesh'

describe('parseColour', () => {
  it('reads the forms tokens.css uses', () => {
    expect(parseColour('#ff0000')).toEqual([1, 0, 0])
    expect(parseColour(' #0F0 ')).toEqual([0, 1, 0])
    expect(parseColour('#00000080')).toEqual([0, 0, 0])
    expect(parseColour('rgb(150 105 0 / 0.45)')).toEqual([150 / 255, 105 / 255, 0])
    expect(parseColour('rgba(255, 0, 0, 0.5)')).toEqual([1, 0, 0])
    expect(parseColour('rgb(100% 0% 50%)')).toEqual([1, 0, 0.5])
  })

  it('rejects anything else', () => {
    expect(parseColour('')).toBeUndefined()
    expect(parseColour('color-mix(in oklab, red, blue)')).toBeUndefined()
    expect(parseColour('#12')).toBeUndefined()
    expect(parseColour('rgb(1 2)')).toBeUndefined()
  })

  it('builds a palette from token values, falling back visibly', () => {
    const p = paletteFrom({ '--vp-part': '#ffffff' })
    expect(p.part).toEqual([1, 1, 1])
    expect(p.selected).toEqual(FALLBACK)
    expect(Object.keys(p)).toEqual(Object.keys(PALETTE_TOKENS))
  })
})

const palette = Object.fromEntries(
  Object.keys(PALETTE_TOKENS).map((k, i) => [k, [i / 20, 0.5, 1 - i / 20]]),
) as unknown as Palette

describe('surface colours', () => {
  it('base, selection tint and hover preview of the whole operation', () => {
    expect(surfaceColour('pocket1.floor', {}, palette)).toEqual(palette.part)
    expect(surfaceColour('pocket1.floor', { selectedOperation: 'pocket1' }, palette)).toEqual(
      mix(palette.part, palette.selected, MIX.selected),
    )
    expect(surfaceColour('pocket1.floor', { hovered: 'pocket1.wall[0]' }, palette)).toEqual(
      palette.hover,
    )
    expect(surfaceColour('drill1.wall', { hovered: 'pocket1.wall[0]' }, palette)).toEqual(
      palette.part,
    )
    const both = { selectedOperation: 'pocket1', hovered: 'pocket1.floor' }
    expect(surfaceColour('pocket1.floor', both, palette)).toEqual(
      mix(palette.part, palette.selected, MIX.selected),
    )
  })

  it('outdated replaces the base colour', () => {
    expect(surfaceColour('stock.top', { outdated: true }, palette)).toEqual(palette.outdated)
  })

  it('pick mode: eligible tinted, hovered eligible strong, others dimmed, per surface', () => {
    const pickEligible = new Set(['pocket1.floor', 'stock.top'])
    const s = { pickEligible, hovered: 'pocket1.floor', selectedOperation: 'pocket1' }
    expect(surfaceColour('pocket1.floor', s, palette)).toEqual(
      mix(palette.part, palette.selected, MIX.pickHover),
    )
    expect(surfaceColour('stock.top', s, palette)).toEqual(
      mix(palette.part, palette.selected, MIX.pickEligible),
    )
    expect(surfaceColour('pocket1.wall[0]', s, palette)).toEqual(
      mix(palette.part, palette.background, MIX.pickDimmed),
    )
    expect(isOutlined('pocket1.floor', s)).toBe(true)
    expect(isOutlined('stock.top', s)).toBe(false)
    expect(isOutlined('pocket1.wall[0]', { selectedOperation: 'pocket1' })).toBe(true)
  })

  it('writes linear colours per triangle corner', () => {
    const mesh = sampleMesh()
    const out = vertexColours(mesh, { selectedOperation: 'drill1' }, palette)
    expect(out.length).toBe(mesh.indices.length * 3)
    const t = [...mesh.triangleSurface].indexOf(mesh.surfaces.indexOf('drill1.wall'))
    const want = toLinear(mix(palette.part, palette.selected, MIX.selected))
    for (let k = 0; k < 3; k++) {
      expect(out[9 * t + 3 * k]).toBeCloseTo(want[0], 6)
      expect(out[9 * t + 3 * k + 2]).toBeCloseTo(want[2], 6)
    }
  })

  it('toLinear follows the sRGB curve', () => {
    const [a, b, c] = toLinear([0, 1, 0.5])
    expect(a).toBe(0)
    expect(b).toBeCloseTo(1, 9)
    expect(c).toBeCloseTo(0.214, 3)
  })
})
