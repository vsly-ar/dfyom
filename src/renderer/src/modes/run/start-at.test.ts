// The pre-flight's "Start at" pure parts (DF129 RC3): options, snap, the lead-in read back as
// steps (from core's own lead-in), and the 3D view's skipped segments.
// Doc: docs/modes/run-recovery.md#implementation-rc3
import { describe, expect, it } from 'vitest'
import { resumePoints, resumeProgram, scanProgram } from '../../../../core/run/recovery'
import { fileMoves } from '../../../../core/run/gcode-file'
import type { ToolpathLines } from '../../viewport'
import { leadInSteps, skippedSegments, snapToPoint, startAtOptions, stepText } from './start-at'

/** Two passes of one operation; the second enters on a ramp (lines 15–16). */
const TWO_PASSES = [
  '(Pocket 1)',
  '(DFYOM TOOL CHANGE 1: Flat 6)',
  'M0',
  'G90 G94 G17 G21',
  'G54',
  'M3 S18000',
  'G4 P3',
  'G0 Z5',
  'G0 X10 Y10',
  'G1 Z-1 F150',
  'G1 X20 F600',
  'G1 Y20',
  'G0 Z5',
  'G0 X10 Y10',
  'G1 X12 Z-1.5 F300',
  'G1 X14 Z-2',
  'G1 X20',
  'G1 Y20',
  'G0 Z5',
  'M5',
]

const lead = { topZ: -1, spinUpSeconds: 3, spindleControl: 'gcode' as const }

describe('Start at (DF129 RC3)', () => {
  it('lists the resume points by operation, passes counted, between Beginning and Choose a line…', () => {
    const points = resumePoints(scanProgram(TWO_PASSES))
    expect(points.map((p) => [p.line, p.kind])).toEqual([
      [10, 'operation'],
      [15, 'pass'],
    ])
    expect(startAtOptions(points)).toEqual([
      { value: 'beginning', label: 'Beginning' },
      { value: 'p:10', label: 'Operation start · line 10', group: 'Pocket 1 · tool 1: Flat 6' },
      { value: 'p:15', label: 'Pass 2 · line 15', group: 'Pocket 1 · tool 1: Flat 6' },
      { value: 'line', label: 'Choose a line…' },
    ])
    expect(snapToPoint(points, 17)?.line).toBe(15)
    expect(snapToPoint(points, 9)).toBeUndefined()
  })

  it("reads core's lead-in back as steps: retract, the tool wait, spindle and dwell, XY, down", () => {
    const r = resumeProgram({ lines: TWO_PASSES, sections: [] }, 15, lead).unwrap()
    const { steps, unit } = leadInSteps(r.leadIn)
    expect(unit).toBe('mm')
    expect(steps.map((s) => stepText(s, unit))).toEqual([
      'Spindle and coolant off, then straight up to the machine top.',
      'Waits at tool 1 (the tool-change dialog).',
      'Spindle on at 18,000 rpm, then waits 3 s for it to spin up.',
      'Rapid to X 10 Y 10 mm at the top.',
      'Rapid down to Z 5 mm.',
    ])
    // a line in the cut: down to the rapid height, then the plunge at the program's plunge feed
    const deep = resumeProgram({ lines: TWO_PASSES, sections: [] }, 11, lead).unwrap()
    expect(leadInSteps(deep.leadIn).steps.slice(-2)).toEqual([
      { kind: 'approach', z: '5' },
      { kind: 'plunge', z: '-1', feed: '150' },
    ])
    // a hand-switched spindle pauses instead; an inch program says so
    const manual = resumeProgram({ lines: TWO_PASSES, sections: [] }, 15, {
      ...lead,
      spindleControl: 'manual',
    }).unwrap()
    expect(leadInSteps(manual.leadIn).steps.map((s) => s.kind)).toContain('spindleManual')
    const inch = TWO_PASSES.map((l) => l.replace('G21', 'G20'))
    const r2 = resumeProgram({ lines: inch, sections: [] }, 15, lead).unwrap()
    expect(leadInSteps(r2.leadIn).unit).toBe('in')
  })

  it('dims the moves the program makes before the start line', () => {
    const moves = fileMoves(TWO_PASSES)
    const lines: ToolpathLines = {
      positions: moves.positions.subarray(0, moves.segments * 6),
      kind: new Uint8Array(moves.segments),
      segments: moves.segments,
      starts: new Uint32Array([0]),
    }
    // the moves of lines 8–14 (two rapids, the plunge, two cuts, up, across) come before line 15
    const before = fileMoves(TWO_PASSES.slice(0, 14)).segments
    expect(skippedSegments(lines, TWO_PASSES, 15)).toBe(before)
    expect(skippedSegments(lines, TWO_PASSES, 1)).toBe(0)
  })
})
