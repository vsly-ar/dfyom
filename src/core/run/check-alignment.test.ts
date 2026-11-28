// Check alignment (v0.5 RV6): the pointer's stops on the stock outline offset by the gap, the jogs
// between them (along the outline at the sighting height; from elsewhere Go to's safe order, never
// lowering Z before an X/Y move; the travel), the height/gap rules, and Measure: two edge probes
// on the virtual machine's stock turned 0.5° give the angle within 0.02° and the nudge.
// Spec: docs/modes/alignment.md#check-alignment-rv6, docs/plans/v0.5-run.md (RV6)
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import {
  checkMoves,
  checkStops,
  edgeAngle,
  legPoints,
  measureStarts,
  pointerProblem,
  sightZ,
  stopKey,
  type CheckStop,
} from './check-alignment'
import { emulator } from './grbl/emulator.fixture'
import { emuPort } from './probe-port.fixture'
import { runProbeRoutine } from './probe-routines'
import type { PlanStock } from './xy-zero'

type Vec3 = [number, number, number]

const stock = (zero: [number, number] = [0, 0]): PlanStock => ({
  length: 250,
  width: 100,
  thickness: 40,
  zero,
})

describe('checkStops', () => {
  it('corners at the gap, counter-clockwise from the corner nearest the plan zero', () => {
    const stops = checkStops(stock(), 'corners', 2)
    expect(stops.map((s) => s.at)).toEqual([
      [-2, -2],
      [252, -2],
      [252, 102],
      [-2, 102],
    ])
    // the zero on the back-right corner: the walk starts there
    const br = checkStops(stock([250, 100]), 'perimeter', 3)
    expect(br.map(stopKey)).toEqual(['corner:1,1', 'corner:-1,1', 'corner:-1,-1', 'corner:1,-1'])
    expect(br[0]!.at).toEqual([3, 3])
  })

  it('edges: both ends of each edge, the gap outside that edge only, 10 mm in from the corners', () => {
    const stops = checkStops(stock(), 'edges', 2)
    expect(stops).toHaveLength(8)
    expect(stops.map((s) => s.at)).toEqual([
      [10, -2],
      [240, -2],
      [252, 10],
      [252, 90],
      [240, 102],
      [10, 102],
      [-2, 90],
      [-2, 10],
    ])
    // a small stock: a quarter of the edge
    const small = checkStops({ length: 20, width: 12, thickness: 5, zero: [0, 0] }, 'edges', 1)
    expect(small[0]!.at).toEqual([5, -1])
    expect(small[2]!.at).toEqual([21, 3])
  })

  it('both: corners and edge ends in walking order', () => {
    const stops = checkStops(stock(), 'both', 2)
    expect(stops.map(stopKey).slice(0, 4)).toEqual([
      'corner:-1,-1',
      'edge:y-1:-1',
      'edge:y-1:1',
      'corner:1,-1',
    ])
    expect(stops).toHaveLength(12)
  })
})

describe('legPoints', () => {
  const stops = checkStops(stock(), 'both', 2)
  const find = (k: string) => stops.find((s) => stopKey(s) === k)!
  it('passes the outline corners between two stops on different edges', () => {
    expect(legPoints(stock(), 2, find('edge:y-1:1'), find('edge:x1:-1'), 1)).toEqual([
      [252, -2],
      [252, 10],
    ])
    // backwards (Previous): the other way round the corner
    expect(legPoints(stock(), 2, find('edge:x1:-1'), find('edge:y-1:1'), -1)).toEqual([
      [252, -2],
      [240, -2],
    ])
    // from the last corner back to the first (wrapping)
    expect(legPoints(stock(), 2, find('corner:-1,1'), find('corner:-1,-1'), 1)).toEqual([[-2, -2]])
    expect(legPoints(stock(), 2, find('corner:-1,1'), find('corner:-1,1'), 1)).toEqual([])
  })
})

describe('checkMoves', () => {
  // G54 at machine (−400, −300, −60) on the stock top; the travel 800 × 600 × 100
  const wco: Vec3 = [-400, -300, -60]
  const envelope = { travel: [800, 600, 100] as Vec3, pullOff: 1 }
  const corners = checkStops(stock(), 'corners', 2)
  const base = { wco, stock: stock(), gap: 2, height: 2, safeZ: -55, envelope }

  it('the first move: Go to’s safe order (up to the safe height, across, down to the sight)', () => {
    const steps = expectOk(
      checkMoves({ ...base, from: [-300, -250, -70], to: corners[0]!, dir: 1 }),
    )
    expect(steps).toEqual([
      { to: [-300, -250, -55], axis: 'z', feed: 'jog' },
      { to: [-402, -302, -55], axis: 'xy', feed: 'jog' },
      { to: [-402, -302, -58], axis: 'z', feed: 'jog' },
    ])
  })

  it('from a stop: along the outline at the sighting height, at the trace feed', () => {
    const steps = expectOk(
      checkMoves({
        ...base,
        from: [-402, -302, -58],
        fromStop: corners[0]!,
        to: corners[2]!,
        dir: 1,
      }),
    )
    expect(steps).toEqual([
      { to: [-148, -302, -58], axis: 'xy', feed: 'trace' },
      { to: [-148, -198, -58], axis: 'xy', feed: 'trace' },
    ])
  })

  it('never lowers Z before an X/Y move: up first when jogged below, down last when above', () => {
    const below = expectOk(
      checkMoves({
        ...base,
        from: [-402, -302, -61],
        fromStop: corners[0]!,
        to: corners[1]!,
        dir: 1,
      }),
    )
    expect(below[0]).toEqual({ to: [-402, -302, -58], axis: 'z', feed: 'jog' })
    expect(below[1]).toMatchObject({ to: [-148, -302, -58], axis: 'xy' })
    const above = expectOk(
      checkMoves({
        ...base,
        from: [-402, -302, -50],
        fromStop: corners[0]!,
        to: corners[1]!,
        dir: 1,
      }),
    )
    expect(above).toEqual([
      { to: [-148, -302, -50], axis: 'xy', feed: 'trace' },
      { to: [-148, -302, -58], axis: 'z', feed: 'jog' },
    ])
    // every X/Y step runs at or above the lower of the start Z and the sighting height
    for (const steps of [below, above])
      for (const s of steps) if (s.axis === 'xy') expect(s.to[2]).toBeGreaterThanOrEqual(-58)
  })

  it('jogged off the stop in X/Y: the safe order again', () => {
    const steps = expectOk(
      checkMoves({
        ...base,
        from: [-401, -302, -58],
        fromStop: corners[0]!,
        to: corners[1]!,
        dir: 1,
      }),
    )
    expect(steps[0]).toEqual({ to: [-401, -302, -55], axis: 'z', feed: 'jog' })
  })

  it('a stop outside the travel is refused before anything is sent', () => {
    const near: Vec3 = [-1, -1, -60]
    const err = expectErrCode(
      checkMoves({
        ...base,
        wco: near,
        from: [-3, -3, -58],
        fromStop: corners[0]!,
        to: corners[1]!,
        dir: 1,
      }),
      'run.travel',
    )
    expect(err.frames[0]?.data).toMatchObject({ axis: 'x', step: 0 })
  })

  it('the sighting height: the stock top of the zero (DF69 level) plus the height, under the top', () => {
    expect(sightZ({ wcoZ: -60, height: 2 })).toBe(-58)
    expect(sightZ({ wcoZ: -60, zeroLevel: -5, height: -3 })).toBe(-58)
    expect(sightZ({ wcoZ: -0.5, height: 2, envelope })).toBe(-1)
  })
})

describe('pointerProblem', () => {
  it('below the top only with the tool’s side clear of the edge, never below the bottom', () => {
    const p = { toolDiameter: 6, thickness: 40 }
    expect(pointerProblem({ ...p, height: 2, gap: 0 })).toBeUndefined()
    expect(pointerProblem({ ...p, height: -5, gap: 3 })).toBe('sideTouches')
    expect(pointerProblem({ ...p, height: -5, gap: 3.5 })).toBeUndefined()
    expect(pointerProblem({ ...p, height: -40, gap: 10 })).toBe('belowBottom')
    expect(pointerProblem({ ...p, height: 2, gap: -1 })).toBe('negativeGap')
  })
})

describe('edgeAngle', () => {
  it('a front edge rising to the right: counter-clockwise, move the far corner toward Y−', () => {
    const a = edgeAngle(
      stock(),
      { axis: 'y', side: -1 },
      { along: 15, value: 0.1309, uncertainty: 0.001 },
      { along: 235, value: 2.0507, uncertainty: 0.001 },
    )
    expect(a.angle).toBeCloseTo(0.5, 2)
    expect(a.keep).toEqual([-1, -1])
    expect(a.move).toEqual([1, -1])
    expect(a.nudge).toBeCloseTo(250 * Math.tan((0.5 * Math.PI) / 180), 2)
    expect(a.toward).toEqual({ axis: 'y', sign: -1 })
    expect(a.uncertainty).toBeLessThan(0.001)
  })

  it('a left edge: the turn is the opposite sign of ΔX/ΔY; the zero at the back keeps the back', () => {
    const a = edgeAngle(
      stock([0, 100]),
      { axis: 'x', side: -1 },
      { along: 10, value: 0, uncertainty: 0 },
      { along: 90, value: -0.8, uncertainty: 0 },
    )
    expect(a.angle).toBeCloseTo((Math.atan(0.01) * 180) / Math.PI, 6)
    expect(a.keep).toEqual([-1, 1])
    expect(a.move).toEqual([-1, -1])
    // the front end sits +1 mm in X off the back end's line: move it toward X−
    expect(a.nudge).toBeCloseTo(1, 9)
    expect(a.toward).toEqual({ axis: 'x', sign: -1 })
  })
})

describe('Measure on the virtual machine: a stock turned 0.5°', () => {
  it.each([
    ['front edge', { axis: 'y', side: -1 }],
    ['left edge', { axis: 'x', side: -1 }],
    ['back edge', { axis: 'y', side: 1 }],
  ] as const)('%s: the angle within 0.02°', async (_name, edge) => {
    const angle = 0.5
    const plan = stock()
    // the stock's front-left corner at G54 (machine −400, −300), its top at −60, turned about it
    const wco: Vec3 = [-400, -300, -60]
    const box = {
      kind: 'box' as const,
      min: [-400, -300, -100] as Vec3,
      max: [-150, -200, -60] as Vec3,
      angle,
    }
    const points = []
    for (const [x, y] of measureStarts(plan, edge)) {
      const emu = emulator({
        probeScene: { targets: [box] },
        position: [x + wco[0], y + wco[1], -55],
        probeTip: { shape: 'cylinder', radius: 3 },
      })
      emu.readOutput()
      const r = expectOk(
        await runProbeRoutine(emuPort(emu).port, {
          routine: { cycle: 'edge', axis: edge.axis, side: edge.side },
          probe: { kind: 'tool', tipDiameter: 6 },
          reach: 10,
          zDistance: 20,
          depth: 3,
          clearance: 2,
          fastFeed: 200,
          slowFeed: 25,
          moveFeed: 300,
        }),
      )
      const along = edge.axis === 'y' ? x + wco[0] : y + wco[1]
      const v = edge.axis === 'y' ? r.y! : r.x!
      points.push({ along, value: v.value, uncertainty: v.uncertainty })
    }
    const res = edgeAngle(plan, edge, points[0]!, points[1]!)
    expect(Math.abs(res.angle - angle)).toBeLessThanOrEqual(0.02)
    // the nudge squares it: the far end's offset over the edge's length
    const len = edge.axis === 'y' ? 250 : 100
    expect(res.nudge).toBeCloseTo(len * Math.tan((angle * Math.PI) / 180), 1)
  })

  it('the starts lie over the top, inside the plan’s edge', () => {
    const [a, b] = measureStarts(stock(), { axis: 'y', side: -1 })
    expect(a).toEqual([15, 5])
    expect(b).toEqual([235, 5])
    const [c] = measureStarts(stock([250, 100]), { axis: 'x', side: 1 })
    expect(c).toEqual([-5, -85])
  })
})

it('stopKey names every stop uniquely', () => {
  const keys = checkStops(stock(), 'both', 2).map((s: CheckStop) => stopKey(s))
  expect(new Set(keys).size).toBe(keys.length)
})
