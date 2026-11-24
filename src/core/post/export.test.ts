/**
 * Export: toolpaths → MachiningProgram, machine checks, program stats.
 * Spec: docs/architecture/grbl.md#input-boundary and #export-checks
 */
import { describe, expect, it } from 'vitest'
import { None } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { feed, len, rpm } from '../library/library.fixture'
import type { Move, Toolpath } from '../toolpath/model'
import { toolpathStats } from '../toolpath/stats'
import { drill, endMill, RATES } from '../toolpath/testing/fixtures'
import { exportGrbl, toMachiningProgram } from './export'
import { exportInput, operation, OPTS, testMachine, testPartExport } from './post.fixture'

function toolpath(id: string, tool: string, spindleSpeed: number, moves: Move[]): Toolpath {
  const passes = [{ kind: 'rough' as const, moves }]
  return { planOperationId: id, tool, spindleSpeed, passes, stats: toolpathStats(passes, RATES) }
}

/** A 10 mm square at Z −1 from (0, 0), with an arc corner; clearance 10. */
const square = (id: string, tool = 'em6', rpmValue = 12000, f = 1000): Toolpath =>
  toolpath(id, tool, rpmValue, [
    { kind: 'rapid', to: [0, 0, 10] },
    { kind: 'rapid', to: [0, 0, 2] },
    { kind: 'line', to: [0, 0, -1], feed: 300 },
    { kind: 'line', to: [10, 0, -1], feed: f },
    { kind: 'arc', to: [10, 10, -1], center: [10, 5], cw: false, feed: f },
    { kind: 'line', to: [0, 10, -1], feed: f },
    { kind: 'rapid', to: [0, 10, 10] },
  ])

const hole = (cycle: 'simple' | 'peck' | 'chipBreak'): Toolpath =>
  toolpath('hole', 'dr6', 3000, [
    { kind: 'rapid', to: [5, 5, 10] },
    { kind: 'rapid', to: [5, 5, 2] },
    {
      kind: 'drill',
      at: [5, 5],
      top: 0,
      bottom: -10,
      cycle,
      peck: 4,
      back: 0.5,
      retract: 2,
      feed: 100,
    },
    { kind: 'rapid', to: [5, 5, 10] },
  ])

describe('toMachiningProgram', () => {
  it('numbers tools by first use, changes tools and speeds only when they change', () => {
    const m = testMachine()
    const p = expectOk(
      toMachiningProgram(
        exportInput([
          operation(square('a'), endMill(6), 'Op A'),
          operation(square('b', 'em6', 15000), endMill(6), 'Op B'),
          operation(square('c', 'dr6', 3000), drill(6), 'Op C'),
          operation(square('d'), endMill(6), 'Op D'),
        ]),
        m,
      ),
    )
    const head = p.blocks.filter((b) => b.kind !== 'rapid' && b.kind !== 'feed' && b.kind !== 'arc')
    expect(head).toEqual([
      { kind: 'comment', text: 'Op A' },
      {
        kind: 'toolChange',
        number: 1,
        tool: { name: '6 mm flat end mill', diameter: 6, type: 'flatEndMill' },
      },
      { kind: 'spindle', rpm: 12000 },
      { kind: 'comment', text: 'Op B' },
      { kind: 'spindle', rpm: 15000 },
      { kind: 'comment', text: 'Op C' },
      { kind: 'toolChange', number: 2, tool: { name: '6 mm drill', diameter: 6, type: 'drill' } },
      { kind: 'spindle', rpm: 3000 },
      { kind: 'comment', text: 'Op D' },
      {
        kind: 'toolChange',
        number: 1,
        tool: { name: '6 mm flat end mill', diameter: 6, type: 'flatEndMill' },
      },
      { kind: 'spindle', rpm: 12000 },
    ])
    expect(p).toMatchObject({ units: 'mm', spindleControl: 'gcode', clearanceZ: 10 })
  })

  it('converts arc centers to I/J offsets from the start', () => {
    const p = expectOk(
      toMachiningProgram(exportInput([operation(square('a'), endMill(6))]), testMachine()),
    )
    expect(p.blocks.find((b) => b.kind === 'arc')).toEqual({
      kind: 'arc',
      to: [10, 10, -1],
      i: 0,
      j: 5,
      cw: false,
      feed: 1000,
    })
  })

  it('expands drill cycles (never G81–G83); inch programs peck back to 0.02″', () => {
    const zs = (units: 'mm' | 'in') =>
      expectOk(
        toMachiningProgram(
          exportInput([operation(hole('peck'), drill(6))]),
          testMachine({ programUnits: units }),
        ),
      ).blocks.flatMap((b) => ('to' in b ? [`${b.kind} ${+b.to[2].toFixed(3)}`] : []))
    expect(zs('mm')).toEqual([
      'rapid 10',
      'rapid 2',
      'feed -4',
      'rapid 2',
      'rapid -3.5',
      'feed -8',
      'rapid 2',
      'rapid -7.5',
      'feed -10',
      'rapid 2',
      'rapid 10',
    ])
    expect(zs('in')).toContain('rapid -3.492')
    const text = expectOk(
      exportGrbl(exportInput([operation(hole('chipBreak'), drill(6))]), OPTS),
    ).text
    expect(text).not.toMatch(/G8\d/)
    expect(text).toContain('G0 Z-3.5\nG1 Z-8\n')
  })

  it('fails without toolpaths', () => {
    expectErrCode(toMachiningProgram(exportInput([]), testMachine()), 'model.invariant')
  })

  it('requires a clearance above Z0 and above every toolpath', () => {
    const op = [operation(square('a'), endMill(6))]
    const rules = (clearanceHeight: number) =>
      expectErrCode(
        toMachiningProgram(
          exportInput(op, testMachine(), { setup: { name: 'S', clearanceHeight } }),
          testMachine(),
        ),
        'model.invariant',
      ).issues.map((i) => i.rule)
    expect(rules(0)).toContain('clearance')
    expect(rules(-5)).toContain('clearance')
    // the toolpath rapids at Z 10: a clearance of 5 lies below it
    expect(rules(5)).toEqual(['clearance'])
  })
})

describe('exportGrbl', () => {
  it('requires a machine', () => {
    const input = exportInput([operation(square('a'), endMill(6))])
    expectErrCode(exportGrbl({ ...input, machine: None }, OPTS), 'post.noMachine')
  })

  it('returns lines and text with a final newline', () => {
    const e = expectOk(exportGrbl(exportInput([operation(square('a'), endMill(6))]), OPTS))
    expect(e.text).toBe(`${e.lines.join('\n')}\n`)
    expect(e.warnings).toEqual([])
  })

  describe('machine checks (plan.machine warnings)', () => {
    const rules = (warnings: readonly { rule: string; params: Record<string, unknown> }[]) =>
      warnings.map((w) => `${w.rule} ${String(w.params['axis'] ?? '')}`.trim())

    it('feed rates against each axis they move (as GRBL limits them)', () => {
      const m = testMachine({ maxFeedRate: { x: feed('5000'), y: feed('800'), z: feed('200') } })
      const e = expectOk(exportGrbl(exportInput([operation(square('a'), endMill(6))], m), OPTS))
      // the plunge at 300 > Z 200; the arc and the Y-free lines at 1000 > Y 800
      expect(e.warnings.map((w) => [w.planOperationId, w.field, w.rule, w.params])).toEqual([
        ['a', 'plungeRate', 'maxFeedRate', { feed: 300, axis: 'z', speed: 300, max: 200 }],
      ])
      const fast = testMachine({
        maxFeedRate: { x: feed('5000'), y: feed('800'), z: feed('1000') },
      })
      const f = expectOk(exportGrbl(exportInput([operation(square('a'), endMill(6))], fast), OPTS))
      expect(f.warnings.map((w) => [w.field, w.params['axis'], w.params['max']])).toEqual([
        ['feedRate', 'y', 800],
      ])
    })

    it('spindle speed within the range (GRBL clamps silently)', () => {
      const m = testMachine({
        spindle: { control: 'gcode', maxSpeed: rpm('24000'), minSpeed: rpm('8000') },
      })
      const e = expectOk(exportGrbl(exportInput([operation(hole('simple'), drill(6))], m), OPTS))
      expect(e.warnings.map((w) => [w.planOperationId, w.rule, w.params])).toEqual([
        ['hole', 'spindleRange', { spindleSpeed: 3000, min: 8000, max: 24000 }],
      ])
    })

    it('program extent against the travel; soft limits once the work zero is known', () => {
      const m = testMachine({ travel: { x: len('100'), y: len('45'), z: len('40') } })
      const tp = testPartExport(m)
      // the test part spans 114 mm in X (facing overshoot), 50 mm in Y (tool centers), 34 mm in Z
      const e = expectOk(exportGrbl(tp, OPTS))
      expect(rules(e.warnings.filter((w) => w.rule !== 'maxFeedRate'))).toEqual([
        'travel x',
        'travel y',
      ])
      const z = expectOk(exportGrbl({ ...tp, workZero: [-90, -5, -5] }, OPTS))
      expect(rules(z.warnings.filter((w) => w.rule !== 'maxFeedRate'))).toEqual([
        'travel x',
        'softLimit x',
        'travel y',
        'softLimit y',
        'softLimit z',
      ])
      const sl = z.warnings.find((w) => w.rule === 'softLimit' && w.params['axis'] === 'z')!
      expect(sl.params['max']).toBe(5) // clearance 10 above a work zero 5 below the top
    })

    it('Z soft limits only for the first tool (later tools re-zero Z)', () => {
      const m = testMachine({ travel: { x: len('800'), y: len('800'), z: len('25') } })
      // facing (first tool) spans -11.5..-1 in MPos; the drills reach about -33 after re-zeroing
      const e = expectOk(exportGrbl({ ...testPartExport(m), workZero: [-200, -200, -11] }, OPTS))
      const found = rules(e.warnings.filter((w) => w.rule !== 'maxFeedRate'))
      expect(found).toEqual(['travel z'])
      const high = expectOk(exportGrbl({ ...testPartExport(m), workZero: [-200, -200, -5] }, OPTS))
      expect(rules(high.warnings)).toContain('softLimit z')
    })

    it('arc bulges count for the extent', () => {
      const m = testMachine({ travel: { x: len('800'), y: len('800'), z: len('100') } })
      const e = expectOk(
        exportGrbl(
          { ...exportInput([operation(square('a'), endMill(6))], m), workZero: [-15, -500, -50] },
          OPTS,
        ),
      )
      // the arc around (10, 5) with R5 reaches X 15 → MPos 0: inside; one more mm is not
      expect(e.warnings).toEqual([])
      const out = expectOk(
        exportGrbl(
          { ...exportInput([operation(square('a'), endMill(6))], m), workZero: [-14.9, -500, -50] },
          OPTS,
        ),
      )
      expect(rules(out.warnings)).toEqual(['softLimit x'])
    })
  })

  describe('stats', () => {
    it('count tool changes, dwells and moves from known positions only', () => {
      const e = expectOk(
        exportGrbl(
          exportInput([operation(square('a'), endMill(6)), operation(hole('simple'), drill(6))]),
          OPTS,
        ),
      )
      expect(e.stats.toolChanges).toBe(1)
      expect(e.stats.dwellSeconds).toBe(6)
      // feed: square 3 + 10 + 5π + 10, hole 12
      expect(e.stats.cutLength).toBeCloseTo(3 + 20 + 5 * Math.PI + 12, 9)
      const firstLoaded = expectOk(
        exportGrbl(exportInput([operation(square('a'), endMill(6))]), {
          ...OPTS,
          firstToolLoaded: false,
        }),
      )
      expect(firstLoaded.stats.toolChanges).toBe(1)
    })

    it('agree with the toolpath estimates plus the moves between them and the dwells', () => {
      const input = testPartExport()
      const e = expectOk(exportGrbl(input, OPTS))
      const sum = input.operations.reduce((t, o) => t + o.toolpath.stats.estimatedSeconds, 0)
      const cut = input.operations.reduce((t, o) => t + o.toolpath.stats.cutLength, 0)
      expect(e.stats.cutLength).toBeCloseTo(cut, 6)
      expect(e.stats.estimatedSeconds - e.stats.dwellSeconds).toBeGreaterThanOrEqual(sum - 1e-6)
      expect(e.stats.estimatedSeconds - e.stats.dwellSeconds).toBeLessThan(sum * 1.05)
    })
  })
})
