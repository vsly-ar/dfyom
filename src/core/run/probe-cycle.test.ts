// The shared probe-cycle runner (v0.5 RV3) against the virtual machine's probe scene.
// Spec: docs/modes/run-probing.md#the-cycle-runner-rv3
import { describe, expect, it } from 'vitest'
import { fail, Ok } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { bytes, emulator, outLines, settle, statusOf } from './grbl/emulator.fixture'
import type { GrblEmulator } from './grbl/emulator/emulator'
import type { ProbeTarget, ProbeTip } from './grbl/emulator/probe-scene'
import { runProbeCycle, type ProbeCycleSpec, type ProbePort } from './probe-cycle'

type Vec3 = [number, number, number]

/** A port straight onto the emulator: each line runs to its `ok`/`error`. */
function emuPort(emu: GrblEmulator, opts: { duringProbe?: (emu: GrblEmulator) => boolean } = {}) {
  const sent: string[] = []
  const listeners = new Set<(code: number) => void>()
  const port: ProbePort = {
    status: () => {
      const s = emu.status()
      const pins = /\|Pn:([A-Z]+)/.exec(statusOf(emu))?.[1]
      return Promise.resolve(
        Ok({
          state: s.state,
          mpos: s.mpos,
          wpos: [s.mpos[0] - s.wco[0], s.mpos[1] - s.wco[1], s.mpos[2] - s.wco[2]] as const,
          spindle: s.spindleSpeed,
          ...(pins === undefined ? {} : { pins }),
        }),
      )
    },
    command: (line) => {
      sent.push(line)
      emu.receive(bytes(`${line}\n`))
      if (line.includes('G38') && opts.duringProbe?.(emu) === true) {
        // Stop: feed hold + reset; the line in flight fails as the sender's would
        emu.receive(Uint8Array.of(0x21))
        emu.advance(500)
        emu.receive(Uint8Array.of(0x18))
        outLines(emu)
        return Promise.resolve(fail('machine.reset', 'reset during the line', { where: 'test' }))
      }
      settle(emu)
      const out = outLines(emu)
      for (const l of out) {
        const m = /^ALARM:(\d+)$/.exec(l)
        if (m) for (const f of listeners) f(Number(m[1]))
      }
      const err = out.find((l) => l.startsWith('error:'))
      if (err !== undefined) return Promise.resolve(fail('machine.error', err, { where: 'test' }))
      return Promise.resolve(Ok(out))
    },
    onAlarm: (f) => {
      listeners.add(f)
      return () => listeners.delete(f)
    },
    unlock: () => {
      sent.push('$X')
      emu.receive(bytes('$X\n'))
      outLines(emu)
      return Promise.resolve(Ok(undefined))
    },
  }
  return { port, sent }
}

const stock: ProbeTarget = { kind: 'box', min: [0, 0, -30], max: [100, 50, -20] }

function machine(targets: ProbeTarget[], at: Vec3, tip?: ProbeTip) {
  const emu = emulator({ probeScene: { targets }, position: at, ...(tip ? { probeTip: tip } : {}) })
  emu.readOutput()
  return emu
}

const zDown: ProbeCycleSpec = {
  axis: 'z',
  direction: -1,
  maxDistance: 30,
  fastFeed: 300,
  slow: { feed: 50, backOff: 2, repeats: 2 },
  retract: 3,
}

/** The G38 targets the runner sent on `axis` (work coordinates = MPos here). */
const probeTargets = (sent: readonly string[], axis: string) =>
  sent
    .filter((l) => l.includes('G38'))
    .map((l) => Number(new RegExp(`${axis}(-?[\\d.]+)`).exec(l)?.[1]))

describe('runProbeCycle', () => {
  it('Z: seek, back off, two slow probes, retract, modal state back', async () => {
    const emu = machine([{ kind: 'plane', z: -20 }], [10, 10, -5])
    const { port, sent } = emuPort(emu)
    const r = expectOk(await runProbeCycle(port, zDown))
    expect(r.value).toBeCloseTo(-20, 3)
    expect(r.samples).toHaveLength(2)
    expect(r.uncertainty).toBe(0.001)
    expect(r.start).toEqual([10, 10, -5])
    expect(sent[0]).toBe('$G')
    expect(sent.filter((l) => l.includes('G38.2'))).toEqual([
      'G21 G90 G38.2 Z-35 F300',
      'G21 G90 G38.2 Z-22 F50',
      'G21 G90 G38.2 Z-22 F50',
    ])
    expect(sent).toContain('G21 G53 G0 Z-18')
    expect(sent.slice(-3)).toEqual(['G21 G53 G0 Z-17', 'G21 G90 G0', 'G4 P0'])
    expect(emu.status()).toMatchObject({ state: 'Idle', mpos: [10, 10, -17] })
    // never targets past the start − maxDistance
    for (const z of probeTargets(sent, 'Z')) expect(z).toBeGreaterThanOrEqual(-35)
  })

  it('X edge with the bit (cylinder r 3): the contact is the edge − r; X retract toward the start', async () => {
    const emu = machine([stock], [-20, 10, -25], { shape: 'cylinder', radius: 3 })
    const { port, sent } = emuPort(emu)
    const r = expectOk(
      await runProbeCycle(port, {
        axis: 'x',
        direction: 1,
        maxDistance: 40,
        fastFeed: 500,
        slow: { feed: 50, backOff: 1.5 },
        retract: 5,
      }),
    )
    expect(r.value).toBeCloseTo(-3, 3)
    expect(r.contact[1]).toBe(10)
    expect(sent).toContain('G21 G53 G0 X-8')
    expect(emu.status().mpos[0]).toBeCloseTo(-8, 6)
  })

  it('works in a work offset: G38 targets in work coordinates, results in MPos', async () => {
    const emu = machine([{ kind: 'plane', z: -20 }], [0, 0, -5])
    emu.receive(bytes('G10 L2 P1 Z-10\n'))
    emu.readOutput()
    const { port, sent } = emuPort(emu)
    const { slow: _slow, ...onePass } = zDown
    const r = expectOk(await runProbeCycle(port, onePass))
    expect(r.value).toBeCloseTo(-20, 3)
    expect(r.samples).toEqual([])
    expect(sent).toContain('G21 G90 G38.2 Z-25 F300')
  })

  it('no contact: ALARM:5, unlock, back at the start, the modal state back, nothing written', async () => {
    const emu = machine([], [10, 10, -5])
    const { port, sent } = emuPort(emu)
    const err = expectErrCode(await runProbeCycle(port, zDown), 'machine.alarm')
    expect(err.frames[0]?.data).toMatchObject({ code: 5, recovered: true })
    expect(err.message).toMatch(/^ALARM:5 /)
    expect(sent).toEqual([
      '$G',
      'G21 G90 G38.2 Z-35 F300',
      '$X',
      'G21 G53 G0 Z-5',
      'G21 G90 G0',
      'G4 P0',
    ])
    expect(emu.status()).toMatchObject({ state: 'Idle', mpos: [10, 10, -5] })
    expect(sent.some((l) => l.includes('G10'))).toBe(false)
  })

  it("onAlarm 'stay' (Probe Z): the alarm stays and the restore lines are handed over", async () => {
    const emu = machine([], [10, 10, -5])
    const { port, sent } = emuPort(emu)
    let pending: readonly string[] = []
    const r = await runProbeCycle(
      port,
      { ...zDown, onAlarm: 'stay' },
      { restorePending: (l) => (pending = l) },
    )
    expect(expectErrCode(r, 'machine.alarm').frames[0]?.data).toMatchObject({ recovered: false })
    expect(pending).toEqual(['G21 G90 G0'])
    expect(sent).not.toContain('$X')
    expect(emu.status().state).toBe('Alarm')
  })

  it('already touching (Pn:P): refused before anything is sent', async () => {
    const emu = machine([{ kind: 'plane', z: -20 }], [10, 10, -5])
    emu.setProbeShorted(true)
    const { port, sent } = emuPort(emu)
    const err = expectErrCode(await runProbeCycle(port, zDown), 'run.state')
    expect(err.message).toMatch(/^The probe reads as touching/)
    expect(err.issues[0]?.rule).toBe('probeTouching')
    expect(sent).toEqual([])
  })

  it('the spindle on or a busy state: refused before anything is sent', async () => {
    const emu = machine([{ kind: 'plane', z: -20 }], [10, 10, -5])
    emu.receive(bytes('M3 S10000\n'))
    emu.readOutput()
    const { port, sent } = emuPort(emu)
    expect(expectErrCode(await runProbeCycle(port, zDown), 'run.state').issues[0]?.rule).toBe(
      'spindleOn',
    )
    emu.receive(bytes('M5\nG1 X100 F100\n'))
    emu.readOutput()
    expect(expectErrCode(await runProbeCycle(port, zDown), 'run.state').message).toBe(
      'cannot probe in state Run',
    )
    expect(sent).toEqual([])
  })

  it('the travel cuts the distance; at the edge nothing is sent (run.travel)', async () => {
    const emu = machine([], [10, 10, -5])
    const { port, sent } = emuPort(emu)
    const travel = { min: [-300, -300, -12] as const, max: [0, 0, 0] as const }
    await runProbeCycle(port, { ...zDown, travel })
    expect(sent[1]).toBe('G21 G90 G38.2 Z-11.99 F300')
    const at = machine([], [10, 10, -11.5])
    const edge = emuPort(at)
    const err = expectErrCode(await runProbeCycle(edge.port, { ...zDown, travel }), 'run.travel')
    expect(err.message).toBe('Z is at the bottom of its travel: no room to probe')
    expect(edge.sent).toEqual([])
  })

  it('cancel between lines: op.aborted, nothing more is sent', async () => {
    const emu = machine([{ kind: 'plane', z: -20 }], [10, 10, -5])
    const { port, sent } = emuPort(emu)
    let lines = 0
    const counting: ProbePort = {
      ...port,
      command: (l, o) => {
        lines++
        return port.command(l, o)
      },
    }
    const r = await runProbeCycle(counting, { ...zDown, cancelled: () => lines >= 2 })
    expectErrCode(r, 'op.aborted')
    expect(sent).toEqual(['$G', 'G21 G90 G38.2 Z-35 F300'])
  })

  it('Stop mid-probe (feed hold + reset): the line fails and the cycle ends there', async () => {
    const emu = machine([{ kind: 'plane', z: -20 }], [10, 10, -5])
    const { port, sent } = emuPort(emu, { duringProbe: () => true })
    expectErrCode(await runProbeCycle(port, zDown), 'machine.reset')
    expect(sent).toEqual(['$G', 'G21 G90 G38.2 Z-35 F300'])
    expect(emu.status().mpos[2]).toBeGreaterThan(-20)
  })

  it('rejects a malformed spec', async () => {
    const { port, sent } = emuPort(machine([], [0, 0, 0]))
    expectErrCode(await runProbeCycle(port, { ...zDown, maxDistance: 0 }), 'input.malformed')
    expectErrCode(
      await runProbeCycle(port, { ...zDown, slow: { feed: 50, backOff: 1, repeats: 0 } }),
      'input.malformed',
    )
    expect(sent).toEqual([])
  })
})
