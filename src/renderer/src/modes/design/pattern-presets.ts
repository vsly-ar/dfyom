// The Presets dialog's pure parts (hardening DF107): whether a pattern already is a preset (its
// cell kind and sizes, lattice, gap and Flip equal the preset's, exactly in mm and degrees), so
// the dialog marks it Current and focuses it, and a preset's key numbers ("hexagon 10 mm across
// flats · hex · gap 2 mm") from its metric sources.
// Doc: docs/modes/patterns.md#presets-dialog-and-more-presets-df107
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import type { PatternPreset } from '../../../../core/design/pattern/presets'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'

/** "10 mm", "30°", "6" → 10, 30, 6. */
const num = (source: string | undefined): number => Number.parseFloat(source ?? '0') || 0

/** A stored quantity's exact value in its canonical unit (mm, °), undefined when absent. */
function exact(q: unknown): number | undefined {
  const e = (q as QuantityDTO | undefined)?.exact
  return e === undefined ? undefined : Number(e.num) / Number(e.den)
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

/** Whether the pattern's cell, lattice, gap and Flip are the preset's (a pitch is no preset). */
export function matchesPreset(feature: FeatureDTO, preset: PatternPreset): boolean {
  const { cell, lattice, spacing, alternate } = preset.args
  const fc = feature['cell'] as Record<string, unknown> | undefined
  const fs = feature['spacing'] as { gap?: QuantityDTO } | undefined
  if (fc === undefined || fc['kind'] !== cell['kind']) return false
  if (feature['lattice'] !== lattice) return false
  if ((feature['alternate'] ?? 'none') !== alternate) return false
  const gap = exact(fs?.gap)
  if (gap === undefined || !near(gap, num(spacing.gap))) return false
  if (cell['kind'] === 'polygon' && (fc['across'] ?? 'flats') !== (cell['across'] ?? 'flats'))
    return false
  for (const k of ['diameter', 'length', 'width', 'cornerRadius', 'sides', 'rotation']) {
    const want = cell[k]
    const have = exact(fc[k])
    // an absent rotation or corner radius is 0
    const zeroDefault = k === 'rotation' || k === 'cornerRadius'
    const w = want === undefined ? (zeroDefault ? 0 : undefined) : num(want)
    const h = have === undefined || Number.isNaN(have) ? (zeroDefault ? 0 : undefined) : have
    if (w === undefined && h === undefined) continue
    if (w === undefined || h === undefined || !near(w, h)) return false
  }
  return true
}

/** The words the key numbers use, from the messages. */
export interface PresetWords {
  readonly cell: (kind: string, sides: number) => string
  readonly across: (corners: boolean) => string
  readonly lattice: Readonly<Record<string, string>>
  readonly gap: string
  readonly flip: string
}

/** "hexagon 10 mm across flats · hex · gap 2 mm": the preset's cell, lattice and gap. */
export function presetNumbers(preset: PatternPreset, words: PresetWords): string {
  const { cell, lattice, spacing, alternate } = preset.args
  const mm = (k: string) => `${num(cell[k])} mm`
  const size = ((): string => {
    switch (cell['kind']) {
      case 'circle':
        return `Ø ${mm('diameter')}`
      case 'rectangle':
      case 'obround':
        return `${num(cell['length'])} × ${mm('width')}`
      case 'polygon':
        return `${mm('diameter')} ${words.across(cell['across'] === 'corners')}`
      default:
        return ''
    }
  })()
  const what = `${words.cell(cell['kind'] ?? '', num(cell['sides']))} ${size}`.trim()
  return [
    what,
    words.lattice[lattice] ?? lattice,
    `${words.gap} ${num(spacing.gap)} mm`,
    ...(alternate === 'flip' ? [words.flip] : []),
  ].join(' · ')
}
