// The Presets dialog's pure parts (hardening DF107): a pattern matches a preset exactly in mm and
// degrees (an absent rotation or corner radius is 0); the key numbers read from the sources.
// Doc: docs/modes/patterns.md#presets-dialog-and-more-presets-df107
import { describe, expect, it } from 'vitest'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import { PATTERN_PRESETS } from '../../../../core/design/pattern/presets'
import { designMessages } from '../../messages/design'
import { matchesPreset, presetNumbers } from './pattern-presets'

const preset = (id: string) => PATTERN_PRESETS.find((p) => p.id === id)!
const words = designMessages.features.pattern.presetWords
const q = (n: number) => ({ source: `${n}`, exact: { num: `${Math.round(n * 100)}`, den: '100' } })

const feature = (over: Record<string, unknown>) =>
  ({
    id: 'pattern1',
    kind: 'pattern',
    cell: { kind: 'circle', diameter: q(3) },
    lattice: 'hex',
    spacing: { gap: q(1.5) },
    ...over,
  }) as unknown as FeatureDTO

describe('matchesPreset (DF107)', () => {
  it('the Grille preset as stored matches it and no other', () => {
    const f = feature({})
    expect(PATTERN_PRESETS.filter((p) => matchesPreset(f, p)).map((p) => p.id)).toEqual(['grille'])
  })

  it('a different gap, lattice, Flip or size is no preset; a pitch never is', () => {
    expect(matchesPreset(feature({ spacing: { gap: q(2) } }), preset('grille'))).toBe(false)
    expect(matchesPreset(feature({ lattice: 'square' }), preset('grille'))).toBe(false)
    expect(matchesPreset(feature({ alternate: 'flip' }), preset('grille'))).toBe(false)
    expect(
      matchesPreset(feature({ cell: { kind: 'circle', diameter: q(4) } }), preset('grille')),
    ).toBe(false)
    expect(matchesPreset(feature({ spacing: { pitch: [q(4), q(4)] } }), preset('grille'))).toBe(
      false,
    )
  })

  it('sources in inches compare by their exact mm; an absent corner radius is 0', () => {
    // Waffle: 8 × 8 R 0.5, square, gap 2
    const waffle = (r?: object) =>
      feature({
        cell: { kind: 'rectangle', length: q(8), width: q(8), ...(r ? { cornerRadius: r } : {}) },
        lattice: 'square',
        spacing: { gap: { source: '0.07874in', exact: { num: '2', den: '1' } } },
      })
    expect(matchesPreset(waffle(q(0.5)), preset('waffle'))).toBe(true)
    expect(matchesPreset(waffle(), preset('waffle'))).toBe(false)
  })
})

describe('presetNumbers (DF107)', () => {
  it('names the cell, its size, the lattice, the gap and Flip', () => {
    expect(presetNumbers(preset('honeycomb'), words)).toBe(
      'hexagon 10 mm across flats · hex · gap 2 mm',
    )
    expect(presetNumbers(preset('speakerGrille'), words)).toBe('hole Ø 4 mm · polar · gap 2 mm')
    expect(presetNumbers(preset('louvres'), words)).toBe('slot 30 × 4 mm · square · gap 4 mm')
    expect(presetNumbers(preset('triangles'), words)).toBe(
      'triangle 12 mm across corners · square · gap 2 mm · flipped',
    )
  })
})
