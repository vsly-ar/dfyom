// Spec: docs/architecture/feeds-speeds.md#material-data, #machine-rigidity-presets (task 2.12)
import { describe, expect, it } from 'vitest'
import { RIGIDITY_PRESETS } from '../library/machine.dto'
import { bandOf, lintMaterialData, MATERIAL_DATA, pick, RIGIDITY_FACTORS } from './data'
import { testRow } from './data.fixture'

describe('material data lint', () => {
  it('the shipped table passes: every row cited, ranges ordered, bands 0–25 mm without gaps', () => {
    expect(lintMaterialData(MATERIAL_DATA)).toEqual([])
  })

  it('accepts a complete row', () => {
    expect(lintMaterialData([testRow()])).toEqual([])
  })

  it('fails a row without a source', () => {
    expect(lintMaterialData([testRow({ sources: [] })])).toContain('aluminum×carbide: no source')
  })

  it('fails a value no source backs unless marked estimated', () => {
    const row = testRow({ sources: [{ ref: 'https://example.test/chart', fields: ['vc', 'fz'] }] })
    expect(lintMaterialData([row])).toEqual([
      'aluminum×carbide: apSlot has no source and is not estimated',
      'aluminum×carbide: kPlunge has no source and is not estimated',
      'aluminum×carbide: u has no source and is not estimated',
      'aluminum×carbide: fn has no source and is not estimated',
    ])
    const estimated = testRow({
      sources: [{ ref: 'x', fields: ['vc', 'apSlot', 'kPlunge', 'fz', 'fn'] }],
      estimated: ['u'],
    })
    expect(lintMaterialData([estimated])).toEqual([])
  })

  it('needs exactly one speed: vc (F1) or the router chart spindle speed n', () => {
    const { vc: _, ...noVc } = testRow()
    const router = { ...noVc, n: { min: 18_000, max: 18_000 } }
    expect(lintMaterialData([{ ...router, sources: [{ ref: 'x', fields: ['vc'] }] }])).toContain(
      'aluminum×carbide: n has no source and is not estimated',
    )
    const both = testRow({ n: { min: 18_000, max: 18_000 } })
    expect(lintMaterialData([both])).toEqual([
      'aluminum×carbide: n has no source and is not estimated',
      'aluminum×carbide: exactly one of vc and n must be set',
    ])
  })

  it('fails unordered ranges, gaps in the bands and duplicate rows', () => {
    const bad = testRow({ vc: { min: 300, max: 100 }, bands: testRow().bands.slice(1) })
    expect(lintMaterialData([bad, testRow()])).toEqual([
      'aluminum×carbide: vc range must be 0 < min ≤ max',
      'aluminum×carbide: bands must be 3, 6, 12, 25 mm in order (0–25 mm without gaps)',
      'aluminum×carbide: duplicate row',
    ])
  })
})

describe('diameter bands', () => {
  it('picks the smallest band holding D; none above 25 mm', () => {
    const row = testRow()
    expect(bandOf(row, 3)?.maxDiameter).toBe(3)
    expect(bandOf(row, 3.175)?.maxDiameter).toBe(6)
    expect(bandOf(row, 25)?.maxDiameter).toBe(25)
    expect(bandOf(row, 25.4)).toBeUndefined()
  })
})

describe('rigidity presets', () => {
  it('match the doc table and cover every machine preset', () => {
    expect(Object.keys(RIGIDITY_FACTORS)).toEqual([...RIGIDITY_PRESETS])
    expect(
      RIGIDITY_PRESETS.map((p) => [RIGIDITY_FACTORS[p].apFactor, RIGIDITY_FACTORS[p].rangePos]),
    ).toEqual([
      [0.3, 0],
      [0.5, 0.25],
      [0.75, 0.5],
      [0.85, 0.6],
      [0.9, 0.75],
      [1.0, 1.0],
    ])
  })

  it('rangePos picks the position within a range', () => {
    expect(pick({ min: 100, max: 300 }, 0)).toBe(100)
    expect(pick({ min: 100, max: 300 }, 0.25)).toBe(150)
    expect(pick({ min: 100, max: 300 }, 1)).toBe(300)
  })
})
