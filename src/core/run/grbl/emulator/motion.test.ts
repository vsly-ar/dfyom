// Motion timing of the virtual machine against trapezoid and junction-deviation math.
// Spec: docs/architecture/grbl.md#motion-timing
import { describe, expect, it } from 'vitest'
import { emulator, outLines, send, settle } from '../emulator.fixture'
import { parseBlock, initialParserState } from './gcode'
import { Planner } from './planner'
import { holdProfile, sampleProfile, trapezoid } from './profile'

// FAST machine: a = 100 mm/s² per axis, max rate 6000 mm/min, $11 = 0.010 mm.
const A = 100

/** Time (s) for a block from v0 to v1 over L at nominal vn, by the textbook trapezoid. */
function blockTime(L: number, v0: number, vn: number, v1: number, a = A): number {
  const peak = Math.sqrt((2 * a * L + v0 * v0 + v1 * v1) / 2)
  const vm = Math.min(peak, vn)
  const da = (vm * vm - v0 * v0) / (2 * a)
  const dd = (vm * vm - v1 * v1) / (2 * a)
  return (vm - v0) / a + (L - da - dd) / vm + (vm - v1) / a
}

const lineTimes = (emu: ReturnType<typeof emulator>) =>
  emu.trace.lines.map((l) => ({ text: l.text, start: l.startedAt, end: l.endedAt }))

describe('trapezoid profile', () => {
  it('builds accelerate–cruise–decelerate phases', () => {
    const p = trapezoid(100, 0, 50, 0, A)
    expect(p.phases.map((ph) => [ph.dt, ph.a])).toEqual([
      [0.5, 100],
      [1.5, 0],
      [0.5, -100],
    ])
    expect(p.duration).toBeCloseTo(2.5, 12)
    expect(sampleProfile(p, 0.5)).toEqual({ s: 12.5, v: 50 })
    expect(sampleProfile(p, 99)).toEqual({ s: 100, v: 0 })
  })

  it('becomes a triangle when the nominal speed is out of reach', () => {
    const p = trapezoid(10, 0, 50, 0, A)
    expect(p.phases).toHaveLength(2)
    expect(p.duration).toBeCloseTo(2 * Math.sqrt(10 / A), 12)
  })

  it('decelerates first when an override lowered the nominal speed', () => {
    const p = trapezoid(100, 50, 25, 0, A)
    expect(p.phases[0]).toMatchObject({ v0: 50, a: -100 })
    expect(p.duration).toBeCloseTo(0.25 + (100 - 9.375 - 3.125) / 25 + 0.25, 12)
  })

  it('feed hold stops inside the block or carries the remaining speed', () => {
    expect(holdProfile(100, 50, A)).toMatchObject({ length: 12.5, exitSpeed: 0 })
    const partial = holdProfile(4.5, 50, A)
    expect(partial).toMatchObject({ length: 4.5 })
    expect(partial.exitSpeed).toBeCloseTo(40, 12)
  })
})

describe('planner', () => {
  const limits = {
    maxRate: [6000, 6000, 6000] as const,
    accel: [A, A, A] as const,
    junctionDeviation: 0.01,
  }

  it('computes the junction-deviation corner speed for a 90° turn', () => {
    const p = new Planner(limits)
    p.add([0, 0, 0], {
      target: [50, 0, 0],
      rapid: false,
      feed: 3000,
      jog: false,
      line: 0,
      lastOfLine: true,
    })
    p.add([50, 0, 0], {
      target: [50, 50, 0],
      rapid: false,
      feed: 3000,
      jog: false,
      line: 1,
      lastOfLine: true,
    })
    // cos θ = 0 → sin(θ/2) = √½; junction acceleration along (−1,1)/√2 = 100·√2.
    const s = Math.SQRT1_2
    const expected = (A * Math.SQRT2 * 0.01 * s) / (1 - s)
    expect(p.blocks[1]?.maxJunctionSq).toBeCloseTo(expected, 9)
    expect(p.blocks[1]?.entrySq).toBeCloseTo(expected, 9)
    expect(p.free).toBe(13)
  })

  it('looks ahead: a long collinear chain keeps full speed at the junctions', () => {
    const p = new Planner(limits)
    for (let i = 0; i < 10; i++) {
      p.add([i * 10, 0, 0], {
        target: [(i + 1) * 10, 0, 0],
        rapid: false,
        feed: 3000,
        jog: false,
        line: i,
        lastOfLine: true,
      })
    }
    const entries = p.blocks.map((b) => Math.sqrt(b.entrySq))
    expect(entries[0]).toBe(0)
    // Reachable from rest: √(2·a·s), capped at 50 mm/s; must also stop by the end (reverse pass).
    expect(entries[1]).toBeCloseTo(Math.sqrt(2 * A * 10), 9)
    expect(entries[5]).toBeCloseTo(50, 9)
    expect(entries[9]).toBeCloseTo(Math.sqrt(2 * A * 10), 9)
  })

  it('skips zero-length moves', () => {
    const p = new Planner(limits)
    expect(
      p.add([1, 2, 3], {
        target: [1, 2, 3],
        rapid: true,
        feed: 0,
        jog: false,
        line: 0,
        lastOfLine: true,
      }),
    ).toBe(false)
    expect(p.free).toBe(15)
  })
})

describe('emulated timing', () => {
  it('times a single feed move by the trapezoid (2.5 s for 100 mm at 3000 mm/min)', () => {
    const emu = emulator()
    send(emu, 'G1 X100 F3000\n')
    emu.advance(1250)
    expect(emu.status()).toMatchObject({ state: 'Run', rate: 3000 })
    expect(emu.status().mpos[0]).toBeCloseTo(50, 9)
    settle(emu)
    expect(lineTimes(emu)[0]).toEqual({ text: 'G1 X100 F3000', start: 0, end: 2500 })
    expect(emu.status()).toMatchObject({ state: 'Idle', mpos: [100, 0, 0] })
  })

  it('rapids at the axis-limited max rate ($110–$112) with its acceleration', () => {
    const emu = emulator({ settings: { 110: 3000, 111: 6000, 120: 100, 121: 100 } })
    send(emu, 'G0 X100\n')
    settle(emu)
    expect(emu.trace.lines[0]?.endedAt).toBeCloseTo(2500, 6)
    // Diagonal: the X limit dominates (3000 / cos 45°), acceleration 100 / cos 45°.
    const d = emulator({ settings: { 110: 3000, 111: 3000, 120: 100, 121: 100 } })
    send(d, 'G0 X100 Y100\n')
    settle(d)
    const v = 50 * Math.SQRT2
    const a = 100 * Math.SQRT2
    expect(d.trace.lines[0]?.endedAt).toBeCloseTo(blockTime(100 * Math.SQRT2, 0, v, 0, a) * 1000, 6)
  })

  it('keeps full speed through collinear blocks (look-ahead)', () => {
    const emu = emulator()
    send(emu, 'G1 X50 F3000\nG1 X100\n')
    settle(emu)
    expect(emu.trace.lines[1]?.endedAt).toBeCloseTo(2500, 6)
    const junction = emu.trace.samples.find((s) => s.mpos[0] === 50)
    expect(junction?.rate).toBeCloseTo(3000, 6)
  })

  it('slows to the junction-deviation speed at a 90° corner', () => {
    const emu = emulator()
    send(emu, 'G1 X50 F3000\nG1 Y50\n')
    settle(emu)
    const s = Math.SQRT1_2
    const vj = Math.sqrt((A * Math.SQRT2 * 0.01 * s) / (1 - s)) // ≈ 1.848 mm/s
    const corner = emu.trace.samples.find((x) => x.mpos[0] === 50 && x.mpos[1] === 0 && x.rate > 0)
    expect(corner?.rate).toBeCloseTo(vj * 60, 6)
    const t1 = blockTime(50, 0, 50, vj)
    expect(emu.trace.lines[0]?.endedAt).toBeCloseTo(t1 * 1000, 6)
    expect(emu.trace.lines[1]?.endedAt).toBeCloseTo(2 * t1 * 1000, 6)
  })

  it('stops between blocks when the next line arrives too late', () => {
    const emu = emulator()
    send(emu, 'G1 X10 F3000\n')
    settle(emu)
    send(emu, 'G1 X20\n')
    settle(emu)
    const t = blockTime(10, 0, 50, 0) * 1000
    expect(emu.trace.lines[1]).toMatchObject({ startedAt: t })
    expect(emu.trace.lines[1]?.endedAt).toBeCloseTo(2 * t, 6)
  })

  it('re-plans the running block when a new block arrives mid-way', () => {
    const emu = emulator()
    send(emu, 'G1 X100 F3000\n')
    emu.advance(1000) // cruising at 50 mm/s, x = 37.5
    send(emu, 'G1 X200\n')
    settle(emu)
    // Same as one 200 mm move: 0.5 s + 175 mm / 50 + 0.5 s.
    expect(emu.trace.lines[1]?.endedAt).toBeCloseTo(4500, 6)
  })

  it('scales feed moves by the feed override, rapids by the rapid override', () => {
    const emu = emulator({ settings: { 120: 10_000 } })
    send(emu, '\x92'.repeat(5)) // 50 %
    send(emu, 'G1 X100 F3000\n')
    settle(emu)
    // 25 mm/s, a = 10000 mm/s²: 4 s + 2.5 ms of ramps.
    expect(emu.trace.lines[0]?.endedAt).toBeCloseTo(blockTime(100, 0, 25, 0, 10_000) * 1000, 6)
    send(emu, '\x96G0 X0\n') // rapid 50 % of 6000
    settle(emu)
    const rapid = emu.trace.lines[1]
    expect((rapid?.endedAt ?? 0) - (rapid?.startedAt ?? 0)).toBeCloseTo(
      blockTime(100, 0, 50, 0, 10_000) * 1000,
      6,
    )
  })

  it('applies an override change mid-move by re-planning from the current speed', () => {
    const emu = emulator()
    send(emu, 'G1 X100 F3000\n')
    emu.advance(1000) // x = 37.5 at 50 mm/s
    send(emu, '\x92'.repeat(5)) // 50 % → 25 mm/s
    settle(emu)
    // Decelerate 50→25 (9.375 mm, 0.25 s), cruise, decelerate 25→0 (3.125 mm, 0.25 s).
    const cruise = (62.5 - 9.375 - 3.125) / 25
    expect(emu.trace.lines[0]?.endedAt).toBeCloseTo(1000 + (0.25 + cruise + 0.25) * 1000, 6)
  })

  it('feed hold decelerates, holds position and resumes from rest', () => {
    const emu = emulator()
    send(emu, 'G1 X100 F3000\n')
    emu.advance(1000) // x = 37.5 at 50 mm/s
    send(emu, '!')
    expect(emu.status().state).toBe('Hold:1')
    settle(emu)
    expect(emu.status()).toMatchObject({ state: 'Hold:0', rate: 0 })
    expect(emu.status().mpos[0]).toBeCloseTo(50, 9) // 12.5 mm of deceleration
    expect(emu.time).toBeCloseTo(1500, 9)
    emu.advance(10_000)
    send(emu, '~')
    expect(emu.status().state).toBe('Run')
    settle(emu)
    // 50 mm left from rest: 2.5 s − ... = 0.5 + 25/50 + 0.5 = 1.5 s.
    expect(emu.trace.lines[0]?.endedAt).toBeCloseTo(11_500 + 1500, 6)
    expect(emu.status()).toMatchObject({ state: 'Idle', mpos: [100, 0, 0] })
    expect(emu.trace.transitions.map((t) => t.to)).toEqual([
      'Run',
      'Hold:1',
      'Hold:0',
      'Run',
      'Idle',
    ])
  })

  it('a hold that spans block boundaries decelerates through the next blocks', () => {
    const emu = emulator()
    send(emu, 'G1 X10 F3000\nG1 X20\nG1 X30\nG1 X100\n')
    emu.advance(1000)
    const x0 = emu.status().mpos[0]
    const v0 = emu.status().rate / 60
    send(emu, '!')
    settle(emu)
    expect(emu.status().mpos[0]).toBeCloseTo(x0 + (v0 * v0) / (2 * A), 6)
    send(emu, '~')
    settle(emu)
    expect(emu.status().mpos).toEqual([100, 0, 0])
  })

  it('splits arcs into chords within $12 like GRBL mc_arc()', () => {
    const r = parseBlock('G3X10Y10I0J10F100', initialParserState([0, 0, 0], [0, 0, 0]), {
      arcTolerance: 0.002,
    })
    const moves = r.unwrap().actions
    // floor(½·(π/2)·10 / √(0.002·(20 − 0.002))) = 39 segments.
    expect(moves).toHaveLength(39)
    for (const m of moves) {
      if (m.kind !== 'move') throw new Error('not a move')
      expect(Math.hypot(m.target[0], m.target[1] - 10)).toBeCloseTo(10, 9)
    }
    expect(moves.at(-1)).toMatchObject({ target: [10, 10, 0] })
  })

  it('executes an arc of ~22 000 chords in linear time', () => {
    const emu = emulator({ settings: { 12: 0.001, 120: 1e6, 121: 1e6 }, trace: false })
    const start = Date.now()
    send(emu, 'G2 X0 Y0 I100000 J0 F6000\n')
    settle(emu, 1e12)
    expect(Date.now() - start).toBeLessThan(2000)
    expect(emu.status()).toMatchObject({ state: 'Idle', plannerFree: 15 })
  })

  it('times a helix by its chord path and planner', () => {
    const emu = emulator({ settings: { 120: 100_000, 121: 100_000, 122: 100_000 } })
    send(emu, 'G2 X0 Y0 Z-1 I5 J0 F600\n')
    settle(emu)
    // Full circle at 10 mm/s with near-instant ramps: chords are a little shorter than 2π·5.
    const t = emu.trace.lines[0]?.endedAt ?? 0
    expect(t).toBeGreaterThan(3000)
    expect(t).toBeLessThan(3200)
    expect(emu.status().mpos[2]).toBeCloseTo(-1, 9)
  })

  it('dwells G4 P seconds after the planner empties; the spindle starts at once', () => {
    const emu = emulator({ settings: { 30: 24000 } })
    outLines(emu)
    send(emu, 'G1 X10 F3000\nM3 S12000\nG4 P3\nG1 X20\n')
    settle(emu)
    const [move, m3, dwell, next] = emu.trace.lines
    const moveEnd = blockTime(10, 0, 50, 0) * 1000
    expect(move?.endedAt).toBeCloseTo(moveEnd, 9)
    expect(m3?.ackedAt).toBeCloseTo(moveEnd, 9) // M3 synchronizes with motion
    expect(dwell).toMatchObject({ startedAt: m3?.ackedAt })
    expect(dwell?.endedAt).toBeCloseTo(moveEnd + 3000, 9)
    expect(next?.startedAt).toBeCloseTo(moveEnd + 3000, 9)
  })

  it('reports Idle with the spindle running during the dwell; ! pauses the dwell', () => {
    const emu = emulator({ settings: { 30: 24000 } })
    send(emu, 'M3 S12000\nG4 P3\n')
    emu.advance(1000)
    expect(emu.status()).toMatchObject({ state: 'Idle', spindleSpeed: 12000 })
    send(emu, '!')
    emu.advance(5000)
    expect(emu.status().state).toBe('Hold:0')
    send(emu, '~')
    settle(emu)
    expect(emu.trace.lines[1]?.endedAt).toBe(8000)
  })
})
