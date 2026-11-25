// Common general tolerances for the part inspector's General tolerance field (hardening DF97):
// the symmetric ± deviation untoleranced lengths inherit (quantities.md § Tolerance), from a
// precision fit in metal to rough work in wood. Bare numbers in the project unit, as typed.
// Doc: docs/conventions/ui.md#general-tolerance-presets-df97
import type { UnitSystem } from '../../../../core/project/document'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'

export type TolerancePresetUse = 'precision' | 'fine' | 'standard' | 'woodPlastic' | 'rough'

export interface TolerancePreset {
  /** The deviation as `generalTolerance.length` takes it (a bare number in the project unit). */
  readonly source: string
  /** The deviation in mm, to tell which preset the stored value is. */
  readonly mm: number
  readonly use: TolerancePresetUse
}

export const TOLERANCE_PRESETS: Readonly<Record<UnitSystem, readonly TolerancePreset[]>> = {
  mm: [
    { source: '0.02', mm: 0.02, use: 'precision' },
    { source: '0.05', mm: 0.05, use: 'fine' },
    { source: '0.1', mm: 0.1, use: 'standard' },
    { source: '0.2', mm: 0.2, use: 'woodPlastic' },
    { source: '0.5', mm: 0.5, use: 'rough' },
  ],
  inch: [
    { source: '0.001', mm: 0.0254, use: 'precision' },
    { source: '0.002', mm: 0.0508, use: 'fine' },
    { source: '0.005', mm: 0.127, use: 'standard' },
    { source: '0.01', mm: 0.254, use: 'woodPlastic' },
    { source: '0.02', mm: 0.508, use: 'rough' },
  ],
}

/** The preset the stored general tolerance equals (exact value, within 1 nm), if any. */
export function currentTolerancePreset(
  units: UnitSystem,
  stored: QuantityDTO | undefined,
): TolerancePreset | undefined {
  if (stored === undefined) return undefined
  const mm = Number(stored.exact.num) / Number(stored.exact.den)
  return TOLERANCE_PRESETS[units].find((p) => Math.abs(p.mm - mm) < 1e-6)
}
