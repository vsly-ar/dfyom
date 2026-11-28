// Homing repeatability (v0.5 RV8) against the virtual machine: the stats, one target probe from
// the machine top (Z plate, corner plate), the emulator's homing scatter reported within 0.005 mm
// of the injected spread, lost steps found without homing, an unexpected contact on the way down.
// Spec: docs/modes/run-machine.md#homing-repeatability-rv8
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { emulator, outLines, send, settle } from './grbl/emulator.fixture'
import type { GrblEmulator } from './grbl/emulator/emulator'
import {
  drift,
  repeatabilityStats,
  runTargetProbe,
  type TargetProbeSpec,
  type TargetReading,
} from './homing-repeatability'
import { emuPort } from './probe-port.fixture'

type Vec3 = [number, number, number]

/** The start above the target (MPos); the target lies 5 mm below it. */
const AT: Vec3 = [-300, -200, -60]

const spec = (over: Partial<TargetProbeSpec> = {}): TargetProbeSpec => ({
  at: AT,
  probe: { kind: 'zPlate', tipDiameter: 0 },
  corner: [-1, -1],
  zDistance: 20,
  reach: 10,
  depth: 3,
  clearance: 2,
  fastFeed: 200,
  slowFeed: 25,
  moveFeed: 600,
  travelFeed: 3000,
  ...over,
})

function home(emu: GrblEmulator): void {
  send(emu, '$H\n')
  settle(emu)
  outLines(emu)
}

function zPlateMachine(scatter?: number): GrblEmulator {
  const emu = emulator({
    homing: true,
    probePlate: AT[2] - 5,
    ...(scatter === undefined ? {} : { homingScatter: { x: scatter, y: scatter, z: scatter } }),
    homingSeed: 3,
  })
  emu.readOutput()
  return emu
}

describe('repeatabilityStats', () => {
  it('spread, sample standard deviation and mean per axis; pass under 0.02 mm', () => {
    const r = repeatabilityStats([{ z: -65 }, { z: -65.01 }, { z: -64.995 }, { z: -65.005 }])
    expect(r.axes.z?.spread).toBeCloseTo(0.015, 9)
    expect(r.axes.z?.mean).toBeCloseTo(-65.0025, 9)
    expect(r.axes.z?.stdDev).toBeCloseTo(0.006455, 5)
    expect(r.axes.x).toBeUndefined()
    expect(r.pass).toBe(true)
    // 0.02 is not under 0.02; one reading cannot pass
    expect(
      repeatabilityStats([
        { x: 1, z: 0 },
        { x: 1.02, z: 0 },
      ]).pass,
    ).toBe(false)
    expect(repeatabilityStats([{ z: 0 }]).pass).toBe(false)
    expect(
      repeatabilityStats([
        { x: 0, z: 0 },
        { x: 0.025, z: 0 },
      ]).worst,
    ).toBeCloseTo(0.025, 9)
    expect(drift({ x: 1.1, z: -65 }, { x: 1, y: 2, z: -65 })).toEqual({
      x: expect.closeTo(0.1, 9),
      z: 0,
    })
  })
})

describe('runTargetProbe', () => {
  it('Z plate: across at the top, G38.3 down to the start, G38.2 on the plate, back up', async () => {
    const emu = zPlateMachine()
    home(emu)
    const { port, sent } = emuPort(emu)
    const r = expectOk(await runTargetProbe(port, spec()))
    expect(r).toEqual({ z: expect.closeTo(-65, 3) })
    expect(sent[0]).toBe('G21 G53 G1 X-300 Y-200 F3000')
    expect(sent[1]).toMatch(/^G21 G90 G38\.3 Z-60 F600/)
    expect(sent.some((l) => l.includes('G38.2'))).toBe(true)
    expect(sent.some((l) => l.includes('G10'))).toBe(false)
    expect(emu.status().mpos[2]).toBeCloseTo(AT[2], 3)
  })

  it('reports the injected homing scatter within 0.005 mm (5 homings)', async () => {
    const emu = zPlateMachine(0.03)
    const { port } = emuPort(emu)
    const readings: TargetReading[] = []
    const offsets: number[] = []
    for (let k = 0; k < 5; k++) {
      home(emu)
      offsets.push(emu.physicalOffset[2])
      readings.push(expectOk(await runTargetProbe(port, spec())))
    }
    const injected = Math.max(...offsets) - Math.min(...offsets)
    expect(injected).toBeGreaterThan(0.005)
    const stats = repeatabilityStats(readings)
    expect(Math.abs((stats.axes.z?.spread ?? NaN) - injected)).toBeLessThanOrEqual(0.005)
    // and a clean homing passes
    const clean = zPlateMachine()
    const p2 = emuPort(clean).port
    const again: TargetReading[] = []
    for (let k = 0; k < 3; k++) {
      home(clean)
      again.push(expectOk(await runTargetProbe(p2, spec())))
    }
    expect(repeatabilityStats(again).pass).toBe(true)
  })

  it('corner plate: Z, X and Y each cycle; lost steps show without homing', async () => {
    const plate = {
      kind: 'xyzPlate' as const,
      tipDiameter: 6,
      plateThickness: 10,
      wallOffset: [5, 5] as const,
    }
    const emu = emulator({
      homing: true,
      probeScene: {
        targets: [
          {
            kind: 'cornerPlate',
            corner: [AT[0] - 5, AT[1] - 5, AT[2] - 15],
            thickness: 10,
            size: 50,
            wallOffset: [5, 5],
            facing: [-1, -1],
          },
        ],
      },
      probeTip: { shape: 'cylinder', radius: 3 },
    })
    emu.readOutput()
    home(emu)
    const { port } = emuPort(emu)
    const first = expectOk(await runTargetProbe(port, spec({ probe: plate })))
    expect(first.x).toBeCloseTo(AT[0] - 5, 2)
    expect(first.y).toBeCloseTo(AT[1] - 5, 2)
    expect(first.z).toBeCloseTo(AT[2] - 15, 2)
    // the X motor loses 0.2 mm: the next probe (no homing) finds the target 0.2 mm off
    emu.loseSteps('x', 0.2)
    const after = expectOk(await runTargetProbe(port, spec({ probe: plate })))
    const d = drift(after, first)
    expect(d.x).toBeCloseTo(-0.2, 2)
    expect(Math.abs(d.y ?? NaN)).toBeLessThan(0.005)
    // homing finds the switch again: back where it was
    home(emu)
    const homed = expectOk(await runTargetProbe(port, spec({ probe: plate })))
    expect(homed.x).toBeCloseTo(first.x!, 2)
  })

  it('an unexpected contact on the way down goes back up; below the start is refused', async () => {
    // the plate 10 mm above the start: the G38.3 descent touches it
    const emu = emulator({ homing: true, probePlate: AT[2] + 10 })
    emu.readOutput()
    home(emu)
    const { port } = emuPort(emu)
    const r = expectErrCode(await runTargetProbe(port, spec()), 'run.state')
    expect(r.issues[0]?.rule).toBe('unexpectedContact')
    expect(emu.status().mpos[2]).toBeCloseTo(-1, 3)
    // below the start (not homed back up): refused before anything moves
    send(emu, 'G53 G0 Z-80\n')
    settle(emu)
    outLines(emu)
    const { port: p2, sent } = emuPort(emu)
    const below = expectErrCode(await runTargetProbe(p2, spec()), 'run.state')
    expect(below.issues[0]?.rule).toBe('belowStart')
    expect(sent).toEqual([])
  })
})
