// The virtual machine's probe scene (v0.5 RV3): each target, the tip shapes, every G38 variant,
// Pn:P and the shorted-probe hook. Spec: docs/architecture/grbl.md#probe-scene-rv3
import { describe, expect, it } from 'vitest'
import { emulator, outLines, send, settle, statusOf } from '../emulator.fixture'
import type { EmulatorOptions } from './emulator'
import { firstChange, heightAt, probeClosed, seededBumps, type ProbeTarget } from './probe-scene'

/** Idle at `at` with the scene; the output so far dropped. */
function scene(
  targets: ProbeTarget[],
  opts: EmulatorOptions = {},
  at: [number, number, number] = [0, 0, 0],
) {
  const emu = emulator({ probeScene: { targets }, position: at, ...opts })
  emu.readOutput()
  return emu
}

/** Runs a line to its end; the output lines. */
function run(emu: ReturnType<typeof scene>, line: string): string[] {
  send(emu, `${line}\n`)
  settle(emu)
  return outLines(emu)
}

const prb = (lines: readonly string[]) => lines.find((l) => l.startsWith('[PRB:'))

const stock: ProbeTarget = { kind: 'box', min: [0, 0, -30], max: [100, 50, -20] }

describe('probe scene geometry', () => {
  it('a box: the top for a point, the sides at the tip radius (cylinder and ball)', () => {
    const s = { targets: [stock] }
    expect(probeClosed(s, { shape: 'cylinder', radius: 0 }, [10, 10, -20])).toBe(true)
    expect(probeClosed(s, { shape: 'cylinder', radius: 0 }, [10, 10, -19.99])).toBe(false)
    const cyl = { shape: 'cylinder', radius: 3 } as const
    expect(probeClosed(s, cyl, [-2.99, 10, -25])).toBe(true)
    expect(probeClosed(s, cyl, [-3.01, 10, -25])).toBe(false)
    // the cylinder extends up: beside the box above its top it does not touch, below it does
    expect(probeClosed(s, cyl, [-2, 10, -19])).toBe(false)
    const ball = { shape: 'ball', radius: 2 } as const
    // the ball's centre is 2 above the tip: at its equator on the side
    expect(probeClosed(s, ball, [-1.99, 10, -25])).toBe(true)
    expect(probeClosed(s, ball, [-2.01, 10, -25])).toBe(false)
  })

  it('firstChange finds the change to 1e-6 mm, toward and away', () => {
    const s = { targets: [stock] }
    const tip = { shape: 'cylinder', radius: 3 } as const
    const c = firstChange(s, tip, [-20, 10, -25], [50, 10, -25], true)
    expect(c?.[0]).toBeCloseTo(-3, 6)
    const away = firstChange(s, tip, [5, 10, -25], [-20, 10, -25], false)
    expect(away?.[0]).toBeCloseTo(-3, 6)
    expect(firstChange(s, tip, [-20, 60, -25], [-20, 100, -25], true)).toBeUndefined()
  })

  it('seeded bumps are deterministic; the height field adds tilt and bumps', () => {
    const a = seededBumps(7, 4, [0, 0, 200, 100], 0.5, 30)
    expect(seededBumps(7, 4, [0, 0, 200, 100], 0.5, 30)).toEqual(a)
    expect(seededBumps(8, 4, [0, 0, 200, 100], 0.5, 30)).not.toEqual(a)
    for (const b of a) expect(Math.abs(b.height)).toBeLessThanOrEqual(0.5)
    const f = { kind: 'heightField', z: -40, tilt: [0.01, -0.02], origin: [0, 0] } as const
    expect(heightAt(f, 100, 50)).toBeCloseTo(-40 + 1 - 1, 9)
    const bump = { ...f, tilt: [0, 0] as const, bumps: [{ x: 10, y: 10, height: 0.3, radius: 5 }] }
    expect(heightAt(bump, 10, 10)).toBeCloseTo(-39.7, 9)
  })
})

describe('emulator: probing the scene', () => {
  it('a stock box: G38.2 down onto the top', () => {
    const emu = scene([stock], {}, [10, 10, 0])
    expect(run(emu, 'G38.2 Z-40 F200')).toEqual(['[PRB:10.000,10.000,-20.000:1]', 'ok'])
  })

  it('a stock box side, the bit as a cylinder of radius 3: contact at the edge − r', () => {
    const emu = scene([stock], { probeTip: { shape: 'cylinder', radius: 3 } }, [-20, 10, -25])
    expect(prb(run(emu, 'G38.2 X50 F200'))).toBe('[PRB:-3.000,10.000,-25.000:1]')
    // stopped past the contact while decelerating (0.06 mm at 200 mm/min, 100 mm/s²): Pn:P
    expect(emu.status().mpos[0]).toBeGreaterThanOrEqual(-3)
    expect(emu.status().mpos[0]).toBeLessThan(-2.9)
    expect(statusOf(emu)).toContain('|Pn:P')
    expect(emu.probeTouching()).toBe(true)
  })

  it('a ball tip touches with its equator; a rotated box (Y+ onto a 10° edge)', () => {
    const emu = scene([stock], { probeTip: { shape: 'ball', radius: 2 } }, [10, -20, -26])
    expect(prb(run(emu, 'G38.2 Y20 F200'))).toBe('[PRB:10.000,-2.000,-26.000:1]')
    const rotated: ProbeTarget = { ...stock, angle: 10 } as ProbeTarget
    const r = scene([rotated], {}, [50, -50, -25])
    // the box's front edge runs through its min corner at 10°: y = x·tan 10°
    const y = 50 * Math.tan((10 * Math.PI) / 180)
    expect(prb(run(r, 'G38.2 Y40 F200'))).toBe(`[PRB:50.000,${y.toFixed(3)},-25.000:1]`)
  })

  it('an XYZ corner plate on the stock corner: top, X wall and Y wall', () => {
    const plate: ProbeTarget = {
      kind: 'cornerPlate',
      corner: [0, 0, -20],
      thickness: 5,
      size: 40,
      wallOffset: [3, 4],
    }
    const tip = { probeTip: { shape: 'cylinder', radius: 1.5 } } as const
    expect(prb(run(scene([stock, plate], tip, [10, 10, 0]), 'G38.2 Z-40 F200'))).toBe(
      '[PRB:10.000,10.000,-15.000:1]',
    )
    // below the plate's top, beside the stock: the walls hang over the edges
    expect(prb(run(scene([stock, plate], tip, [-20, 10, -18]), 'G38.2 X20 F200'))).toBe(
      '[PRB:-4.500,10.000,-18.000:1]',
    )
    expect(prb(run(scene([stock, plate], tip, [10, -20, -18]), 'G38.2 Y20 F200'))).toBe(
      '[PRB:10.000,-5.500,-18.000:1]',
    )
  })

  it('a bored hole: the wall from inside, cylinder and ball; nothing below a through hole', () => {
    const hole: ProbeTarget = { kind: 'hole', centre: [50, 50], radius: 10, top: -20, depth: 10 }
    const cyl = scene([hole], { probeTip: { shape: 'cylinder', radius: 3 } }, [50, 50, -25])
    expect(prb(run(cyl, 'G38.2 X100 F200'))).toBe('[PRB:57.000,50.000,-25.000:1]')
    const ball = scene([hole], { probeTip: { shape: 'ball', radius: 2 } }, [50, 50, -25])
    expect(prb(run(ball, 'G38.2 Y0 F200'))).toBe('[PRB:50.000,42.000,-25.000:1]')
    const down = scene([hole], { probeTip: { shape: 'cylinder', radius: 3 } }, [50, 50, 0])
    expect(run(down, 'G38.3 Z-50 F500')).toEqual(['[PRB:50.000,50.000,-50.000:0]', 'ok'])
  })

  it('a height field: a tilted bed with a bump', () => {
    const bed: ProbeTarget = {
      kind: 'heightField',
      z: -40,
      tilt: [0.01, 0],
      bumps: [{ x: 50, y: 50, height: 0.5, radius: 10 }],
    }
    expect(prb(run(scene([bed], {}, [100, 0, 0]), 'G38.2 Z-50 F300'))).toBe(
      '[PRB:100.000,0.000,-39.000:1]',
    )
    expect(prb(run(scene([bed], {}, [50, 50, 0]), 'G38.2 Z-50 F300'))).toBe(
      '[PRB:50.000,50.000,-39.000:1]',
    )
  })
})

describe('emulator: G38 variants on the scene', () => {
  const side = () => scene([stock], { probeTip: { shape: 'cylinder', radius: 3 } }, [-20, 10, -25])

  it('G38.3 stops on contact without an alarm (an unexpected contact on a positioning move)', () => {
    const emu = side()
    expect(run(emu, 'G38.3 X50 F300')).toEqual(['[PRB:-3.000,10.000,-25.000:1]', 'ok'])
    expect(emu.status().state).toBe('Idle')
  })

  it('G38.4 backs off until the input opens; G38.5 misses quietly; G38.4 miss is ALARM:5', () => {
    const emu = side()
    run(emu, 'G38.2 X50 F300')
    expect(prb(run(emu, 'G38.4 X-20 F100'))).toBe('[PRB:-3.000,10.000,-25.000:1]')
    expect(emu.status().mpos[0]).toBeLessThan(-3)
    expect(statusOf(emu)).not.toContain('Pn:')
    // touching again, then away along the face (never opens)
    run(emu, 'G38.2 X50 F300')
    expect(run(emu, 'G38.5 Y20 F300')).toEqual([
      `[PRB:${emu.status().mpos[0].toFixed(3)},20.000,-25.000:0]`,
      'ok',
    ])
    expect(run(emu, 'G38.4 Y30 F300')[0]).toBe('ALARM:5')
  })

  it('the shorted-probe hook: Pn:P, toward is ALARM:4 (no motion), away never opens', () => {
    const emu = side()
    emu.setProbeShorted(true)
    expect(statusOf(emu)).toContain('|Pn:P')
    expect(send(emu, 'G38.2 X50 F300\n')).toEqual(['ALARM:4', 'ok'])
    expect(emu.status().mpos).toEqual([-20, 10, -25])
    send(emu, '$X\n')
    expect(run(emu, 'G38.5 X-30 F300')).toEqual(['[PRB:-30.000,10.000,-25.000:0]', 'ok'])
    emu.setProbeShorted(false)
    expect(statusOf(emu)).not.toContain('Pn:')
  })

  it('setProbeScene and setProbePlate: the plate is the plane target, kept beside the others', () => {
    const emu = scene([stock], {}, [200, 10, 0])
    emu.setProbePlate(-10)
    expect(prb(run(emu, 'G38.2 Z-40 F300'))).toBe('[PRB:200.000,10.000,-10.000:1]')
    run(emu, 'G0 Z0')
    emu.setProbePlate(undefined)
    expect(run(emu, 'G38.3 Z-40 F500')[0]).toBe('[PRB:200.000,10.000,-40.000:0]')
    emu.setProbeScene(undefined)
    run(emu, 'G0 X10 Z0')
    expect(run(emu, 'G38.3 Z-40 F500')[0]).toBe('[PRB:10.000,10.000,-40.000:0]')
  })
})
