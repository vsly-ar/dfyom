// The bed map (v0.5 RV11): the floor bound in every probe cycle (the runner, the X/Y routines'
// positioning, the repeatability descent, a map point's move across), a bed mapped on the
// emulator's warped bed and then used as the floor, and the map's validity rules.
// Spec: docs/modes/run-surface.md#the-bed-map-rv11
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import {
  bedFollowMap,
  bedMapStamp,
  bedMapState,
  floorFunction,
  floorSetting,
  spoilboardFloorZ,
  virtualBed,
  type BedMapContext,
  type BedMapLike,
} from './bed-map'
import { emulator } from './grbl/emulator.fixture'
import { heightAt, type ProbeTarget } from './grbl/emulator/probe-scene'
import { runTargetProbe } from './homing-repeatability'
import { floorHit, FLOOR_MARGIN, runProbeCycle } from './probe-cycle'
import { emuPort } from './probe-port.fixture'
import { runProbeRoutine } from './probe-routines'
import { probeSurfacePoint, serpentine, SURFACE_DEFAULTS, surfaceGrid } from './surface-probe'

type Vec3 = [number, number, number]

const plane = (z: number) => () => z
const machine = (targets: ProbeTarget[], at: Vec3, homing = false) => {
  const emu = emulator({ probeScene: { targets }, position: at, homing })
  emu.readOutput()
  return emu
}
const ruleOf = (e: { issues: readonly { rule: string }[] }) => e.issues[0]?.rule

describe('the floor in every cycle', () => {
  it('a Z probe down stops 1 mm above the floor: no bed contact, a recovered miss', async () => {
    // nothing to touch above the floor at −30: the seek ends at −29, not at its 50 mm
    const emu = machine([], [10, 10, -10])
    const { port, sent } = emuPort(emu)
    const r = await runProbeCycle(port, {
      axis: 'z',
      direction: -1,
      maxDistance: 50,
      fastFeed: 300,
      retract: 2,
      floor: plane(-30),
    })
    expect(expectErrCode(r, 'machine.alarm').frames[0]?.data).toMatchObject({ recovered: true })
    expect(sent.find((l) => l.includes('G38.2'))).toMatch(/Z-29 /)
  })

  it('a Z probe with less than 1 mm of room is refused before anything is sent', async () => {
    const emu = machine([], [10, 10, -28.5])
    const { port, sent } = emuPort(emu)
    const r = await runProbeCycle(port, {
      axis: 'z',
      direction: -1,
      maxDistance: 20,
      fastFeed: 300,
      retract: 2,
      floor: plane(-30),
    })
    const e = expectErrCode(r, 'run.travel')
    expect(ruleOf(e)).toBe('floor')
    expect(e.message).toMatch(/^The bed is 1\.5 mm below the probe here/)
    expect(sent).toEqual([])
  })

  it('an X probe below the floor’s margin is refused before anything is sent', async () => {
    const emu = machine([], [10, 10, -29.5])
    const { port, sent } = emuPort(emu)
    const r = await runProbeCycle(port, {
      axis: 'x',
      direction: 1,
      maxDistance: 10,
      fastFeed: 300,
      retract: 2,
      floor: plane(-30),
    })
    expect(ruleOf(expectErrCode(r, 'run.travel'))).toBe('floor')
    expect(sent).toEqual([])
  })

  it('a routine’s step down beside the stock is refused when it would reach the bed', async () => {
    // a 3 mm sheet on the bed at −23: probing an edge 5 mm below its top goes into the bed
    const sheet: ProbeTarget = { kind: 'box', min: [0, 0, -23], max: [100, 50, -20] }
    const emu = machine([sheet], [5, 25, -15])
    const { port, sent } = emuPort(emu)
    const r = await runProbeRoutine(port, {
      routine: { cycle: 'edge', axis: 'x', side: -1 },
      probe: { kind: 'tool', tipDiameter: 6 },
      reach: 10,
      zDistance: 20,
      depth: 5,
      clearance: 2,
      fastFeed: 200,
      slowFeed: 25,
      moveFeed: 300,
      floor: plane(-23),
    })
    expect(ruleOf(expectErrCode(r, 'run.travel'))).toBe('floor')
    // the top was probed, but no positioning move went below the floor's margin
    for (const l of sent.filter((x) => x.includes('G38.3'))) {
      const z = /Z(-?[\d.]+)/.exec(l)?.[1]
      if (z !== undefined) expect(Number(z)).toBeGreaterThanOrEqual(-23 + FLOOR_MARGIN)
    }
  })

  it('the repeatability descent to a start within the margin is refused before moving', async () => {
    const emu = machine([], [-300, -200, -1], true)
    const { port, sent } = emuPort(emu)
    const r = await runTargetProbe(port, {
      at: [-300, -200, -60],
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
      floor: plane(-60.5),
    })
    expect(ruleOf(expectErrCode(r, 'run.travel'))).toBe('floor')
    expect(sent).toEqual([])
  })

  it('a map point’s move across is refused where the bed rises within the margin', async () => {
    const emu = machine([], [0, 0, -20])
    const { port, sent } = emuPort(emu)
    // the bed rises from −40 to −10 along X: the move across at −20 meets it
    const r = await probeSurfacePoint(port, {
      at: [100, 0],
      travelZ: -20,
      zDistance: 10,
      retract: 2,
      fastFeed: 300,
      slowFeed: 50,
      moveFeed: 1000,
      floor: (x) => -40 + 0.3 * x,
    })
    expect(ruleOf(expectErrCode(r, 'run.travel'))).toBe('floor')
    expect(sent.some((l) => l.includes('G38'))).toBe(false)
  })

  it('floorHit samples the whole path', () => {
    expect(floorHit(undefined, [0, 0, -50], [10, 0, -50])).toBeUndefined()
    expect(floorHit(plane(-30), [0, 0, -20], [10, 0, -20])).toBeUndefined()
    // a bump in the middle of the path only
    const bump = (x: number) => (Math.abs(x - 50) < 2 ? -20.5 : -40)
    expect(floorHit(bump, [0, 0, -20], [100, 0, -20])?.at[0]).toBeCloseTo(49, 6)
  })
})

describe('a bed map on the warped virtual bed', () => {
  const travel: [number, number, number] = [800, 600, 100]
  const bed: Extract<ProbeTarget, { kind: 'heightField' }> = {
    kind: 'heightField',
    ...virtualBed(travel, -80),
  }

  it('maps the bed within 0.005 mm; as the floor, a probe stops 1 mm above it', async () => {
    const start: Vec3 = [-790, -590, -70]
    const emu = machine([bed], start)
    const { port } = emuPort(emu)
    const g = surfaceGrid([-790, -590], [-10, -10], 5, 4)
    const z: (number | null)[] = g.points.map(() => null)
    let travelZ = start[2]
    let first = true
    for (const k of serpentine(g.cols, g.rows)) {
      const at = g.points[k]!
      const r = expectOk(
        await probeSurfacePoint(port, {
          at,
          travelZ,
          zDistance: first ? SURFACE_DEFAULTS.firstDepth : 2 + SURFACE_DEFAULTS.depth,
          retract: 2,
          fastFeed: 300,
          slowFeed: 50,
          moveFeed: 3000,
        }),
      )
      expect(Math.abs(r.z - heightAt(bed, at[0], at[1]))).toBeLessThan(0.005)
      z[k] = r.z
      travelZ = r.z + 2
      first = false
    }
    const heights = z as number[]
    // the warp shows: a tilt and the bumps, under the 1 mm follow limit
    const range = Math.max(...heights) - Math.min(...heights)
    expect(range).toBeGreaterThan(0.2)
    expect(range).toBeLessThan(1)

    const map: BedMapLike = {
      date: '2026-11-28T10:00:00.000Z',
      origin: g.origin,
      spacing: g.spacing,
      cols: g.cols,
      rows: g.rows,
      z,
      ...bedMapStamp({ envelope: { travel, pullOff: 1, homingMask: 3 } }),
    }
    const floor = floorFunction(floorSetting(map, {}))!
    // a probe down over the bed, 4 mm above it: cut to stop 1 mm above the mapped bed
    const p: [number, number] = [-400, -300]
    const surface = heightAt(bed, p[0], p[1])
    expect(Math.abs(floor(p[0], p[1])! - surface)).toBeLessThan(0.1)
    const emu2 = machine([bed], [p[0], p[1], surface + 4])
    const two = emuPort(emu2)
    const r = await runProbeCycle(two.port, {
      axis: 'z',
      direction: -1,
      maxDistance: 25,
      fastFeed: 300,
      retract: 2,
      floor,
    })
    expect(expectErrCode(r, 'machine.alarm').frames[0]?.data).toMatchObject({ recovered: true })
    expect(emu2.status().mpos[2]).toBeCloseTo(surface + 4, 3)
    // while the bed is mapped again, the old map is left out: the probe reaches the bed
    expect(floorFunction(floorSetting(map, {}), false)).toBeUndefined()
  })
})

describe('validity and the floor setting', () => {
  const stamp = bedMapStamp({
    envelope: {
      travel: [800, 600, 100],
      pullOff: 1,
      homingMask: 3,
      workArea: { min: [-790, -590, -95], max: [-10, -10, -2] },
    },
    repeatability: { date: '2026-11-01T00:00:00.000Z', pass: true },
  })
  const map: BedMapLike = {
    date: '2026-11-10T00:00:00.000Z',
    origin: [-700, -500],
    spacing: [100, 100],
    cols: 2,
    rows: 2,
    z: [-80, -80.2, -80.4, -80.6],
    stickout: 30,
    ...stamp,
  }
  const ctx: BedMapContext = {
    homed: true,
    envelope: {
      travel: [800, 600, 100],
      pullOff: 1,
      homingMask: 3,
      workArea: { min: [-790, -590, -95], max: [-10, -10, -2] },
    },
    repeatability: { date: '2026-11-01T00:00:00.000Z', pass: true },
    now: Date.parse('2026-11-20T00:00:00.000Z'),
    maxAgeDays: 30,
  }

  it('usable on the same homing and work area; old after the age (a warning only)', () => {
    expect(bedMapState(map, ctx)).toEqual({ old: false, ageDays: 10 })
    const later = bedMapState(map, { ...ctx, now: Date.parse('2027-01-20T00:00:00.000Z') })
    expect(later.unusable).toBeUndefined()
    expect(later.old).toBe(true)
  })

  it('stale when the homing or the work area changed, or a newer repeatability test failed', () => {
    const e = ctx.envelope!
    expect(bedMapState(map, { ...ctx, homed: false }).unusable).toBe('notHomed')
    expect(bedMapState(map, { ...ctx, envelope: { ...e, pullOff: 2 } }).unusable).toBe('homing')
    expect(bedMapState(map, { ...ctx, envelope: { ...e, homingMask: 0 } }).unusable).toBe('homing')
    expect(
      bedMapState(map, {
        ...ctx,
        envelope: { ...e, workArea: { min: [-780, -590, -95], max: [-10, -10, -2] } },
      }).unusable,
    ).toBe('workArea')
    const { workArea: _w, ...unmarked } = e
    expect(bedMapState(map, { ...ctx, envelope: unmarked }).unusable).toBe('workArea')
    const failedSince = { date: '2026-11-15T00:00:00.000Z', pass: false }
    expect(bedMapState(map, { ...ctx, repeatability: failedSince }).unusable).toBe('repeatability')
    // a passing test since confirms the homing the map relies on
    expect(
      bedMapState(map, { ...ctx, repeatability: { ...failedSince, pass: true } }).unusable,
    ).toBeUndefined()
    expect(bedMapState({ ...map, z: [-80, null, -80.4, -80.6] }, ctx).unusable).toBe('incomplete')
  })

  it('the floor follows a longer tool up; clamped to the grid outside it; the plane elsewhere', () => {
    const s = floorSetting(map, { stickout: 35, plane: -90 })!
    expect(s.map!.z).toEqual([-75, -75.2, -75.4, -75.6])
    expect(s.plane).toBe(-90)
    const f = floorFunction(s)!
    expect(f(-650, -500)).toBeCloseTo(-75.1, 9)
    expect(f(-900, -900)).toBeCloseTo(-75, 9)
    // without a stickout on either side the map is used as it is
    expect(floorSetting(map, {})!.map!.z).toEqual(map.z)
    expect(floorFunction(floorSetting(undefined, { plane: -90 }))!(0, 0)).toBe(-90)
    expect(floorSetting(undefined, {})).toBeUndefined()
    // nose 120 above the table at Z home (−1), a 15 mm board, a 30 mm stickout
    expect(spoilboardFloorZ(120, 15, 1, 30)).toBe(-76)
  })

  it('moves into the work frame of the live G54 for following', () => {
    const w = bedFollowMap(map, [-600, -400])
    expect(w.origin).toEqual([-100, -100])
    expect(w.workZero).toEqual([-600, -400])
    expect(w.z).toEqual(map.z)
  })
})
