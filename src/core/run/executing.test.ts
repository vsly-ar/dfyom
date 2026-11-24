// The executing-line estimate (hardening DF84): planner blocks per line, the `Bf` walk, arcs
// longer than the planner, the position without `Bf`, the floor; and against the emulator's
// planner on a streamed program. Doc: docs/modes/run.md#gcode-panel-df84
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import {
  estimateExecuting,
  lineOfBlock,
  programTrace,
  ProgramTracer,
  type Executing,
} from './executing'
import { connected, drive, machine, start } from './grbl/sender.fixture'

const blocksOf = (t: ReturnType<typeof programTrace>) =>
  Array.from({ length: t.lines }, (_, i) => t.first[i + 1]! - t.first[i]!)

describe('programTrace', () => {
  it('counts one block per linear move, none for lines without motion', () => {
    const t = programTrace([
      '(pocket1)',
      'G90 G94 G17 G21',
      'G0 Z5',
      'M3 S12000',
      'G4 P1',
      'G1 X10 F600',
      'X10', // zero length: GRBL plans nothing
      'Y5 ; a comment',
      'G1 X0 Y0 (back)',
    ])
    expect(blocksOf(t)).toEqual([0, 0, 1, 0, 0, 1, 0, 1, 1])
    expect(Array.from(t.ends.slice(3, 6))).toEqual([10, 0, 5])
    expect(lineOfBlock(t, 0)).toBe(3)
    expect(lineOfBlock(t, 1)).toBe(6)
    expect(lineOfBlock(t, 3)).toBe(9)
  })

  it('splits an arc into its $12 segments, in inch programs too', () => {
    const quarter = programTrace(['G0 X10 Y0', 'G3 X0 Y10 I-10 J0 F500'])
    // floor(0.5 · π/2 · 10 / sqrt(0.002 · (20 − 0.002))) = 39 segments
    expect(blocksOf(quarter)).toEqual([1, 39])
    const coarse = programTrace(['G0 X10 Y0', 'G3 X0 Y10 I-10 J0 F500'], { arcTolerance: 0.1 })
    expect(blocksOf(coarse)[1]).toBeLessThan(39)
    const inch = programTrace(['G20', 'G0 X1', 'G1 X2 F10'])
    expect(Array.from(inch.ends.slice(0, 6))).toEqual([25.4, 0, 0, 50.8, 0, 0])
  })

  it('skips a line the parser refuses without losing the modal state', () => {
    const t = programTrace(['G1 X1 F100', 'G1 X1 Q7', 'X2'])
    expect(blocksOf(t)).toEqual([1, 0, 1])
  })
})

describe('estimateExecuting', () => {
  // ten one-block lines after a two-line header
  const lines = ['G21 G90', 'G0 Z5', ...Array.from({ length: 10 }, (_, i) => `G1 X${i + 1} F600`)]
  const t = programTrace(lines)

  it('walks back from the acknowledged lines by the blocks in the planner (Bf)', () => {
    // 12 acknowledged, 3 blocks in the planner: lines 10, 11, 12 → executing 10
    expect(estimateExecuting(t, { acknowledged: 12, sent: 12, blocksFree: 12 })?.line).toBe(10)
    expect(estimateExecuting(t, { acknowledged: 12, sent: 12, blocksFree: 14 })?.line).toBe(12)
    // a bigger planner (grblHAL) through the capacity seen
    expect(
      estimateExecuting(t, { acknowledged: 12, sent: 12, blocksFree: 30, capacity: 35 })?.line,
    ).toBe(8)
  })

  it('is in the next sent line with an empty planner, else at the last acknowledged', () => {
    const header = programTrace(['G21', 'M3 S1000', 'G4 P2', 'G0 X1'])
    expect(estimateExecuting(header, { acknowledged: 2, sent: 4, blocksFree: 15 })?.line).toBe(3)
    expect(estimateExecuting(header, { acknowledged: 4, sent: 4, blocksFree: 15 })?.line).toBe(4)
    expect(estimateExecuting(header, { acknowledged: 0, sent: 0, blocksFree: 15 })).toBeUndefined()
  })

  it('finds the arc GRBL is still splitting by the position', () => {
    const arc = programTrace(['G0 X10 Y0', 'G1 X10 Y1 F500', 'G3 X0 Y11 I-10 J0'])
    // line 3 not acknowledged yet; the planner is full of its segments, the tool on its 20th
    const seg = 20
    const p = [arc.ends[(2 + seg) * 3]!, arc.ends[(2 + seg) * 3 + 1]!, 0] as const
    const e = estimateExecuting(arc, { acknowledged: 2, sent: 3, blocksFree: 0, position: p })
    expect(e?.line).toBe(3)
    // without the position: the walk back alone (the lower bound)
    expect(estimateExecuting(arc, { acknowledged: 2, sent: 3, blocksFree: 0 })?.line).toBe(1)
  })

  it('takes the nearest block of the planner window without Bf', () => {
    const e = estimateExecuting(t, { acknowledged: 12, sent: 12, position: [6.5, 0, 5] })
    expect(e?.line).toBe(9) // the move from X6 to X7
  })

  it('waits for the trace to reach the lines in play when traced in slices', () => {
    const tracer = new ProgramTracer(lines)
    tracer.step(5)
    expect(tracer.finished).toBe(false)
    expect(estimateExecuting(tracer.trace, { acknowledged: 12, sent: 12, blocksFree: 12 })).toBe(
      undefined,
    )
    expect(
      estimateExecuting(tracer.trace, { acknowledged: 3, sent: 4, blocksFree: 14 })?.line,
    ).toBe(3)
    tracer.step(100)
    expect(tracer.finished).toBe(true)
    expect(
      estimateExecuting(tracer.trace, { acknowledged: 12, sent: 12, blocksFree: 12 })?.line,
    ).toBe(10)
    expect(Array.from(tracer.trace.first)).toEqual(Array.from(t.first))
  })

  it('tells a retrace from a move ahead by the direction moved since the last report', () => {
    // there and back on X: at X 5 the machine is on line 7 going out or line 15 coming back
    const back = ['G21 G90 G1 F600', ...Array.from({ length: 10 }, (_, i) => `X${i + 1}`)]
    back.push(...Array.from({ length: 10 }, (_, i) => `X${9 - i}`))
    const r = programTrace(back)
    const input = { acknowledged: 21, sent: 21, capacity: 25 }
    const out = estimateExecuting(r, { ...input, position: [5, 0, 0], previous: [4.5, 0, 0] })
    const home = estimateExecuting(r, { ...input, position: [5, 0, 0], previous: [5.5, 0, 0] })
    expect(out?.line).toBeLessThan(home!.line)
    expect(lineOfBlock(r, out!.block)).toBe(out!.line)
  })

  it('never goes back during one run (floor)', () => {
    const first = estimateExecuting(t, { acknowledged: 12, sent: 12, blocksFree: 14 }) as Executing
    expect(first.line).toBe(12)
    expect(
      estimateExecuting(t, { acknowledged: 12, sent: 12, blocksFree: 10, floor: first.block })
        ?.line,
    ).toBe(12)
  })
})

describe('against the emulator', () => {
  /** A post-like program with arcs longer than the planner and short moves. */
  function program(): string[] {
    const lines = ['(test)', 'G90 G94 G17 G21', 'G54', 'G0 Z5', 'M3 S12000', 'G4 P1']
    for (let i = 0; i < 30; i++) {
      lines.push(`G1 X${(i % 2) * 20} Y${i} Z-1 F1200`)
      lines.push(`G2 X${(i % 2) * 20 + 2} Y${i + 1} I1 J0.5`)
      lines.push(`G1 X${(i % 2) * 20 + 2.2} F800`)
    }
    lines.push('G0 Z5', 'M5', 'M30')
    return lines
  }

  for (const withBf of [true, false])
    it(`equals the line the planner executes at nearly every report (${withBf ? 'Bf' : 'no Bf'})`, async () => {
      const lines = program()
      const r = await connected(machine({ settings: { 10: withBf ? 3 : 1, 12: 0.002 } }))
      const trace = programTrace(lines, { arcTolerance: 0.002 })
      const offset = r.emu.trace.lines.length
      let floor: number | undefined
      let capacity = 15
      let previous: readonly [number, number, number] | undefined
      const samples: { estimate: number; truth: number }[] = []
      r.sender.onStatus((s) => {
        if (s.buffer !== undefined) capacity = Math.max(capacity, s.buffer.blocks)
        const acknowledged = r.sender.acknowledged
        const sent = r.sender.sent
        if (acknowledged === undefined || sent === undefined) return
        const e = estimateExecuting(trace, {
          acknowledged,
          sent,
          blocksFree: s.buffer?.blocks,
          capacity,
          position: s.wpos,
          previous,
          floor,
        })
        if (e === undefined) return
        floor = e.block >= 0 ? e.block : floor
        previous = s.wpos
        const executing = r.emu.status().executing
        if (executing !== undefined)
          samples.push({ estimate: e.line, truth: executing - offset + 1 })
      })
      expectOk(await drive(r.clock, start(r, lines)))
      expect(samples.length).toBeGreaterThan(50)
      const exact = samples.filter((x) => x.estimate === x.truth).length
      expect(exact / samples.length).toBeGreaterThan(withBf ? 0.95 : 0.9)
      for (const x of samples) expect(Math.abs(x.estimate - x.truth)).toBeLessThanOrEqual(1)
    })
})
