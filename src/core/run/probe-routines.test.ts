// The X/Y probing routines (v0.5 RV4) against the virtual machine's probe scene: each routine
// within 0.01 mm of the scene's truth for every probe kind, a rotated stock, no contact, already
// triggered, an unexpected contact on a positioning move, the kinds that cannot probe X/Y.
// Spec: docs/modes/run-probing.md#xy-probing-rv4
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { emulator } from './grbl/emulator.fixture'
import type { ProbeTarget, ProbeTip } from './grbl/emulator/probe-scene'
import { emuPort } from './probe-port.fixture'
import {
  routinePath,
  runProbeRoutine,
  type ProbeGeometry,
  type ProbeRoutine,
  type ProbeRoutineSpec,
} from './probe-routines'

type Vec3 = [number, number, number]

/** The stock: X 0–100, Y 0–50, top at Z −20 (MPos). */
const stock: ProbeTarget = { kind: 'box', min: [0, 0, -30], max: [100, 50, -20] }
const bit: ProbeTip = { shape: 'cylinder', radius: 3 }
const ball: ProbeTip = { shape: 'ball', radius: 1 }

function machine(targets: ProbeTarget[], at: Vec3, tip: ProbeTip) {
  const emu = emulator({ probeScene: { targets }, position: at, probeTip: tip })
  emu.readOutput()
  return emu
}

const tool: ProbeGeometry = { kind: 'tool', tipDiameter: 6 }
const probe3d: ProbeGeometry = { kind: '3d', tipDiameter: 2 }
const plate: ProbeGeometry = {
  kind: 'xyzPlate',
  tipDiameter: 6,
  plateThickness: 10,
  wallOffset: [5, 4],
}

const spec = (routine: ProbeRoutine, probe: ProbeGeometry, over: Partial<ProbeRoutineSpec> = {}) =>
  ({
    routine,
    probe,
    reach: 10,
    zDistance: 20,
    depth: 3,
    clearance: 2,
    fastFeed: 200,
    slowFeed: 25,
    moveFeed: 300,
    ...over,
  }) satisfies ProbeRoutineSpec

const near = (v: number | undefined, truth: number) =>
  expect(Math.abs((v ?? NaN) - truth)).toBeLessThanOrEqual(0.01)

describe('runProbeRoutine: edges', () => {
  it.each([
    ['x', -1, [5, 25, -15], 0],
    ['x', 1, [95, 25, -15], 100],
    ['y', -1, [50, 4, -15], 0],
    ['y', 1, [50, 46, -15], 50],
  ] as const)('the bit on the stock: %s side %d', async (axis, side, at, truth) => {
    const emu = machine([stock], [...at], bit)
    const { port, sent } = emuPort(emu)
    const r = expectOk(await runProbeRoutine(port, spec({ cycle: 'edge', axis, side }, tool)))
    near(r[axis]?.value, truth)
    near(r.top?.value, -20)
    expect(r.x === undefined || r.y === undefined).toBe(true)
    expect(r[axis]?.uncertainty).toBeGreaterThanOrEqual(0.001)
    // back above the start, Idle, the modal state restored, nothing written
    const s = emu.status()
    expect(s.state).toBe('Idle')
    expect(s.mpos[0]).toBeCloseTo(at[0], 3)
    expect(s.mpos[1]).toBeCloseTo(at[1], 3)
    expect(s.mpos[2]).toBeCloseTo(-18, 2)
    expect(sent.some((l) => l.includes('G10'))).toBe(false)
    expect(sent.at(-1)).toBe('G4 P0')
    // the step-out and the way down are G38.3, the contacts G38.2
    expect(sent.filter((l) => l.includes('G38.3'))).toHaveLength(2)
  })

  it('a 3D probe (ball r 1): its radius is applied', async () => {
    const emu = machine([stock], [96, 30, -15], ball)
    const { port } = emuPort(emu)
    const r = expectOk(
      await runProbeRoutine(port, spec({ cycle: 'edge', axis: 'x', side: 1 }, probe3d)),
    )
    near(r.x?.value, 100)
    near(r.top?.value, -20)
  })
})

describe('runProbeRoutine: corners', () => {
  it.each([
    [-1, -1, [10, 10, -5], 0, 0],
    [1, -1, [90, 10, -5], 100, 0],
    [-1, 1, [10, 40, -5], 0, 50],
    [1, 1, [90, 40, -5], 100, 50],
  ] as const)(
    'the XYZ plate on the %d/%d corner: thickness and wall offsets taken off',
    async (sx, sy, at, tx, ty) => {
      const cornerPlate: ProbeTarget = {
        kind: 'cornerPlate',
        corner: [tx, ty, -20],
        thickness: 10,
        size: 30,
        wallOffset: [5, 4],
        facing: [sx, sy],
      }
      // the clip is on the bit and the plate is the target: a wooden stock is not in the scene
      const emu = machine([cornerPlate], [...at], bit)
      const { port } = emuPort(emu)
      const r = expectOk(
        await runProbeRoutine(
          port,
          spec({ cycle: 'corner', corner: [sx, sy] }, plate, { reach: 30, zDistance: 30 }),
        ),
      )
      near(r.top?.value, -20)
      near(r.x?.value, tx)
      near(r.y?.value, ty)
      expect(emu.status().mpos[0]).toBeCloseTo(at[0], 3)
      expect(emu.status().mpos[1]).toBeCloseTo(at[1], 3)
    },
  )

  it('the bit on a conductive stock, and a 3D probe', async () => {
    for (const [tip, geometry] of [
      [bit, tool],
      [ball, probe3d],
    ] as const) {
      const emu = machine([stock], [6, 7, -15], tip)
      const { port } = emuPort(emu)
      const r = expectOk(
        await runProbeRoutine(port, spec({ cycle: 'corner', corner: [-1, -1] }, geometry)),
      )
      near(r.x?.value, 0)
      near(r.y?.value, 0)
      near(r.top?.value, -20)
    }
  })

  it('a stock rotated by 0.5°: each edge where the probe crossed it', async () => {
    const angle = 0.5
    const a = (angle * Math.PI) / 180
    const emu = machine([{ ...stock, angle }], [6, 7, -15], bit)
    const { port } = emuPort(emu)
    const r = expectOk(
      await runProbeRoutine(port, spec({ cycle: 'corner', corner: [-1, -1] }, tool)),
    )
    // the X− edge runs from the min corner along (−sin a, cos a); the Y− edge along (cos a, sin a)
    near(r.x?.value, -7 * Math.tan(a))
    near(r.y?.value, 6 * Math.tan(a))
  })
})

describe('runProbeRoutine: failures', () => {
  it('no contact on the top (a wooden stock with the bit): ALARM:5 recovered, back at the start', async () => {
    const emu = machine([], [6, 7, -15], bit)
    const { port, sent } = emuPort(emu)
    const err = expectErrCode(
      await runProbeRoutine(port, spec({ cycle: 'corner', corner: [-1, -1] }, tool)),
      'machine.alarm',
    )
    expect(err.frames[0]?.data).toMatchObject({ code: 5, recovered: true })
    expect(emu.status()).toMatchObject({ state: 'Idle', mpos: [6, 7, -15] })
    expect(sent.some((l) => l.includes('G38.3'))).toBe(false)
  })

  it('no contact on the side: back up and over to the start', async () => {
    // a 2 mm sheet: the 3D probe's ball 5 mm below its top passes under it
    const sheet: ProbeTarget = { kind: 'box', min: [0, 0, -22], max: [100, 50, -20] }
    const emu = machine([sheet], [6, 7, -15], ball)
    const { port } = emuPort(emu)
    const err = expectErrCode(
      await runProbeRoutine(
        port,
        spec({ cycle: 'edge', axis: 'x', side: -1 }, probe3d, { depth: 5 }),
      ),
      'machine.alarm',
    )
    expect(err.frames[0]?.data).toMatchObject({ code: 5, recovered: true })
    const s = emu.status()
    expect(s.state).toBe('Idle')
    expect(s.mpos[0]).toBeCloseTo(6, 3)
    expect(s.mpos[2]).toBeCloseTo(-18, 2)
  })

  it('already triggered: refused before anything is sent', async () => {
    const emu = machine([stock], [6, 7, -15], bit)
    emu.setProbeShorted(true)
    const { port, sent } = emuPort(emu)
    const err = expectErrCode(
      await runProbeRoutine(port, spec({ cycle: 'corner', corner: [-1, -1] }, tool)),
      'run.state',
    )
    expect(err.issues[0]?.rule).toBe('probeTouching')
    expect(sent).toEqual([])
  })

  it('an unexpected contact on the step-out (a clamp): back to the start, the routine aborts', async () => {
    const clamp: ProbeTarget = { kind: 'box', min: [-8, 0, -30], max: [-6, 50, 0] }
    const emu = machine([stock, clamp], [6, 7, -15], bit)
    const { port } = emuPort(emu)
    const err = expectErrCode(
      await runProbeRoutine(port, spec({ cycle: 'edge', axis: 'x', side: -1 }, tool)),
      'run.state',
    )
    expect(err.issues[0]?.rule).toBe('unexpectedContact')
    const s = emu.status()
    expect(s.state).toBe('Idle')
    expect(s.mpos[0]).toBeCloseTo(6, 3)
    expect(s.mpos[2]).toBeCloseTo(-18, 2)
  })

  it('a Z plate cannot probe X/Y; a corner plate needs its geometry', async () => {
    const emu = machine([stock], [6, 7, -15], bit)
    const { port, sent } = emuPort(emu)
    const corner: ProbeRoutine = { cycle: 'corner', corner: [-1, -1] }
    const z = expectErrCode(
      await runProbeRoutine(port, spec(corner, { kind: 'zPlate', tipDiameter: 6 })),
      'run.state',
    )
    expect(z.issues[0]?.rule).toBe('probeKind')
    const g = expectErrCode(
      await runProbeRoutine(port, spec(corner, { kind: 'xyzPlate', tipDiameter: 6 })),
      'run.state',
    )
    expect(g.issues[0]?.rule).toBe('probeGeometry')
    expectErrCode(await runProbeRoutine(port, spec(corner, tool, { reach: 0 })), 'input.malformed')
    expect(sent).toEqual([])
  })
})

describe('runProbeRoutine: centres', () => {
  it('a hole with a 3D probe: centre and Ø from an off-centre start', async () => {
    const hole: ProbeTarget = { kind: 'hole', centre: [50, 25], radius: 6, top: -20, depth: 10 }
    const emu = machine([hole], [51.3, 23.4, -25], ball)
    const { port } = emuPort(emu)
    const r = expectOk(
      await runProbeRoutine(
        port,
        spec({ cycle: 'centre', feature: 'hole', diameter: 16 }, probe3d),
      ),
    )
    near(r.centre?.x.value, 50)
    near(r.centre?.y.value, 25)
    near(r.centre?.diameter.value, 12)
    expect(r.top).toBeUndefined()
    // it ends in the centre
    expect(emu.status().mpos[0]).toBeCloseTo(50, 2)
    expect(emu.status().mpos[1]).toBeCloseTo(25, 2)
  })

  it('a boss (the bit): from above, the top, centre and Ø', async () => {
    // the outside of an annulus is a round boss of radius 10 (its tiny bore is never reached)
    const boss: ProbeTarget = {
      kind: 'hole',
      centre: [40, 30],
      radius: 0.01,
      outerRadius: 10,
      top: -20,
      depth: 15,
    }
    const emu = machine([boss], [41, 28.5, -15], bit)
    const { port } = emuPort(emu)
    const r = expectOk(
      await runProbeRoutine(
        port,
        spec({ cycle: 'centre', feature: 'boss', diameter: 24 }, tool, { reach: 3 }),
      ),
    )
    near(r.top?.value, -20)
    near(r.centre?.x.value, 40)
    near(r.centre?.y.value, 30)
    near(r.centre?.diameter.value, 20)
  })

  it('a corner plate cannot find a centre', async () => {
    const emu = machine([stock], [6, 7, -15], bit)
    const { port } = emuPort(emu)
    const err = expectErrCode(
      await runProbeRoutine(port, spec({ cycle: 'centre', feature: 'hole', diameter: 10 }, plate)),
      'run.state',
    )
    expect(err.issues[0]?.rule).toBe('probeKind')
  })
})

describe('routinePath', () => {
  it('a corner: down to the top, lift, out beyond the reach, down, in, back, and Y the same', () => {
    const path = routinePath(spec({ cycle: 'corner', corner: [-1, -1] }, tool), [6, 7, -15], -20)
    expect(path[0]).toEqual([6, 7, -20])
    expect(path[1]).toEqual([6, 7, -18])
    // out by reach + r + clearance = 15, then down to 3 below the top
    expect(path[2]).toEqual([-9, 7, -18])
    expect(path[3]).toEqual([-9, 7, -23])
    const lowest = Math.min(...path.map((p) => p[2]))
    expect(lowest).toBe(-23)
    expect(Math.min(...path.map((p) => p[1]))).toBe(-8)
    // ends back above the start
    expect(path.at(-1)).toEqual([6, 7, -18])
  })
})
