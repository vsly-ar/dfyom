// Spec: docs/modes/design-v0.4.md#fastener-table (task F2)
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../../shared/testing/result'
import { createDispatcher } from '../../commands/dispatcher'
import { inProcessWorkers } from '../../commands/jobs'
import { createAppScopeRegistry } from '../../commands/registry'
import { agentSource, fakeClock, fakeIds } from '../../commands/testing'
import { newProjectDoc } from '../../project/document'
import { FASTENER_TABLE, fastenerRows, lintFastenerTable, type FastenerRow } from './data'

const bySize = (size: string): FastenerRow => {
  const r = FASTENER_TABLE.find((x) => x.size === size)
  if (r === undefined) throw new Error(size)
  return r
}

describe('fastener table', () => {
  it('has ISO metric M1.6–M12 in order (Q29)', () => {
    expect(FASTENER_TABLE.map((r) => r.size)).toEqual([
      'M1.6',
      'M2',
      'M2.5',
      'M3',
      'M4',
      'M5',
      'M6',
      'M8',
      'M10',
      'M12',
    ])
  })

  it('passes the lint: sources for every column, monotonic sizes, holes fit their screws', () => {
    expect(lintFastenerTable(FASTENER_TABLE)).toEqual([])
  })

  it('the lint catches a missing source, a shrinking size and a head larger than its counterbore', () => {
    const m3 = bySize('M3')
    const m4 = bySize('M4')
    const bad: FastenerRow[] = [
      { ...m4, sources: m4.sources.filter((s) => s !== 'ISO 273') },
      { ...m3, counterbore: { diameter: 5 } },
    ]
    expect(lintFastenerTable(bad)).toEqual([
      'M4: clearance has no source',
      'M3: counterbore must exceed the head Ø',
      'M3: sizes must grow with the size',
    ])
  })

  // Spot checks against the standards' dimension tables.
  it('ISO 273 clearance holes (fine / medium / coarse)', () => {
    expect(bySize('M3').clearance).toEqual({ close: 3.2, normal: 3.4, loose: 3.6 })
    expect(bySize('M8').clearance).toEqual({ close: 8.4, normal: 9, loose: 10 })
    expect(bySize('M12').clearance).toEqual({ close: 13, normal: 13.5, loose: 14.5 })
  })

  it('ISO 261 coarse pitch and ISO 2306 tap drill', () => {
    expect([bySize('M3').pitch, bySize('M3').tapDrill]).toEqual([0.5, 2.5])
    expect([bySize('M6').pitch, bySize('M6').tapDrill]).toEqual([1, 5])
    expect([bySize('M10').pitch, bySize('M10').tapDrill]).toEqual([1.5, 8.5])
  })

  it('ISO 4762 head, DIN 974-1 counterbore, ISO 10642 / ISO 7046-1 countersunk head', () => {
    expect(bySize('M5').socketHead).toEqual({ diameter: 8.5, height: 5 })
    expect(bySize('M5').counterbore.diameter).toBe(10)
    expect(bySize('M6').countersunkHead).toEqual({
      diameter: 13.44,
      angle: 90,
      source: 'ISO 10642',
    })
    expect(bySize('M2').countersunkHead).toEqual({ diameter: 4.4, angle: 90, source: 'ISO 7046-1' })
  })

  it('filters by standard and size', () => {
    expect(fastenerRows({})).toHaveLength(10)
    expect(fastenerRows({ standard: 'isoMetric' })).toHaveLength(10)
    expect(fastenerRows({ size: 'M4' }).map((r) => r.size)).toEqual(['M4'])
  })
})

describe('design.fastener.list', () => {
  const agent = agentSource()
  const dispatcher = () =>
    createDispatcher({
      registry: expectOk(createAppScopeRegistry()),
      doc: newProjectDoc({ name: 'Bracket', unitSystem: 'mm' }),
      ids: fakeIds(),
      clock: fakeClock(Date.UTC(2026, 10, 22, 10)),
      services: { workers: inProcessWorkers },
    })

  it('is an app-scope query returning every row with its cited sources', () => {
    const r = expectOk(dispatcher().query('design.fastener.list', {}, agent)).value as {
      rows: { size: string; sources: string[] }[]
      sources: { key: string; ref: string }[]
    }
    expect(r.rows).toHaveLength(10)
    const keys = r.sources.map((s) => s.key)
    for (const row of r.rows) for (const s of row.sources) expect(keys).toContain(s)
  })

  it('size filter returns one row; an unknown size is input.malformed', () => {
    const d = dispatcher()
    const r = expectOk(d.query('design.fastener.list', { size: 'M3' }, agent)).value as {
      rows: { size: string; tapDrill: number }[]
    }
    expect(r.rows).toEqual([expect.objectContaining({ size: 'M3', tapDrill: 2.5 })])
    expectErrCode(d.query('design.fastener.list', { size: 'M7' }, agent), 'input.malformed')
    expectErrCode(d.query('design.fastener.list', { standard: 'inch' }, agent), 'input.malformed')
  })
})
