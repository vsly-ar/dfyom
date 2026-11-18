/**
 * End to end: the test part's GRBL program streamed by GrblSender (task 3.9) through the virtual
 * machine (task 3.8) with character counting. Doc: docs/architecture/grbl.md#determinism-and-tests
 */
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { GrblEmulator } from '../../run/grbl/emulator/emulator'
import { machineSettings } from '../../run/grbl/emulator/settings'
import type { RunSummary } from '../../run/grbl/sender'
import { connected, drive, HOUR, start, until, type Rig } from '../../run/grbl/sender.fixture'
import type { Machine } from '../../library/machine'
import { len } from '../../library/library.fixture'
import type { Vec3 } from '../../toolpath/model'
import { exportGrbl, type GrblExport } from '../export'
import { OPTS, testMachine, testPartExport } from '../post.fixture'

/** G54 in machine coordinates: the test part sits inside the soft limits [-travel, 0]. */
const WORK_ZERO: Vec3 = [-750, -750, -50]

interface Run {
  readonly rig: Rig
  readonly emu: GrblEmulator
  /** Tool numbers announced by the markers the sender stopped at. */
  readonly toolChanges: number[]
  /** The run's summary when it succeeded (`seconds`: without the waits for the user). */
  readonly result: RunSummary | undefined
  /** The error code when it failed. */
  readonly error: string | undefined
}

function exported(machine: Machine): GrblExport {
  return expectOk(exportGrbl({ ...testPartExport(machine), workZero: WORK_ZERO }, OPTS))
}

/** Another sender's program: the markers become plain comments, so GRBL pauses at each `M0`. */
const withoutMarkers = (lines: readonly string[]) =>
  lines.map((l) => (l.startsWith('(DFYOM TOOL CHANGE') ? l.replace('DFYOM', 'OTHER') : l))

/**
 * Homes, sets G54 and streams `lines` with GrblSender; at each tool change it jogs, re-zeroes Z
 * where it was and continues; at each plain `M0` it continues.
 */
async function run(machine: Machine, lines: readonly string[]): Promise<Run> {
  const emu = expectOk(GrblEmulator.create({ settings: machineSettings(machine) }))
  const r = await connected(emu)
  const { sender, clock } = r
  expectOk(await drive(clock, sender.command('$H')))
  const g54 = `G10 L2 P1 X${WORK_ZERO[0]} Y${WORK_ZERO[1]} Z${WORK_ZERO[2]}`
  expectOk(await drive(clock, sender.command(g54)))
  const toolChanges: number[] = []
  let result: RunSummary | undefined
  let error: string | undefined
  let finished = false
  void start(r, lines).then((res) => {
    finished = true
    if (res.isOk()) result = res.unwrap()
    else error = res.unwrapErr().code
  })
  const waiting = () => sender.phase === 'toolChange' || sender.phase === 'programPause'
  for (;;) {
    expect(await until(clock, () => finished || waiting(), HOUR)).toBe(true)
    if (finished) break
    if (sender.phase === 'programPause') {
      expectOk(sender.continueProgram())
      continue
    }
    toolChanges.push(r.phases.at(-1)?.toolChange?.n ?? -1)
    // The user jogs away and down, zeroes the new tool's Z there (same offset), resumes.
    expectOk(await drive(clock, sender.command('$J=G21 G91 X20 Y-10 Z-5 F2000')))
    expect(await until(clock, () => emu.status().state === 'Idle')).toBe(true)
    // in program units (G10 has no units of its own)
    const z = (emu.status().mpos[2] - WORK_ZERO[2]) / (machine.programUnits === 'in' ? 25.4 : 1)
    expectOk(await drive(clock, sender.command(`G10 L20 P1 Z${z.toFixed(4)}`)))
    // continue only on a report taken after the last command (GrblSender refuses a stale Idle)
    await drive(clock, sender.freshStatus())
    expectOk(sender.continueProgram())
  }
  return { rig: r, emu, toolChanges, result, error }
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
  expect(r.error).toBeUndefined()
  const bad = r.rig.io.received.filter((l) => l.startsWith('error') || l.startsWith('ALARM'))
  expect(bad).toEqual([])
  expect(r.emu.trace.violations).toEqual([])
  expect(r.emu.status().state).toBe('Idle')
}

describe('test part on the virtual machine', () => {
  const machine = testMachine()
  const e = exported(machine)

  it('exports without warnings (tab lifts feed at the plunge rate, within the Z max rate)', () => {
    expect(e.warnings).toEqual([])
  })

  it('streams with DFYOM tool changes: no errors or alarms, ends at the last position', async () => {
    const r = await run(machine, e.lines)
    expectClean(r)
    expect(r.toolChanges).toEqual([2, 3, 4, 3, 5])
    expect(r.result).toMatchObject({ lines: e.lines.length, toolChanges: 5, pauses: 0 })
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
      expect(texts.slice(k + 1, k + 5)).toEqual([
        'G90 G94 G17 G21',
        'G54',
        'G0 Z10',
        expect.stringMatching(/^M3 S\d+$/),
      ])
  })

  it('pauses at M0 for other senders and resumes with ~', async () => {
    const r = await run(machine, withoutMarkers(e.lines))
    expectClean(r)
    expect(r.result).toMatchObject({ toolChanges: 0, pauses: 5 })
    expect(r.emu.trace.transitions.filter((t) => t.to === 'Hold:0')).toHaveLength(5)
    const [x, y] = finalWorkPosition(e)
    expect(r.emu.status().mpos[0]).toBeCloseTo(WORK_ZERO[0] + x, 3)
    expect(r.emu.status().mpos[1]).toBeCloseTo(WORK_ZERO[1] + y, 3)
  })

  it('runs within a sensible ratio of the estimate (acceleration only adds time)', async () => {
    const r = await run(machine, e.lines)
    const toolpaths = testPartExport(machine).operations.reduce(
      (t, o) => t + o.toolpath.stats.estimatedSeconds,
      0,
    )
    const seconds = r.result?.seconds ?? 0
    const ratio = seconds / e.stats.estimatedSeconds
    // grbl.md#determinism-and-tests records the numbers: 626.6 s vs 591.4 s (572.5 s), 1.06
    expect(ratio).toBeGreaterThan(1)
    expect(ratio).toBeLessThan(1.5)
    expect(seconds / toolpaths).toBeLessThan(1.5)
  })

  it('an inch program ends at the same position (within the 4-decimal inch resolution)', async () => {
    const inch = testMachine({ programUnits: 'in' })
    const ei = exported(inch)
    expect(ei.lines).toContain('G90 G94 G17 G20')
    const r = await run(inch, ei.lines)
    expectClean(r)
    const [x, y, z] = finalWorkPosition(e)
    const mpos = r.emu.status().mpos
    expect(Math.abs(mpos[0] - WORK_ZERO[0] - x)).toBeLessThan(0.002)
    expect(Math.abs(mpos[1] - WORK_ZERO[1] - y)).toBeLessThan(0.002)
    expect(Math.abs(mpos[2] - WORK_ZERO[2] - z)).toBeLessThan(0.002)
  })

  it('a program that leaves the soft limits alarms, and the export check predicts it', async () => {
    // the facing (first tool, Z zero as given) reaches Z -0.5 → MPos -50.5, below -50
    const small = testMachine({ travel: { x: len('800'), y: len('800'), z: len('50') } })
    const es = exported(small)
    expect(es.warnings.some((w) => w.rule === 'softLimit' && w.params['axis'] === 'z')).toBe(true)
    const r = await run(small, es.lines)
    expect(r.rig.io.received).toContain('ALARM:2')
    expect(r.error).toBe('machine.alarm')
  })
})
