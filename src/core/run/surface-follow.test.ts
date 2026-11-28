// The surface map's oracle (v0.5 RV10): map a tilted stock top on the virtual machine, export an
// engraving that follows the map, stream it, and check along the traced tool path that the tip
// stays at the programmed depth below the real surface within 0.02 mm (without the map it does
// not). Spec: docs/modes/run-surface.md#following-the-map, docs/plans/v0.5-run.md (RV10)
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { exportGrbl } from '../post/export'
import type { HeightMap } from '../post/height-map'
import { exportInput, operation, OPTS } from '../post/post.fixture'
import { endMill } from '../toolpath/testing/fixtures'
import type { Move, Toolpath } from '../toolpath/model'
import { emulator, send } from './grbl/emulator.fixture'
import { heightAt, type ProbeTarget } from './grbl/emulator/probe-scene'
import { emuPort } from './probe-port.fixture'
import { probeSurfacePoint, serpentine, SURFACE_DEFAULTS, surfaceGrid } from './surface-probe'

type Vec3 = readonly [number, number, number]

/** G54 X/Y: the stock's front-left corner in machine coordinates. */
const G54: readonly [number, number] = [-300, -200]
/** The stock top: tilted 0.5 mm over 100 mm in X, −0.3 in Y, with a gentle wide bump. */
const field: Extract<ProbeTarget, { kind: 'heightField' }> = {
  kind: 'heightField',
  z: -40,
  tilt: [0.005, -0.003],
  origin: [G54[0], G54[1]],
  bumps: [{ x: G54[0] + 50, y: G54[1] + 30, height: 0.15, radius: 60 }],
}
/** The touch-off spot (work X/Y) where Z0 is set on the surface. */
const SPOT: readonly [number, number] = [10, 10]
const DEPTH = 0.3

/** An engraving at −0.3: a long line, a half circle, back, and a diagonal. */
function engraving() {
  const tool = endMill(3)
  const moves: Move[] = [
    { kind: 'rapid', to: [8, 8, 10] },
    { kind: 'rapid', to: [8, 8, 2] },
    { kind: 'line', to: [8, 8, -DEPTH], feed: 300 },
    { kind: 'line', to: [80, 8, -DEPTH], feed: 1500 },
    { kind: 'arc', to: [80, 48, -DEPTH], center: [80, 28], cw: false, feed: 1500 },
    { kind: 'line', to: [8, 48, -DEPTH], feed: 1500 },
    { kind: 'line', to: [60, 20, -DEPTH], feed: 1500 },
    { kind: 'rapid', to: [60, 20, 10] },
  ]
  const tp: Toolpath = {
    planOperationId: 'engraving1',
    tool: tool.id,
    spindleSpeed: 12000,
    passes: [{ kind: 'finish', moves }],
    stats: { cutLength: 0, rapidLength: 0, estimatedSeconds: 0 },
  }
  return {
    ...operation(tp, tool, 'Engraving 1'),
    zRef: { label: 'the top face', level: 0, at: SPOT, top: true },
  }
}

/** Probes a 6 × 4 grid over the stock top (work 2–98 × 2–58) and returns the map. */
async function probeMap(emu: ReturnType<typeof emulator>, g54z: number): Promise<HeightMap> {
  const { port } = emuPort(emu)
  const g = surfaceGrid([2, 2], [98, 58], 6, 4)
  const z: (number | null)[] = g.points.map(() => null)
  let travelZ = emu.status().mpos[2]
  let first = true
  for (const k of serpentine(g.cols, g.rows)) {
    const [x, y] = g.points[k]!
    const r = expectOk(
      await probeSurfacePoint(port, {
        at: [x + G54[0], y + G54[1]],
        travelZ,
        zDistance: first ? SURFACE_DEFAULTS.firstDepth : 2 + SURFACE_DEFAULTS.depth,
        retract: 2,
        fastFeed: 300,
        slowFeed: 30,
        moveFeed: 2000,
      }),
    )
    z[k] = r.z - g54z
    travelZ = r.z + 2
    first = false
  }
  return { ...g, z, workZero: G54 }
}

/** Streams `lines` line by line to their `ok`; the machine's MPos after each one. */
function stream(emu: ReturnType<typeof emulator>, lines: readonly string[]): Vec3[] {
  const { port } = emuPort(emu)
  const path: Vec3[] = []
  for (const l of lines) {
    void port.command(l)
    const s = emu.status()
    expect(s.state === 'Idle' || s.state === 'Run', `${l}: ${s.state}`).toBe(true)
    path.push(s.mpos)
  }
  return path
}

/** The tip's depth below the real surface along every cutting stretch, in 0.25 mm steps. */
function depths(path: readonly Vec3[]): number[] {
  const out: number[] = []
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1]!
    const b = path[k]!
    // a cut: both ends below the real surface by more than half the depth
    const below = (p: Vec3) => heightAt(field, p[0], p[1]) - p[2] > DEPTH / 2
    if (!below(a) || !below(b)) continue
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25))
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
      out.push(heightAt(field, p[0]!, p[1]!) - p[2]!)
    }
  }
  return out
}

describe('following a surface map on the virtual machine', () => {
  it('keeps the programmed depth below a tilted surface within 0.02 mm', async () => {
    const emu = emulator({
      probeScene: { targets: [field] },
      position: [G54[0] + 2, G54[1] + 2, -30],
    })
    emu.readOutput()
    // Z0 touched off on the surface at the spot (as Probe Z would)
    const g54z = heightAt(field, SPOT[0] + G54[0], SPOT[1] + G54[1])
    send(emu, `G10 L2 P1 X${G54[0]} Y${G54[1]} Z${g54z.toFixed(4)}\n`)
    const map = await probeMap(emu, g54z)
    // the operator takes the probe away before the cut
    emu.setProbeScene(undefined)
    const input = exportInput([engraving()])
    const followed = expectOk(exportGrbl({ ...input, heightMap: { map } }, OPTS))
    expect(followed.surface?.maxDz).toBeGreaterThan(0.2)
    const d = depths(stream(emu, followed.lines))
    expect(d.length).toBeGreaterThan(1000)
    for (const v of d) expect(Math.abs(v - DEPTH)).toBeLessThan(0.02)
    // without the map the depth wanders with the surface
    const plain = expectOk(exportGrbl(input, OPTS))
    const p = depths(stream(emu, plain.lines))
    expect(Math.max(...p.map((v) => Math.abs(v - DEPTH)))).toBeGreaterThan(0.2)
  })
})
