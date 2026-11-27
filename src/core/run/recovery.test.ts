/**
 * Resume points and the lead-in (hardening DF129, slice RC2): the modal state at a line, the
 * resume points and findings of DFYOM goldens and the DF93 sample files, the suggestion, the
 * lead-in's lines, and on the virtual machine: a program resumed at each resume point moves exactly
 * as the full program from that line on and ends Idle.
 * Doc: docs/modes/run-recovery.md#choosing-where-to-resume, #the-lead-in, #implementation-rc2
 */
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { exportGrbl } from '../post/export'
import { OPTS, testMachine, testPartExport } from '../post/post.fixture'
import { prepareGcodeFile } from './gcode-file'
import { machineTopZ } from './goto'
import { envelopeOf } from './grbl/envelope'
import { GrblEmulator } from './grbl/emulator/emulator'
import { machineSettings } from './grbl/emulator/settings'
import { connected, drive, HOUR, start, until } from './grbl/sender.fixture'
import type { SenderProgram } from './grbl/sender'
import {
  FILE_SPIN_UP_SECONDS,
  initialModal,
  programHash,
  resumeFindings,
  resumePoints,
  resumeProgram,
  scanProgram,
  stepModal,
  suggestResume,
  type LeadInOptions,
  type ResumePoint,
} from './recovery'

type V3 = readonly [number, number, number]

// core stays environment-neutral (no node: imports, eslint): the built-in fs as gcode-file.test.ts
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, e: 'utf8'): string } }
  }
).process.getBuiltinModule('node:fs')
const read = (path: string) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
/** A DF93 sample or a golden program, prepared as a file run prepares it. */
const fileProgram = (path: string): SenderProgram => {
  const f = prepareGcodeFile(read(path))
  return { lines: f.lines, sections: f.sections }
}
const SAMPLES = ['fusion-grbl.nc', 'estlcam.nc', 'gsender-style.nc', 'dfyom-export.nc'].map(
  (n) => `./__fixtures__/${n}`,
)
const GOLDEN = {
  pocket: '../plan/__golden__/pocket-roughing.nc',
  profile: '../plan/__golden__/profile-roughing.nc',
  helix: '../post/grbl/__golden__/pocket-circle-helix.nc',
  tools: '../post/grbl/__golden__/multi-tool.nc',
  inch: '../post/grbl/__golden__/multi-tool-inch-manual-spindle.nc',
}

const machine = testMachine()
const envelope = envelopeOf(machineSettings(machine))!
const OPTS_FILE: LeadInOptions = {
  topZ: machineTopZ(envelope),
  spinUpSeconds: FILE_SPIN_UP_SECONDS,
  spindleControl: 'gcode',
}

describe('the modal state at a line', () => {
  it('adds the plane and the coolant to the parser state; a program end switches coolant off', () => {
    let s = initialModal()
    for (const l of ['G20 G91 G17', 'M8', 'M7 (mist too)', 'G1 X1 F10']) s = stepModal(s, l).state
    expect(s.plane).toBe(17)
    expect(s.coolant).toEqual({ mist: true, flood: true })
    expect(s.parser).toMatchObject({ metric: false, absolute: false, motion: 1, feed: 254 })
    expect(stepModal(s, 'M9').state.coolant).toEqual({ mist: false, flood: false })
    expect(stepModal(s, 'M30').state.coolant).toEqual({ mist: false, flood: false })
    // a refused line leaves the state as it was
    expect(stepModal(s, 'G18').state).toBe(s)
  })

  it('scans units, distance, WCS position, tool, spindle, feed, rapid height and plunge feed', () => {
    const scan = scanProgram(fileProgram(SAMPLES[0]!).lines)
    const at = scan.find((l) => l.line === resumePoints(scan)[1]!.line)!
    expect(at.tool).toMatchObject({ n: 2 })
    expect(at.before.parser).toMatchObject({ metric: true, absolute: true, spindle: 'cw' })
    expect(at.before.parser.spindleSpeed).toBe(20000)
    expect(at.start).toEqual([5, 5, 15])
    expect(at.rapidZ).toBe(15)
    // the coolant went off with M9 before the second tool
    expect(at.before.coolant).toEqual({ mist: false, flood: false })
    const first = scan.find((l) => l.line === resumePoints(scan)[0]!.line)!
    expect(first.before.coolant).toEqual({ mist: false, flood: true })
    // a G53 move leaves Z unknown until the program sets it again
    const g53 = scanProgram([
      'G21 G90',
      'G0 X1 Y2 Z3',
      'G53 G0 Z-1',
      'G0 X5',
      'G0 Z4',
      'G1 Z0 F100',
    ])
    expect(g53[3]!.start).toEqual([1, 2, undefined])
    expect(g53[5]!.start).toEqual([5, 2, 4])
  })
})

describe('resume points and findings', () => {
  const pointsOf = (path: string) => resumePoints(scanProgram(fileProgram(path).lines))

  it('a file: one operation start per tool and operation comment, labelled', () => {
    expect(pointsOf(SAMPLES[0]!)).toEqual([
      {
        line: expect.any(Number),
        kind: 'operation',
        label: expect.stringMatching(/^Pocket1 · tool 1: /),
      },
      { line: expect.any(Number), kind: 'operation', label: expect.stringMatching(/tool 2: /) },
    ])
    const estlcam = pointsOf(SAMPLES[1]!)
    expect(estlcam.map((p) => p.kind)).toEqual(['operation', 'operation'])
    expect(estlcam[1]!.label).toBe('tool 2: V-bit 90 deg')
    expect(pointsOf(SAMPLES[2]!)).toHaveLength(1)
  })

  it('a profile with ramps: every depth lap is a pass start, the second tool an operation start', () => {
    const lines = fileProgram(GOLDEN.profile).lines
    const points = pointsOf(GOLDEN.profile)
    expect(points.filter((p) => p.kind === 'operation').map((p) => p.label)).toEqual([
      expect.stringMatching(/^Profile 1 - roughing · tool 1: /),
      expect.stringMatching(/ · tool 2: /),
    ])
    expect(points.filter((p) => p.kind === 'pass').length).toBeGreaterThan(5)
    // every point is a feed move right after a rapid, never inside the ramp that follows it
    const scan = scanProgram(lines)
    for (const p of points) {
      expect(scan[p.line - 1]!.motion).toBe('feed')
      expect(resumeFindings(scan, p.line).filter((f) => f.rule === 'ramp')).toEqual([])
    }
  })

  it('pockets, a helical entry and tool changes (DFYOM goldens), with the plan operation lines', () => {
    for (const path of [GOLDEN.pocket, GOLDEN.helix, GOLDEN.tools, GOLDEN.inch])
      expect(pointsOf(path).length, path).toBeGreaterThan(1)
    const tools = scanProgram(fileProgram(GOLDEN.tools).lines)
    const ops = tools.filter((l) => /^op-/.test(l.comment ?? '')).map((l) => l.line)
    const points = resumePoints(tools, { operationStarts: ops })
    expect(points.filter((p) => p.kind === 'operation').map((p) => p.label)).toEqual(
      tools.filter((l) => ops.includes(l.line)).map((l) => l.comment),
    )
  })

  it('finds helices in the samples and goldens, in-material starts, tool changes and G91', () => {
    const helix = scanProgram(fileProgram(GOLDEN.helix).lines)
    const inside = helix.find((l) => l.arc && l.start[2] !== l.end[2] && l.line > 20)!
    const f = resumeFindings(helix, inside.line + 1)
    const ramp = f.find((x) => x.rule === 'ramp')
    expect(ramp).toMatchObject({ rule: 'ramp', helix: true })
    // the entry starts with its plunge, a resume point
    const from = ramp?.rule === 'ramp' ? ramp.from : 0
    expect(resumePoints(helix).map((p) => p.line)).toContain(from)
    expect(f).toContainEqual(expect.objectContaining({ rule: 'inMaterial' }))
    expect(f).toContainEqual(expect.objectContaining({ rule: 'toolChange', n: 1 }))
    // a straight ramp in the profile is a ramp, not a helix... unless it has an arc
    const profile = scanProgram(fileProgram(GOLDEN.profile).lines)
    const lap = resumePoints(profile)[1]!.line
    expect(resumeFindings(profile, lap + 2).find((x) => x.rule === 'ramp')).toMatchObject({
      from: lap,
    })
    const inc = scanProgram(['G21 G90', 'G0 X0 Y0 Z5', 'G91', 'G1 X1 F100'])
    expect(resumeFindings(inc, 4)).toContainEqual({ rule: 'incremental' })
  })

  it('suggests the latest point at or before the lower bound; the operation start as safest', () => {
    const points: ResumePoint[] = [
      { line: 10, kind: 'operation', label: 'A' },
      { line: 40, kind: 'pass' },
      { line: 80, kind: 'pass' },
      { line: 120, kind: 'operation', label: 'B' },
      { line: 150, kind: 'pass' },
    ]
    expect(suggestResume(points, { executing: 100, acknowledged: 130 })).toEqual({
      suggestion: points[2],
      safest: points[0],
    })
    expect(suggestResume(points, { executing: 80, acknowledged: 90 })?.suggestion).toBe(points[2])
    // no estimate: the acknowledged lines minus a full planner
    expect(suggestResume(points, { executing: 0, acknowledged: 136 })?.suggestion).toBe(points[3])
    expect(suggestResume(points, { executing: 0, acknowledged: 135 })?.suggestion).toBe(points[2])
    // before the first point: the first; waiting at a tool change: the point after it
    expect(suggestResume(points, { executing: 3, acknowledged: 5 })?.suggestion).toBe(points[0])
    expect(
      suggestResume(points, { executing: 100, acknowledged: 110, waitingAt: 115 })?.suggestion,
    ).toBe(points[3])
    expect(suggestResume([], { executing: 1, acknowledged: 1 })).toBeUndefined()
  })
})

describe('the lead-in', () => {
  it('retracts, waits at the tool, restates the modes, spins up, goes above the start, plunges', () => {
    const program = fileProgram(GOLDEN.profile)
    const lap = resumePoints(scanProgram(program.lines))[1]!.line
    const r = expectOk(resumeProgram(program, lap, { ...OPTS_FILE, spinUpSeconds: 3 }))
    expect(r.leadIn).toEqual([
      `(Resume at line ${lap}: lead-in)`,
      'G90 G94 G17 G21',
      'G54',
      'M5',
      'M9',
      'G53 G0 Z-1',
      // DF130: the marker's description carries the minimum stickout into the lead-in
      '(DFYOM TOOL CHANGE 1: Flat 6, 6 mm flat, min stickout 17.5 mm)',
      'M0 ;Check T1 Flat 6, 6 mm flat, min stickout 17.5 mm, then zero Z',
      'G90 G94 G17 G21',
      'G54',
      'G53 G0 Z-1',
      'M3 S18000',
      'G4 P3',
      'G0 X30 Y3',
      'G0 Z2',
      'F2743.2',
    ])
    expect(r.program.lines.slice(r.leadIn.length)).toEqual(program.lines.slice(lap - 1))
    expect(r.offset).toBe(r.leadIn.length - lap + 1)
    expect(r.program.sections[0]).toEqual({ fromLine: 1, label: 'Lead-in' })
    expect(r.program.sections[1]).toEqual({
      fromLine: r.leadIn.length + 1,
      label: program.sections[0]!.label,
    })
    expect(r.program.sections[2]?.fromLine).toBe(program.sections[1]!.fromLine + r.offset)
  })

  it('in material: approach at the rapid height, plunge at the plunge feed; the motion word restated', () => {
    const lines = [
      'G21 G90',
      'M3 S10000',
      'G0 Z5',
      'G0 X0 Y0',
      'G1 Z-2 F300',
      'G2 X10 Y0 I5 J0 F1000',
      'X0 Y0 I-5 J0',
    ]
    const r = expectOk(resumeProgram({ lines, sections: [] }, 7, OPTS_FILE))
    expect(r.leadIn.slice(-4)).toEqual(['G0 X10 Y0', 'G0 Z5', 'G1 Z-2 F300', 'F1000'])
    expect(r.program.lines.at(-1)).toBe('G2 X0 Y0 I-5 J0')
    expect(r.findings).toContainEqual({ rule: 'inMaterial', z: -2 })
    expect(r.leadIn).toContain('G4 P5')
    // inch, incremental, coolant, a hand-switched spindle
    const inch = ['G20 G90', 'M8', 'M4 S9000', 'G0 X1 Y1 Z0.2', 'G91', 'G1 Z-0.3 F10', 'X1']
    const ri = expectOk(
      resumeProgram({ lines: inch, sections: [] }, 7, { ...OPTS_FILE, spindleControl: 'manual' }),
    )
    expect(ri.leadIn.slice(1, 6)).toEqual(['G90 G94 G17 G20', 'G54', 'M5', 'M9', 'G53 G0 Z-0.0394'])
    expect(ri.leadIn.slice(11)).toEqual([
      'M8',
      'M4 S9000',
      '(Set spindle to 9000 rpm)',
      'M0 ;Set spindle to 9000 rpm',
      'G0 X1 Y1',
      'G0 Z0.2',
      // the last Z-only feed down before the line
      'G1 Z-0.1 F10',
      'G91 F10',
    ])
    expect(ri.program.lines.at(-1)).toBe('G1 X1')
  })

  it('passes over a tool-change marker; refuses a line outside the program or without a start point', () => {
    const program = fileProgram(SAMPLES[0]!)
    const marker = program.lines.findIndex((l) => l.startsWith('(DFYOM TOOL CHANGE 2')) + 1
    const r = expectOk(resumeProgram(program, marker, OPTS_FILE))
    expect(r.fromLine).toBe(marker + 2)
    expect(r.program.lines.filter((l) => l.startsWith('(DFYOM TOOL CHANGE'))).toHaveLength(1)
    expect(
      expectErrCode(resumeProgram(program, 0, OPTS_FILE), 'input.malformed').issues[0]?.rule,
    ).toBe('range')
    expect(
      expectErrCode(resumeProgram(program, program.lines.length + 1, OPTS_FILE), 'input.malformed')
        .issues[0]?.rule,
    ).toBe('range')
    expect(
      expectErrCode(resumeProgram(program, 2, OPTS_FILE), 'input.malformed').issues[0]?.rule,
    ).toBe('noStartPoint')
  })

  it('hashes the program as main does (SHA-256 of the lines joined with LF)', async () => {
    expect(await programHash(['G0 X1', 'M30'])).toBe(
      '0bf27cdc50945d54a6d4b389ba7a9b9455017ec98257d6e36f77f8ea06760a09',
    )
    // known vector: sha256("abc")
    expect(await programHash(['abc'])).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

// ── on the virtual machine ──────────────────────────────────────────────────────────────

const WORK_ZERO: V3 = [-400, -400, -60]
const near = (a: number, b: number, tol = 0.002) => Math.abs(a - b) <= tol

/**
 * Homes, sets G54, streams `lines` continuing at once at every wait; expects no error, no alarm,
 * Idle at the end. Answers the work position at the end of each executed motion line of the
 * program, by 1-based line (trace lines matched to program lines in order).
 */
async function streamEnds(lines: readonly string[]): Promise<Map<number, V3>> {
  const emu = expectOk(GrblEmulator.create({ settings: machineSettings(machine) }))
  const r = await connected(emu)
  const { sender, clock } = r
  expectOk(await drive(clock, sender.command('$H')))
  expectOk(
    await drive(
      clock,
      sender.command(`G10 L2 P1 X${WORK_ZERO[0]} Y${WORK_ZERO[1]} Z${WORK_ZERO[2]}`),
    ),
  )
  let finished = false
  let error: string | undefined
  void start(r, lines).then((res) => {
    finished = true
    if (res.isErr()) error = res.unwrapErr().message
  })
  for (;;) {
    expect(
      await until(
        clock,
        () => finished || sender.phase === 'toolChange' || sender.phase === 'programPause',
        HOUR,
      ),
    ).toBe(true)
    if (finished) break
    expectOk(sender.continueProgram())
  }
  expect(error).toBeUndefined()
  expect(r.io.received.filter((l) => /^(error|ALARM)/.test(l))).toEqual([])
  expect(emu.status().state).toBe('Idle')
  const scan = scanProgram(lines)
  const { lines: trace, samples } = emu.trace
  const out = new Map<number, V3>()
  let k = 0
  for (const t of trace) {
    // not a program line ($H, G10, …): skipped
    const at = lines.indexOf(t.text, k)
    if (at < 0) continue
    k = at
    const end = t.endedAt
    if (end !== undefined && scan[k]!.motion !== 'none') {
      const s = [...samples].reverse().find((x) => x.t <= end)
      if (s !== undefined)
        out.set(k + 1, [
          s.mpos[0] - WORK_ZERO[0],
          s.mpos[1] - WORK_ZERO[1],
          s.mpos[2] - WORK_ZERO[2],
        ])
    }
    k++
  }
  return out
}

/** Resumes `program` at each of `points` and compares every motion line's end with the full run. */
async function equivalence(program: SenderProgram, points: readonly number[], name: string) {
  const full = await streamEnds(program.lines)
  for (const line of points) {
    const r = expectOk(resumeProgram(program, line, OPTS_FILE))
    const got = await streamEnds(r.program.lines)
    const want = [...full].filter(([l]) => l >= r.fromLine)
    const resumed = [...got].filter(([l]) => l > r.leadIn.length)
    expect(want.length, `${name} at ${line}`).toBeGreaterThan(0)
    expect(
      resumed.map(([l]) => l - r.offset),
      `${name} at ${line}`,
    ).toEqual(want.map(([l]) => l))
    resumed.forEach(([, p], i) => {
      const q = want[i]![1]
      expect(
        near(p[0], q[0]) && near(p[1], q[1]) && near(p[2], q[2]),
        `${name} at ${line}, ${i}`,
      ).toBe(true)
    })
  }
}

describe('resumed on the virtual machine', () => {
  it(
    'every resume point of the DF93 samples and the goldens moves as the full program',
    { timeout: 120_000 },
    async () => {
      for (const path of [...SAMPLES, GOLDEN.pocket, GOLDEN.profile, GOLDEN.helix, GOLDEN.tools]) {
        const program = fileProgram(path)
        const points = resumePoints(scanProgram(program.lines)).map((p) => p.line)
        await equivalence(program, points, path)
      }
    },
  )

  it(
    'every resume point of the test part moves as the full program',
    { timeout: 120_000 },
    async () => {
      const e = expectOk(exportGrbl(testPartExport(machine), OPTS))
      const program: SenderProgram = { lines: e.lines, sections: [] }
      const scan = scanProgram(e.lines)
      const points = resumePoints(scan).map((p) => p.line)
      expect(points.length).toBeGreaterThan(3)
      await equivalence(program, points, 'test part')
    },
  )

  it(
    'a line inside a helix still resumes exactly there (plunging straight down)',
    { timeout: 60_000 },
    async () => {
      const program = fileProgram(GOLDEN.helix)
      const scan = scanProgram(program.lines)
      const inside = scan.find((l) => l.arc && l.start[2] !== l.end[2] && l.line > 20)!.line + 1
      await equivalence(program, [inside], 'inside the helix')
    },
  )
})
