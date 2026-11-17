/**
 * End to end: the test part's GRBL program streamed through the virtual machine (task 3.8) with
 * character counting. Doc: docs/architecture/grbl.md#determinism-and-tests
 */
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { GrblEmulator } from '../../run/grbl/emulator/emulator'
import { machineSettings } from '../../run/grbl/emulator/settings'
import { TestStreamer } from '../../run/grbl/emulator.fixture'
import type { Machine } from '../../library/machine'
import { len } from '../../library/library.fixture'
import type { Vec3 } from '../../toolpath/model'
import { exportGrbl, type GrblExport } from '../export'
import { OPTS, testMachine, testPartExport } from '../post.fixture'

/** G54 in machine coordinates: the test part sits inside the soft limits [−travel, 0]. */
const WORK_ZERO: Vec3 = [-750, -750, -50]
const HOUR = 3_600_000

interface Run {
  readonly streamer: TestStreamer
  readonly emu: GrblEmulator
  /** Tool numbers announced by the markers the sender stopped at. */
  readonly toolChanges: number[]
  /** Program time without homing, setup and tool-change pauses (s). */
  readonly seconds: number
}

function exported(machine: Machine): GrblExport {
  return expectOk(exportGrbl({ ...testPartExport(machine), workZero: WORK_ZERO }, OPTS))
}

/** Homes, sets G54 and streams `lines`; tool changes jog, re-zero Z where it was and resume. */
function run(machine: Machine, lines: readonly string[], toolChange: 'dfyom' | 'pause'): Run {
  const emu = expectOk(GrblEmulator.create({ settings: machineSettings(machine) }))
  const s = new TestStreamer(emu, { toolChange, stopOnError: true })
  const idle = () => s.idle && emu.status().state === 'Idle'
  /** Manual lines done while the program is held. */
  const settled = () => s.inflightLines === 0 && emu.status().state === 'Idle'
  s.manual(['$H'])
  expect(s.runUntil(idle, HOUR)).toBe(true)
  s.manual([`G10 L2 P1 X${WORK_ZERO[0]} Y${WORK_ZERO[1]} Z${WORK_ZERO[2]}`])
  expect(s.runUntil(idle, HOUR)).toBe(true)

  const start = s.clock.now()
  let paused = 0
  const toolChanges: number[] = []
  s.send(lines)
  for (;;) {
    const held = () => emu.status().state === 'Hold:0'
    const alarm = () => s.received.some((l) => l.startsWith('ALARM'))
    expect(s.runUntil(() => s.toolChangeReady || held() || idle() || alarm(), HOUR)).toBe(true)
    if (alarm() || idle()) break
    const t0 = s.clock.now()
    if (held()) {
      // Another sender: GRBL pauses at M0, the user resumes.
      s.realtime('~')
    } else {
      toolChanges.push(s.toolChange?.tool ?? -1)
      // The user jogs away and down, zeroes the new tool's Z there (same offset), resumes.
      s.manual(['$J=G21 G91 X20 Y-10 Z-5 F2000'])
      expect(s.runUntil(settled, HOUR)).toBe(true)
      // in program units (G10 has no units of its own)
      const z = (emu.status().mpos[2] - WORK_ZERO[2]) / (machine.programUnits === 'in' ? 25.4 : 1)
      s.manual([`G10 L20 P1 Z${z.toFixed(4)}`])
      expect(s.runUntil(settled, HOUR)).toBe(true)
      s.resumeToolChange()
    }
    paused += s.clock.now() - t0
  }
  return { streamer: s, emu, toolChanges, seconds: (s.clock.now() - start - paused) / 1000 }
}

/** The last programmed position (work coordinates) after the footer's retract. */
function finalWorkPosition(e: GrblExport): Vec3 {
  const last = [...e.program.blocks]
    .reverse()
    .find((b) => b.kind === 'rapid' || b.kind === 'feed' || b.kind === 'arc')
  if (last === undefined || !('to' in last)) throw new Error('no motion')
  return [last.to[0], last.to[1], e.program.clearanceZ]
}

function expectClean(r: Run): void {
  expect(r.streamer.errors).toEqual([])
  expect(r.streamer.received.filter((l) => l.startsWith('ALARM'))).toEqual([])
  expect(r.emu.trace.violations).toEqual([])
  expect(r.streamer.stopped).toBe(false)
  expect(r.emu.status().state).toBe('Idle')
}

describe('test part on the virtual machine', () => {
  const machine = testMachine()
  const e = exported(machine)

  it('exports with only the tab-lift warning (Z feed above the Z max rate)', () => {
    expect(e.warnings.map((w) => [w.planOperationId, w.rule, w.params['axis']])).toEqual([
      ['op-profile1', 'maxFeedRate', 'z'],
    ])
  })

  it('streams with DFYOM tool changes: no errors or alarms, ends at the last position', () => {
    const r = run(machine, e.lines, 'dfyom')
    expectClean(r)
    expect(r.toolChanges).toEqual([2, 3, 4, 3, 5])
    const [x, y, z] = finalWorkPosition(e)
    const mpos = r.emu.status().mpos
    expect(mpos[0]).toBeCloseTo(WORK_ZERO[0] + x, 3)
    expect(mpos[1]).toBeCloseTo(WORK_ZERO[1] + y, 3)
    expect(mpos[2]).toBeCloseTo(WORK_ZERO[2] + z, 3)
    // After every marker the machine goes back to clearance before the spindle starts.
    const texts = r.emu.trace.lines.map((l) => l.text)
    const markers = texts.flatMap((t, k) => (t.startsWith('(DFYOM TOOL CHANGE') ? [k] : []))
    expect(markers).toHaveLength(6)
    // the first tool's marker is informational (no M0 follows it)
    for (const k of markers.slice(1))
      expect(texts.slice(k + 1, k + 3)).toEqual(['G0 Z10', expect.stringMatching(/^M3 S\d+$/)])
  })

  it('pauses at M0 for other senders and resumes with ~', () => {
    const r = run(machine, e.lines, 'pause')
    expectClean(r)
    expect(r.emu.trace.transitions.filter((t) => t.to === 'Hold:0')).toHaveLength(5)
    const [x, y] = finalWorkPosition(e)
    expect(r.emu.status().mpos[0]).toBeCloseTo(WORK_ZERO[0] + x, 3)
    expect(r.emu.status().mpos[1]).toBeCloseTo(WORK_ZERO[1] + y, 3)
  })

  it('runs within a sensible ratio of the estimate (acceleration only adds time)', () => {
    const r = run(machine, e.lines, 'dfyom')
    const toolpaths = testPartExport(machine).operations.reduce(
      (t, o) => t + o.toolpath.stats.estimatedSeconds,
      0,
    )
    const ratio = r.seconds / e.stats.estimatedSeconds
    // grbl.md#determinism-and-tests records the numbers: 623.2 s vs 586.9 s (568.0 s), 1.06
    expect(ratio).toBeGreaterThan(1)
    expect(ratio).toBeLessThan(1.5)
    expect(r.seconds / toolpaths).toBeLessThan(1.5)
  })

  it('an inch program ends at the same position (within the 4-decimal inch resolution)', () => {
    const inch = testMachine({ programUnits: 'in' })
    const ei = exported(inch)
    expect(ei.lines).toContain('G90 G94 G17 G20')
    const r = run(inch, ei.lines, 'dfyom')
    expectClean(r)
    const [x, y, z] = finalWorkPosition(e)
    const mpos = r.emu.status().mpos
    expect(Math.abs(mpos[0] - WORK_ZERO[0] - x)).toBeLessThan(0.002)
    expect(Math.abs(mpos[1] - WORK_ZERO[1] - y)).toBeLessThan(0.002)
    expect(Math.abs(mpos[2] - WORK_ZERO[2] - z)).toBeLessThan(0.002)
  })

  it('a program that leaves the soft limits alarms, and the export check predicts it', () => {
    const small = testMachine({ travel: { x: len('800'), y: len('800'), z: len('60') } })
    const es = exported(small)
    expect(es.warnings.some((w) => w.rule === 'softLimit' && w.params['axis'] === 'z')).toBe(true)
    const r = run(small, es.lines, 'dfyom')
    expect(r.streamer.received.some((l) => l === 'ALARM:2')).toBe(true)
  })
})
