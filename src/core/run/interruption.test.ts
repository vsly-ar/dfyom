/**
 * The interruption record (hardening DF129, slice RC5): the run record's lines mapped back to the
 * original program (a run started at a line: lead-in, then the program from the line on), the
 * suggested resume point (Q160) and the operation start as "safest", and "The machine lost power"
 * (Q171) suggesting the operation start.
 * Doc: docs/modes/run-recovery.md#implementation-rc5
 */
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { testMachine } from '../post/post.fixture'
import { prepareGcodeFile } from './gcode-file'
import { machineTopZ } from './goto'
import { envelopeOf } from './grbl/envelope'
import { machineSettings } from './grbl/emulator/settings'
import { interruptionOf, originalLine } from './interruption'
import { RunRecorder, type RunJournal } from './journal'
import { FILE_SPIN_UP_SECONDS, resumePoints, resumeProgram, scanProgram } from './recovery'

// core stays environment-neutral (no node: imports, eslint): the built-in fs as gcode-file.test.ts
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, e: 'utf8'): string } }
  }
).process.getBuiltinModule('node:fs')
const multi = prepareGcodeFile(
  fs.readFileSync(new URL('../post/grbl/__golden__/multi-tool.nc', import.meta.url), 'utf8'),
)
const program = { lines: multi.lines, sections: multi.sections }
const points = resumePoints(scanProgram(program.lines))
const envelope = envelopeOf(machineSettings(testMachine()))!

/** The record of a run of `lines`, ended interrupted with these progress numbers. */
function record(
  lines: readonly string[],
  progress: { sent: number; acknowledged: number; executing: number },
): RunJournal {
  const r = new RunRecorder({
    jobId: 'j1',
    program: { lines, sections: program.sections },
    about: undefined,
    machine: { target: 'virtual', machineKey: 'm' },
    workZero: [-100, -100, -50],
    now: 0,
  })
  r.end({ ok: false, code: 'machine.connection' }, 1000)
  const j = r.snapshot()
  return { ...j, progress: { ...j.progress, ...progress } }
}

describe('the interruption record', () => {
  it('maps a resumed run’s lines back: the lead-in is the resume line, later lines shifted', () => {
    const resumed = { fromLine: 40, leadIn: 12, lines: program.lines }
    expect(originalLine(0, resumed)).toBe(0)
    expect(originalLine(1, resumed)).toBe(40)
    expect(originalLine(12, resumed)).toBe(40)
    expect(originalLine(13, resumed)).toBe(40)
    expect(originalLine(20, resumed)).toBe(47)
    expect(originalLine(20, undefined)).toBe(20)
  })

  it('suggests the latest pass start at or before the executing line, the operation start as safest', () => {
    const pass = points.filter((p) => p.kind === 'pass')[1]!
    const op = points.filter((p) => p.kind === 'operation' && p.line < pass.line).at(-1)!
    const executing = pass.line + 3
    const i = interruptionOf(
      record(program.lines, { sent: executing + 20, acknowledged: executing + 8, executing }),
      'connectionLost',
      { program: program.lines, origin: { programHash: 'abc' } },
    )
    expect(i).toMatchObject({
      reason: 'connectionLost',
      lines: program.lines.length,
      executing,
      acknowledged: executing + 8,
      sent: executing + 20,
      programHash: 'abc',
      suggestion: { line: pass.line, kind: 'pass' },
      safest: { line: op.line, kind: 'operation' },
      workZero: { start: [-100, -100, -50], last: [-100, -100, -50] },
    })
  })

  it('a run started at a line: its interruption refers to the original program', () => {
    const pass = points.filter((p) => p.kind === 'pass')[0]!
    const r = expectOk(
      resumeProgram(program, pass.line, {
        topZ: machineTopZ(envelope),
        spinUpSeconds: FILE_SPIN_UP_SECONDS,
        spindleControl: 'gcode',
      }),
    )
    const origin = {
      programHash: 'orig',
      resumed: { fromLine: r.fromLine, leadIn: r.leadIn.length, lines: program.lines },
    }
    const next = points.find((p) => p.line > pass.line)!
    // the machine was a few lines past the next pass start
    const streamed = next.line + 2 + r.offset
    const i = interruptionOf(
      record(r.program.lines, {
        sent: streamed + 10,
        acknowledged: streamed + 5,
        executing: streamed,
      }),
      'connectionLost',
      { program: r.program.lines, origin },
    )
    expect(i).toMatchObject({
      lines: program.lines.length,
      executing: next.line + 2,
      acknowledged: next.line + 7,
      sent: next.line + 12,
      programHash: 'orig',
      suggestion: { line: next.line },
    })
    // interrupted inside the lead-in: the same start again
    const inLeadIn = interruptionOf(
      record(r.program.lines, { sent: r.leadIn.length, acknowledged: 6, executing: 5 }),
      'connectionLost',
      { program: r.program.lines, origin },
    )
    expect(inLeadIn).toMatchObject({ executing: pass.line, suggestion: { line: pass.line } })
  })

  it('a start at a line that is not a resume point comes back to that line', () => {
    const line = points[1]!.line + 2
    const r = expectOk(
      resumeProgram(program, line, {
        topZ: machineTopZ(envelope),
        spinUpSeconds: FILE_SPIN_UP_SECONDS,
        spindleControl: 'gcode',
      }),
    )
    const i = interruptionOf(
      record(r.program.lines, { sent: 4, acknowledged: 3, executing: 2 }),
      'connectionLost',
      {
        program: r.program.lines,
        origin: {
          resumed: { fromLine: r.fromLine, leadIn: r.leadIn.length, lines: program.lines },
        },
      },
    )
    expect(i.suggestion?.line).toBe(r.fromLine)
  })

  it('the machine lost power (Q171): the operation start, since the progress after it is fiction', () => {
    const pass = points.filter((p) => p.kind === 'pass')[1]!
    const i = interruptionOf(
      record(program.lines, {
        sent: pass.line + 20,
        acknowledged: pass.line + 9,
        executing: pass.line + 4,
      }),
      'machinePowerLost',
      { program: program.lines },
    )
    expect(i.suggestion?.kind).toBe('operation')
    expect(i.suggestion).toEqual(i.safest)
    expect(i.reason).toBe('machinePowerLost')
  })

  it('waiting at a tool change: the first point after the wait', () => {
    const op = points.filter((p) => p.kind === 'operation')[1]!
    const i = interruptionOf(
      record(program.lines, {
        sent: op.line - 1,
        acknowledged: op.line - 2,
        executing: op.line - 6,
      }),
      'connectionLost',
      { program: program.lines, waiting: true },
    )
    expect(i.suggestion?.line).toBe(op.line)
  })
})
