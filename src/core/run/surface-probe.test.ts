// Probing a surface map (v0.5 RV10) on the virtual machine's probe scene: the grid on a tilted
// height field, the serpentine order, a missed point and an unexpected contact on the way.
// Spec: docs/modes/run-surface.md#probing-a-map
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { emulator } from './grbl/emulator.fixture'
import { heightAt, type ProbeTarget } from './grbl/emulator/probe-scene'
import {
  mapEstimateSeconds,
  pointsFor,
  probeSurfacePoint,
  serpentine,
  SURFACE_DEFAULTS,
  surfaceGrid,
} from './surface-probe'
import { emuPort } from './probe-port.fixture'

type Vec3 = [number, number, number]

const field: Extract<ProbeTarget, { kind: 'heightField' }> = {
  kind: 'heightField',
  z: -20,
  tilt: [0.004, -0.002],
  origin: [0, 0],
}

const spec = {
  retract: SURFACE_DEFAULTS.clearance,
  fastFeed: 300,
  slowFeed: 50,
  moveFeed: 1000,
}

describe('the grid', () => {
  it('spans the area row by row; serpentine order alternates', () => {
    const g = surfaceGrid([5, 5], [95, 45], 4, 3)
    expect(g.spacing).toEqual([30, 20])
    expect(g.points[0]).toEqual([5, 5])
    expect(g.points[11]).toEqual([95, 45])
    expect(serpentine(3, 3)).toEqual([0, 1, 2, 5, 4, 3, 6, 7, 8])
    expect(pointsFor(100, 10)).toBe(11)
    expect(pointsFor(10, 50)).toBe(3)
    expect(pointsFor(1000, 10)).toBe(30)
  })

  it('estimates the time per point and between them', () => {
    const s = mapEstimateSeconds(
      [
        [0, 0],
        [10, 0],
      ],
      { clearance: 2, fastFeed: 120, slowFeed: 60, moveFeed: 600 },
    )
    // 1 s across, 2 × (1 s down, 1 s slow, 1 s rapids)
    expect(s).toBeCloseTo(7, 9)
  })
})

describe('probeSurfacePoint', () => {
  it('maps a tilted surface within 0.005 mm, in serpentine order', async () => {
    const start: Vec3 = [5, 5, -10]
    const emu = emulator({ probeScene: { targets: [field] }, position: start })
    emu.readOutput()
    const { port, sent } = emuPort(emu)
    const g = surfaceGrid([5, 5], [85, 45], 5, 3)
    let travelZ = start[2]
    let first = true
    for (const k of serpentine(g.cols, g.rows)) {
      const at = g.points[k]!
      const r = expectOk(
        await probeSurfacePoint(port, {
          ...spec,
          at,
          travelZ,
          zDistance: first ? SURFACE_DEFAULTS.firstDepth : spec.retract + SURFACE_DEFAULTS.depth,
        }),
      )
      expect(Math.abs(r.z - heightAt(field, at[0], at[1]))).toBeLessThan(0.005)
      travelZ = r.z + spec.retract
      first = false
      expect(emu.status().mpos[2]).toBeCloseTo(travelZ, 3)
    }
    // the moves across are G38.3 at the travel height; each probe a G38.2
    expect(sent.filter((l) => l.includes('G38.3'))).toHaveLength(g.cols * g.rows - 1)
    expect(sent.filter((l) => l.includes('G38.2'))).toHaveLength(2 * g.cols * g.rows)
  })

  it('a missed point is the runner recovered alarm; the machine is back at the travel height', async () => {
    const stock: ProbeTarget = { kind: 'box', min: [0, 0, -30], max: [50, 50, -20] }
    const emu = emulator({ probeScene: { targets: [stock] }, position: [70, 10, -15] })
    emu.readOutput()
    const { port } = emuPort(emu)
    const e = expectErrCode(
      await probeSurfacePoint(port, { ...spec, at: [70, 10], travelZ: -15, zDistance: 5 }),
      'machine.alarm',
    )
    expect(e.frames[0]?.data).toMatchObject({ code: 5, recovered: true })
    expect(emu.status()).toMatchObject({ state: 'Idle', mpos: [70, 10, -15] })
  })

  it('an unexpected contact on the way across goes back and refuses', async () => {
    const clamp: ProbeTarget = { kind: 'box', min: [30, 0, -30], max: [40, 50, -5] }
    const emu = emulator({ probeScene: { targets: [field, clamp] }, position: [10, 10, -10] })
    emu.readOutput()
    const { port } = emuPort(emu)
    const e = expectErrCode(
      await probeSurfacePoint(port, { ...spec, at: [60, 10], travelZ: -10, zDistance: 10 }),
      'run.state',
    )
    expect(e.issues[0]?.rule).toBe('unexpectedContact')
    expect(emu.status().mpos).toEqual([10, 10, -10])
  })

  it('rises along Z first when below the travel height; refuses bad numbers', async () => {
    const emu = emulator({ probeScene: { targets: [field] }, position: [10, 10, -18] })
    emu.readOutput()
    const { port, sent } = emuPort(emu)
    expectOk(await probeSurfacePoint(port, { ...spec, at: [20, 10], travelZ: -12, zDistance: 10 }))
    expect(sent[0]).toBe('G21 G53 G0 Z-12')
    expectErrCode(
      await probeSurfacePoint(port, { ...spec, at: [20, 10], travelZ: -12, zDistance: 0 }),
      'input.malformed',
    )
  })
})
