/**
 * Section resume on the virtual machine (hardening M5): the resumed program of every operation of
 * the test part, streamed by GrblSender through the emulator, moves exactly as the full program
 * from that operation's first point on; one resume re-zeroes Z with a G38.2 probe at its wait.
 * Doc: docs/modes/run-machine.md#section-resume-m5
 */
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { GrblEmulator } from '../../run/grbl/emulator/emulator'
import { machineSettings } from '../../run/grbl/emulator/settings'
import { connected, drive, HOUR, start, until, type Rig } from '../../run/grbl/sender.fixture'
import type { Machine } from '../../library/machine'
import type { Vec3 } from '../../toolpath/model'
import { exportGrbl, type GrblExport } from '../export'
import { OPTS, testMachine, testPartExport } from '../post.fixture'

const WORK_ZERO: Vec3 = [-750, -750, -50]
const PLATE = 5

type ReZero = 'jog' | 'probe'

interface Ended {
  readonly rig: Rig
  readonly emu: GrblEmulator
  readonly error: string | undefined
}

function exported(machine: Machine, resumeFrom?: number): GrblExport {
  const input = { ...testPartExport(machine), workZero: WORK_ZERO }
  return expectOk(
    resumeFrom === undefined
      ? exportGrbl(input, OPTS)
      : exportGrbl({ ...input, resumeFrom }, { ...OPTS, firstToolLoaded: false }),
  )
}

/**
 * Homes, sets G54, streams `lines`; at each tool change re-zeroes Z where it was: by jogging away
 * and down and `G10 L20` (as emulator-run.test.ts), or for the first wait with `probe` by a G38.2
 * onto a plate lying on the stock top and `G10 L2` from the contact.
 */
async function run(machine: Machine, lines: readonly string[], first: ReZero): Promise<Ended> {
  const emu = expectOk(GrblEmulator.create({ settings: machineSettings(machine) }))
  const r = await connected(emu)
  const { sender, clock } = r
  expectOk(await drive(clock, sender.command('$H')))
  const g54 = `G10 L2 P1 X${WORK_ZERO[0]} Y${WORK_ZERO[1]} Z${WORK_ZERO[2]}`
  expectOk(await drive(clock, sender.command(g54)))
  let error: string | undefined
  let finished = false
  void start(r, lines).then((res) => {
    finished = true
    if (res.isErr()) error = res.unwrapErr().code
  })
  let waits = 0
  for (;;) {
    expect(
      await until(
        clock,
        () => finished || sender.phase === 'toolChange' || sender.phase === 'programPause',
        HOUR,
      ),
    ).toBe(true)
    if (finished) break
    if (sender.phase === 'programPause') {
      expectOk(sender.continueProgram())
      continue
    }
    if (waits++ === 0 && first === 'probe') {
      // the plate on the stock top (work Z0), the tool above it at the clearance height
      emu.setProbePlate(WORK_ZERO[2] + PLATE)
      expectOk(await drive(clock, sender.command('G21 G90 G38.2 Z-20 F200')))
      const prb = [...r.io.received].reverse().find((l) => l.startsWith('[PRB:'))
      const z = Number(/^\[PRB:[^,]+,[^,]+,([^:]+):1\]$/.exec(prb ?? '')?.[1])
      expect(z).toBeCloseTo(WORK_ZERO[2] + PLATE, 3)
      expectOk(await drive(clock, sender.command(`G10 L2 P1 Z${(z - PLATE).toFixed(4)}`)))
      emu.setProbePlate(undefined)
      expectOk(await drive(clock, sender.command('G0 Z10')))
      expect(await until(clock, () => emu.status().state === 'Idle')).toBe(true)
    } else {
      expectOk(await drive(clock, sender.command('$J=G21 G91 X-20 Y-10 Z-5 F2000')))
      expect(await until(clock, () => emu.status().state === 'Idle')).toBe(true)
      const z = emu.status().mpos[2] - WORK_ZERO[2]
      expectOk(await drive(clock, sender.command(`G10 L20 P1 Z${z.toFixed(4)}`)))
    }
    await drive(clock, sender.freshStatus())
    expectOk(sender.continueProgram())
  }
  return { rig: r, emu, error }
}

const MOTION = /^(G[0-3]\b|[XYZ]-?\d)/

/** MPos at the end of every executed motion line after trace line `from`. */
function motionEnds(emu: GrblEmulator, from: number): Vec3[] {
  const { lines, samples } = emu.trace
  const out: Vec3[] = []
  for (const l of lines.slice(from + 1)) {
    if (l.endedAt === undefined || !MOTION.test(l.text) || l.text.startsWith('G10')) continue
    const end = l.endedAt
    const s = [...samples].reverse().find((x) => x.t <= end)
    if (s !== undefined) out.push(s.mpos)
  }
  return out
}

/** Index in the trace of the `n`-th (0-based) line with this text. */
function traceIndex(emu: GrblEmulator, text: string, n: number): number {
  let seen = 0
  return emu.trace.lines.findIndex((l) => l.text === text && seen++ === n)
}

const near = (a: number, b: number, tol = 0.002) => Math.abs(a - b) <= tol

describe('section resume on the virtual machine (M5)', { timeout: 120_000 }, () => {
  const machine = testMachine()
  const full = exported(machine)
  const labels = testPartExport(machine).operations.map((o) => `(${o.label})`)

  it('re-enters: spindle off, waits at the tool, modes, clearance, spindle, start point', () => {
    const e = exported(machine, 2)
    const at = e.lines.indexOf(labels[2]!)
    expect(e.lines.slice(at, at + 9)).toEqual([
      labels[2],
      'M5',
      expect.stringMatching(/^\(DFYOM TOOL CHANGE \d+: /),
      'M0',
      'G90 G94 G17 G21',
      'G54',
      'G0 Z10',
      expect.stringMatching(/^M3 S\d+$/),
      'G4 P3',
    ])
    // then X and Y of the operation's first point (Z stays at the clearance height)
    expect(e.lines[at + 9]).toMatch(/^X-?[\d.]+ Y-?[\d.]+$/)
    // the header lists only the tools from here on, with their numbers in the full program
    const marker = e.lines[at + 2]!
    expect(full.lines).toContain(marker)
    expect(e.lines.filter((l) => labels.includes(l))).toEqual(labels.slice(2))
    expect(e.stats.toolChanges).toBeGreaterThan(0)
  })

  it('moves as the full program from every operation on (trace comparison)', async () => {
    const reference = await run(machine, full.lines, 'jog')
    expect(reference.error).toBeUndefined()
    for (let k = 1; k < labels.length; k++) {
      const e = exported(machine, k)
      const r = await run(machine, e.lines, k === 3 ? 'probe' : 'jog')
      expect(r.error, `resume at ${k}`).toBeUndefined()
      expect(r.rig.io.received.filter((l) => /^(error|ALARM)/.test(l))).toEqual([])
      // the operation's label is the k-th line with that text in the full program
      const n = labels.slice(0, k).filter((l) => l === labels[k]).length
      const startBlock = e.program.blocks.find((b) => b.kind === 'rapid')
      if (startBlock?.kind !== 'rapid') throw new Error('no re-entry rapid')
      const sx = WORK_ZERO[0] + startBlock.to[0]
      const sy = WORK_ZERO[1] + startBlock.to[1]
      const fromStart = (ps: Vec3[]) =>
        ps.slice(ps.findIndex((p) => near(p[0], sx) && near(p[1], sy)))
      const want = fromStart(motionEnds(reference.emu, traceIndex(reference.emu, labels[k]!, n)))
      const got = fromStart(motionEnds(r.emu, traceIndex(r.emu, labels[k]!, 0)))
      // the start point is reached at the clearance height
      expect(got[0]![2]).toBeCloseTo(WORK_ZERO[2] + e.program.clearanceZ, 3)
      expect(want.length, `resume at ${k}`).toBeGreaterThan(5)
      expect(got.length, `resume at ${k}`).toBe(want.length)
      got.forEach((p, i) => {
        const q = want[i]!
        expect(
          near(p[0], q[0]) && near(p[1], q[1]) && near(p[2], q[2]),
          `resume at ${k}, ${i}`,
        ).toBe(true)
      })
    }
  })
})
