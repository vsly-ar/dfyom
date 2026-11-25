// External gCode files for a run (hardening DF93): preparation, refusals and warnings, the
// extent, the preview moves and the soft-limit check. Samples: the user's own DFYOM export
// (trimmed), Fusion-, Estlcam- and gSender-style files (src/core/run/__fixtures__/).
// Doc: docs/modes/run.md#run-an-external-g-code-file-df93
import { describe, expect, it } from 'vitest'
import { initialParserState, parseBlock, STATUS } from './grbl/emulator/gcode'
import { preflight } from './grbl/sender'
import {
  fileMoves,
  fileSoftLimits,
  isRunnableGcodeFileName,
  prepareGcodeFile,
  type PreparedGcodeFile,
} from './gcode-file'

const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, e: 'utf8'): string } }
  }
).process.getBuiltinModule('node:fs')
const sample = (name: string): string =>
  fs.readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')

const rules = (issues: PreparedGcodeFile['refusals']) => issues.map((i) => i.rule)

/** Every prepared line is one GRBL takes (length, characters). */
function sendable(f: PreparedGcodeFile): void {
  expect(preflight(f.lines).isOk()).toBe(true)
}

describe('prepareGcodeFile on real-world samples', () => {
  it("runs the user's own DFYOM export unchanged", () => {
    const text = sample('dfyom-export.nc')
    const f = prepareGcodeFile(text)
    expect(f.refusals).toEqual([])
    expect(f.units).toBe('mm')
    // the first marker has no M0 (the tool is loaded): a section, not a stop
    expect(f.sections[0]?.label).toBe('tool 1: wexme 1/4" 1F')
    expect(f.toolChanges).toEqual([])
    expect(f.lines).toEqual(text.split('\n').filter((l) => l.trim() !== ''))
    expect(f.extent[0]?.max).toBeGreaterThan(f.extent[0]?.min ?? Infinity)
    sendable(f)
  })

  it('Fusion: % dropped, T1 M6 as the tool-change marker named from the header', () => {
    const f = prepareGcodeFile(sample('fusion-grbl.nc'))
    expect(f.refusals).toEqual([])
    expect(f.lines).not.toContain('%')
    expect(f.toolChanges.map((t) => [t.n, t.name])).toEqual([
      [1, 'D=6 CR=0 - ZMIN=-3 - flat end mill'],
      [2, 'D=3.175 CR=0 - ZMIN=-2 - flat end mill'],
    ])
    const at = f.toolChanges[0]!.line
    expect(f.lines[at - 1]).toBe('(DFYOM TOOL CHANGE 1: D=6 CR=0 - ZMIN=-3 - flat end mill)')
    expect(f.lines[at]).toBe('M0')
    // the marker's source line is the M6 line
    expect(f.sourceLines[at - 1]).toBe(13)
    expect(f.sections.map((s) => s.label)).toEqual([
      'tool 1: D=6 CR=0 - ZMIN=-3 - flat end mill',
      'tool 2: D=3.175 CR=0 - ZMIN=-2 - flat end mill',
    ])
    expect(f.extent[0]).toEqual({ min: 5, max: 40 })
    expect(f.extent[2]).toEqual({ min: -3, max: 15 })
    expect(f.pauses).toBe(0)
    sendable(f)
  })

  it('Estlcam: CRLF, a non-ASCII and a ? in comments, M06 T2 with its comment', () => {
    const f = prepareGcodeFile(sample('estlcam.nc'))
    expect(f.refusals).toEqual([])
    expect(f.lines[0]).toBe('(Estlcam style,   6 mm end mill )')
    expect(f.toolChanges.map((t) => [t.n, t.name])).toEqual([[2, 'V-bit 90 deg']])
    expect(f.lines.some((l) => l.includes('\r'))).toBe(false)
    sendable(f)
  })

  it('gSender style: ; comments, inch units, M0 with its message', () => {
    const f = prepareGcodeFile(sample('gsender-style.nc'))
    expect(f.refusals).toEqual([])
    expect(f.units).toBe('inch')
    expect(f.pauses).toBe(1)
    expect(f.extent[0]).toEqual({ min: 0, max: 2 * 25.4 })
    expect(f.extent[2]?.min).toBeCloseTo(-0.02 * 25.4, 6)
    expect(f.lines[1]).toBe('; Units: inch')
    sendable(f)
  })
})

describe('refusals and warnings', () => {
  const refused = (line: string) => prepareGcodeFile(`G21 G90\n${line}\n`).refusals
  it.each([
    ['G28 G91 Z0', 'storedPosition'],
    ['G30', 'storedPosition'],
    ['G92 X0 Y0', 'offset'],
    ['G10 L20 P1 X0', 'setsWorkZero'],
    ['G55', 'workOffset'],
    ['G38.2 Z-10 F100', 'probe'],
    ['G41 D1', 'cutterCompensation'],
    ['G43 H1', 'toolLength'],
    ['G81 X1 Y1 Z-1 R1 F100', 'cannedCycle'],
    ['G93', 'inverseTime'],
    ['G18', 'plane'],
    ['$H', 'systemCommand'],
    ['M98 P100', 'grbl'],
    ['G90.1', 'grbl'],
    ['G1 X1 ~ F100', 'character'],
  ])('%s → %s', (line, rule) => {
    const r = refused(line)
    expect(rules(r)).toEqual([rule])
    expect(r[0]?.line).toBe(2)
  })

  it('a code part longer than 79 characters', () => {
    const code = `G1 ${Array.from({ length: 20 }, (_, i) => `X${i}.12345`).join('')}`
    expect(rules(prepareGcodeFile(`G21\n${code}\n`).refusals)).toContain('grbl')
    const long = `G1X1.000000000000000000000000000000000000000000000000000000000000000000000000000000F100`
    expect(rules(prepareGcodeFile(`G21\n${long}\n`).refusals)).toEqual(['lineLength'])
  })

  it('a long inline comment is dropped, a long whole-line comment shortened', () => {
    const f = prepareGcodeFile(`G21\n(${'a'.repeat(120)})\nG0 X1 (${'b'.repeat(100)})\n`)
    expect(f.lines[1]).toHaveLength(79)
    expect(f.lines[2]).toBe('G0X1')
    sendable(f)
  })

  it('warns once per kind: no units, incremental start, feed without spindle, M1, after the end', () => {
    const f = prepareGcodeFile('G91 G0 X5\nG1 X1 F100\nM1\nM30\nG0 X0\n')
    expect(rules(f.warnings)).toEqual([
      'noUnits',
      'incrementalStart',
      'noSpindle',
      'optionalStop',
      'afterEnd',
    ])
    expect(f.refusals).toEqual([])
  })

  it('keeps refusals beyond the cap counted', () => {
    const f = prepareGcodeFile('G28\n'.repeat(150))
    expect(f.refusals).toHaveLength(100)
    expect(f.refusalCount).toBe(150)
  })

  it('accepts only gCode file names', () => {
    expect(isRunnableGcodeFileName('/a/b/part.NC')).toBe(true)
    expect(isRunnableGcodeFileName('/a/b/part.tap')).toBe(true)
    expect(isRunnableGcodeFileName('/a/b/notes.txt')).toBe(false)
    expect(isRunnableGcodeFileName('/a/b/.nc')).toBe(false)
  })
})

describe("the virtual machine's parser runs the CAM posts' no-ops (DF93)", () => {
  const state = initialParserState([0, 0, 0], [0, 0, 0])
  it.each(['G40', 'G49', 'G61', 'G80', 'G91.1', 'M1', 'M7', 'M8', 'M9', 'G49G40G80'])(
    '%s',
    (code) => {
      const r = parseBlock(code, state, { arcTolerance: 0.002 })
      expect(r.isOk()).toBe(true)
      expect(r.unwrap().actions).toEqual([])
    },
  )
  it('G80 with axis words is error 31, G90.1 error 20', () => {
    expect(parseBlock('G80X1', state, { arcTolerance: 0.002 }).unwrapErr()).toBe(
      STATUS.axisWordsExist,
    )
    expect(parseBlock('G90.1', state, { arcTolerance: 0.002 }).unwrapErr()).toBe(
      STATUS.unsupportedCommand,
    )
  })
})

describe('fileSoftLimits', () => {
  const travel = [300, 200, 80] as const
  const lines = prepareGcodeFile(sample('fusion-grbl.nc')).lines

  it('inside the travel at a work zero that fits', () => {
    expect(
      fileSoftLimits(lines, { workZero: [-250, -150, -60], mpos: [-1, -1, -1], travel }),
    ).toEqual([])
  })

  it('names each axis that leaves the travel, in machine coordinates', () => {
    const f = fileSoftLimits(lines, { workZero: [-20, -150, -10], mpos: [-1, -1, -1], travel })
    // Z: the file starts with T1 M6, so its Z zero is set after that (unchecked, as plans)
    expect(f.map((x) => [x.rule, x.params['axis']])).toEqual([['softLimit', 'x']])
    expect(f[0]?.params).toMatchObject({ min: -15, max: 20, travel: 300 })
    const z = prepareGcodeFile('G21 G90\nG0 Z15\nG1 Z-3 F100\n').lines
    const fz = fileSoftLimits(z, { workZero: [-20, -150, -10], mpos: [-1, -1, -1], travel })
    expect(fz.map((x) => x.params)).toEqual([{ axis: 'z', min: -13, max: 5, travel: 80 }])
  })

  it('Z only until the first tool change that pauses, G53 always', () => {
    const at = { workZero: [-100, -100, -50] as const, mpos: [-1, -1, -1] as const, travel }
    const tc = '(DFYOM TOOL CHANGE 2: bit)\nM0\n'
    const after = prepareGcodeFile(`G21 G90\nG0 Z5\n${tc}G0 Z60\n`).lines
    expect(fileSoftLimits(after, at)).toEqual([])
    const g53 = prepareGcodeFile(`G21 G90\nG0 Z5\n${tc}G53 G0 Z1\n`).lines
    expect(fileSoftLimits(g53, at).map((x) => x.params['axis'])).toEqual(['z'])
    // a marker without M0 (a loaded first tool) does not end the Z check
    const loaded = prepareGcodeFile('G21 G90\n(DFYOM TOOL CHANGE 1: bit)\nG0 Z60\n').lines
    expect(fileSoftLimits(loaded, at).map((x) => x.params['axis'])).toEqual(['z'])
  })

  it('a partial first move starts where the machine is', () => {
    const z = prepareGcodeFile('G21 G90\nG0 Z5\n').lines
    // X and Y stay at the machine position: inside the travel
    expect(fileSoftLimits(z, { workZero: [0, 0, -50], mpos: [-5, -5, -1], travel })).toEqual([])
  })
})

describe('fileMoves', () => {
  it('rapids and feeds in work coordinates, arcs as chords, G53 not drawn', () => {
    const m = fileMoves(
      prepareGcodeFile('G21 G90\nG0 X10\nG1 Y10 F100\nG2 X20 Y0 I10 J0\nG53 G0 Z-1\n').lines,
    )
    expect(m.rapid[0]).toBe(1)
    expect(m.rapid[1]).toBe(0)
    expect(Array.from(m.positions.slice(0, 6))).toEqual([0, 0, 0, 10, 0, 0])
    expect(m.segments).toBeGreaterThan(10)
    const last = m.positions.slice((m.segments - 1) * 6 + 3, m.segments * 6)
    expect(Array.from(last).map((v) => Math.round(v * 1000) / 1000)).toEqual([20, 0, 0])
  })
})
