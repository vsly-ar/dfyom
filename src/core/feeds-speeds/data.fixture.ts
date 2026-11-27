// Test-only material data. SYNTHETIC round numbers chosen to make the arithmetic obvious – not
// cutting data, never used by the app. Doc: docs/architecture/feeds-speeds.md#material-data
import type { MaterialRow } from './data'

const TEST_SOURCE = {
  ref: 'test fixture (synthetic)',
  fields: ['vc', 'apSlot', 'kPlunge', 'u', 'fz', 'fn'],
} as const

export const testRow = (over: Partial<MaterialRow> = {}): MaterialRow => ({
  materialClass: 'aluminum',
  toolMaterial: 'carbide',
  vc: { min: 100, max: 300 },
  apSlot: 0.5,
  kPlunge: 0.3,
  u: 0.6,
  bands: [
    { maxDiameter: 3, fz: { min: 0.01, max: 0.03 }, fn: { min: 0.02, max: 0.06 } },
    { maxDiameter: 6, fz: { min: 0.02, max: 0.06 }, fn: { min: 0.05, max: 0.15 } },
    { maxDiameter: 12, fz: { min: 0.04, max: 0.1 }, fn: { min: 0.1, max: 0.3 } },
    { maxDiameter: 25, fz: { min: 0.06, max: 0.14 } },
  ],
  sources: [TEST_SOURCE],
  chart: 'router',
  ...over,
})

export const TEST_DATA: readonly MaterialRow[] = [testRow()]
