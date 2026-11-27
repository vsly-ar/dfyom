import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { inProcessWorkers } from '../commands/jobs'
import { signalSteps } from '../workers/steps'
import { simulateHeightmapTask } from '../workers/tasks'
import type { Move, Toolpath, ToolpathTool, Vec3 } from './model'
import {
  CHORD_TOL,
  simulateHeightmap,
  toolProfile,
  Z_STEP,
  type CutMap,
  type SimulateSetup,
} from './simulate'
import {
  ENCLOSURE_BOTTOM_NC,
  ENCLOSURE_STOCK,
  ENCLOSURE_TOP_NC,
  parseGcode,
  readGcode,
  type ProgramToolpath,
} from './testing/gcode'
import { bullNose, chamferMill, drill, endMill, taperedBall } from './testing/fixtures'
import { Heightmap, toolSurface } from './testing/oracles'
import { turnToolpath } from './wcs'

const ball = (d: number): ToolpathTool => ({ ...bullNose(d, d / 2), type: 'ballEndMill' })
const STOCK = { length: 40, width: 30, thickness: 10 }

const toolpath = (moves: Move[], id = 'op'): Toolpath => ({
  planOperationId: id,
  tool: 't',
  spindleSpeed: 0,
  passes: [{ kind: 'rough', moves }],
  stats: { cutLength: 0, rapidLength: 0, estimatedSeconds: 0 },
})

const rapid = (to: Vec3): Move => ({ kind: 'rapid', to })
const line = (to: Vec3): Move => ({ kind: 'line', to, feed: 1000 })

function simulate(tool: ToolpathTool, moves: Move[], cell = 0.25, stock = STOCK): CutMap {
  return simulateHeightmap({
    stock,
    cell,
    setups: [{ direction: '+z', rotation: 0, toolpaths: [{ tool, toolpath: toolpath(moves) }] }],
  }).unwrap()[0]!
}

/** The oracle's map (sampled stamps every `step`), clamped at the stock bottom. */
function oracle(programs: readonly ProgramToolpath[], stock = STOCK, cell = 0.25, step = 0.02) {
  const map = new Heightmap(stock.length, stock.width, cell)
  for (const p of programs) map.sweep(p.tool, p.toolpath, step)
  return map.z.map((z) => Math.max(-stock.thickness, z))
}

/**
 * Cells whose value lies outside every oracle value of its 3 × 3 neighbourhood by more than
 * `tol`: "equal within one cell" (a cell centre exactly on the tool's edge may fall either way).
 */
function offByMoreThanOneCell(m: CutMap, o: Float64Array, tol: number): number {
  let bad = 0
  for (let j = 0; j < m.nv; j++)
    for (let i = 0; i < m.nu; i++) {
      let lo = Infinity
      let hi = -Infinity
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ii = i + di
          const jj = j + dj
          if (ii < 0 || jj < 0 || ii >= m.nu || jj >= m.nv) continue
          const v = o[jj * m.nu + ii]!
          lo = Math.min(lo, v)
          hi = Math.max(hi, v)
        }
      const v = m.h[j * m.nu + i]!
      if (v < lo - tol || v > hi + tol) bad++
    }
  return bad
}

const at = (m: CutMap, i: number, j: number) => m.h[j * m.nu + i]!
const centre = (m: CutMap, k: number): [number, number] => [
  ((k % m.nu) + 0.5) * m.cell,
  (Math.floor(k / m.nu) + 0.5) * m.cell,
]

/** Distance from (x, y) to the segment a–b in XY. */
function segDist(x: number, y: number, a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy)
}

describe('tool profiles', () => {
  it('equal toolSurface for every tool type', () => {
    const tools = [endMill(6), bullNose(6, 1), ball(6), drill(5), drill(5, 180), chamferMill(6)]
    tools.push(chamferMill(10, 60, 1), taperedBall(3.175, 0.5, 3.6))
    for (const tool of tools) {
      const p = toolProfile(tool)
      for (let rho = 0; rho <= tool.diameter / 2; rho += 0.01)
        expect(p.surface(rho)).toBeCloseTo(toolSurface(tool, rho), 12)
    }
  })

  it('a tapered ball end mill: ball, then the tangent cone; cutting radius capped by the flutes (DF124 T1)', () => {
    const t = taperedBall(3.175, 0.5, 3.6)
    expect(toolProfile(t).radius).toBeCloseTo(3.175 / 2, 12) // the cone reaches DC at 21.5 < 22 mm
    expect(toolSurface(t, 0)).toBe(0)
    expect(toolSurface(t, 0.1)).toBeCloseTo(0.25 - Math.sqrt(0.25 ** 2 - 0.1 ** 2), 12)
    // tapered-ball-nose.md § The tool: 0.60 mm wide at 1 mm, 0.85 at 3 mm, 1.85 at 11 mm
    const half = (d: number) =>
      (0.5 / Math.cos((3.6 * Math.PI) / 180) + 2 * (d - 0.25) * Math.tan((3.6 * Math.PI) / 180)) / 2
    for (const [d, w] of [
      [1, 0.6],
      [3, 0.85],
      [11, 1.85],
    ] as const) {
      expect(toolSurface(t, half(d))).toBeCloseTo(d, 9)
      expect(2 * half(d)).toBeCloseTo(w, 2)
    }
    // 10 mm flutes end before the cone reaches DC: the profile ends at the cone's radius there
    const short = taperedBall(3.175, 0.5, 3.6, 10)
    expect(toolProfile(short).radius).toBeCloseTo(half(10), 9)
    expect(toolSurface(short, half(10) + 0.01)).toBe(Infinity)
  })
})

describe('simulateHeightmap', () => {
  it('cuts a level line with a flat end exactly: the tip Z within the radius, nothing beyond', () => {
    const a: Vec3 = [8.1, 10.3, -2]
    const b: Vec3 = [31.7, 19.9, -2]
    const m = simulate(endMill(6), [
      rapid([a[0], a[1], 5]),
      line(a),
      line(b),
      rapid([b[0], b[1], 5]),
    ])
    let cut = 0
    for (let k = 0; k < m.h.length; k++) {
      const [x, y] = centre(m, k)
      const d = segDist(x, y, a, b)
      // the plunge at `a` reaches the same cells as the line's end
      if (Math.abs(d - 3) < 1e-6) continue
      expect(m.h[k]).toBe(d < 3 ? -2 : 0)
      if (d < 3) cut++
    }
    expect(cut).toBeGreaterThan(1000)
  })

  it('cuts a ramp with a flat end at the lowest tip Z over each cell', () => {
    const a: Vec3 = [5, 15, 0]
    const b: Vec3 = [35, 15, -3]
    const m = simulate(endMill(4), [rapid([5, 15, 1]), line(a), line(b)])
    for (let k = 0; k < m.h.length; k++) {
      const [x, y] = centre(m, k)
      if (segDist(x, y, a, b) >= 2 - 1e-9) continue
      // the farthest point along the ramp still under the tool (Z falls with x)
      const reach = x + Math.sqrt(4 - (y - 15) ** 2)
      const t = Math.min(1, Math.max(0, (reach - 5) / 30))
      expect(m.h[k]).toBeCloseTo(-3 * t, 5) // float32 map
    }
  })

  it('cuts a ball nose exactly on level moves and within Z_STEP above the true sweep on slopes', () => {
    const tool = ball(6)
    const level = simulate(tool, [rapid([10, 15, 1]), line([10, 15, -1]), line([30, 15, -1])])
    for (let k = 0; k < level.h.length; k++) {
      const [x, y] = centre(level, k)
      const d = segDist(x, y, [10, 15, -1], [30, 15, -1])
      if (d >= 3 || Math.abs(d - 3) < 1e-6) continue
      expect(level.h[k]).toBeCloseTo(Math.min(0, -1 + 3 - Math.sqrt(9 - d * d)), 5) // float32 map
    }
    const moves = [rapid([10, 10, 1]), line([10, 10, 0]), line([30, 20, -4])]
    const slope = simulate(tool, moves)
    // a dense oracle (0.005 mm samples) is the true sweep within its sampling error
    const o = oracle([{ tool, toolpath: toolpath(moves) }], STOCK, 0.25, 0.005)
    let worst = 0
    for (let k = 0; k < o.length; k++) {
      const d = slope.h[k]! - o[k]!
      expect(d).toBeGreaterThan(-1e-3) // never deeper than the tool reaches
      worst = Math.max(worst, d)
    }
    expect(worst).toBeLessThanOrEqual(Z_STEP + 1e-3)
  })

  it('cuts a V-bit groove as its cone: depth falls with the distance from the path', () => {
    const tool = chamferMill(10, 90)
    const m = simulate(tool, [rapid([5, 15, 1]), line([5, 15, -3]), line([35, 15, -3])])
    for (let i = 0; i < m.nu; i++)
      for (let j = 0; j < m.nv; j++) {
        const [x, y] = [(i + 0.5) * m.cell, (j + 0.5) * m.cell]
        const d = segDist(x, y, [5, 15, -3], [35, 15, -3])
        if (d >= 5) continue
        expect(at(m, i, j)).toBeCloseTo(Math.min(0, -3 + d), 5) // 90° included: depth = distance (float32 map)
      }
  })

  it('cuts a drill cycle with its point exactly, pecks included', () => {
    const tool = drill(5, 118)
    const hole: Move = {
      kind: 'drill',
      at: [20.125, 15.125],
      top: 0,
      bottom: -6,
      cycle: 'peck',
      peck: 2,
      retract: 2,
      feed: 200,
    }
    const m = simulate(tool, [rapid([20.125, 15.125, 5]), hole], 0.25)
    const tan = Math.tan((59 * Math.PI) / 180)
    for (let k = 0; k < m.h.length; k++) {
      const [x, y] = centre(m, k)
      const rho = Math.hypot(x - 20.125, y - 15.125)
      expect(m.h[k]).toBeCloseTo(rho <= 2.5 ? Math.min(0, -6 + rho / tan) : 0, 5) // float32 map
    }
  })

  it('cuts level arcs exactly (both senses, half and full turns) and helices within the chord tolerance', () => {
    const c: [number, number] = [20, 15]
    const arcs: Move[] = [
      rapid([28, 15, 1]),
      line([28, 15, -1]),
      { kind: 'arc', to: [12, 15, -1], center: c, cw: false, feed: 1000 }, // upper half, ccw
      { kind: 'arc', to: [12, 15, -1], center: c, cw: true, feed: 1000 }, // full turn, cw
    ]
    const tool = endMill(3)
    const m = simulate(tool, arcs)
    for (let k = 0; k < m.h.length; k++) {
      const [x, y] = centre(m, k)
      const d = Math.abs(Math.hypot(x - c[0], y - c[1]) - 8)
      if (Math.abs(d - 1.5) < 1e-6) continue
      expect(m.h[k]).toBe(d < 1.5 ? -1 : 0)
    }
    // a quarter arc (ends inside the sector test's edge cases) against its analytic distance
    const q = simulate(tool, [
      rapid([28, 15, 1]),
      line([28, 15, -1]),
      { kind: 'arc', to: [20, 23, -1], center: c, cw: false, feed: 1000 },
    ])
    for (let k = 0; k < q.h.length; k++) {
      const [x, y] = centre(q, k)
      const ang = Math.atan2(y - c[1], x - c[0])
      const d =
        ang >= 0 && ang <= Math.PI / 2
          ? Math.abs(Math.hypot(x - c[0], y - c[1]) - 8)
          : Math.min(Math.hypot(x - 28, y - 15), Math.hypot(x - 20, y - 23))
      if (Math.abs(d - 1.5) < 1e-6) continue
      expect(q.h[k]).toBe(d < 1.5 ? -1 : 0)
    }
    // a helix down 2 mm over one and a half turns, flat and ball: the oracle within one cell
    const helix: Move[] = [
      rapid([24, 15, 1]),
      line([24, 15, 0]),
      { kind: 'arc', to: [16, 15, -0.7], center: c, cw: false, feed: 1000 },
      { kind: 'arc', to: [24, 15, -1.3], center: c, cw: false, feed: 1000 },
      { kind: 'arc', to: [16, 15, -2], center: c, cw: false, feed: 1000 },
    ]
    for (const t of [endMill(3), ball(3)]) {
      const h = simulate(t, helix)
      const o = oracle([{ tool: t, toolpath: toolpath(helix) }], STOCK, 0.25, 0.005)
      const tol = t.type === 'flatEndMill' ? CHORD_TOL : Z_STEP + CHORD_TOL
      expect(offByMoreThanOneCell(h, o, tol + 1e-3)).toBe(0)
    }
  })

  it('keeps one map per direction, sweeps setups of one direction into it and turns the WCS back', () => {
    const tool = endMill(4)
    const face: Move[] = [rapid([6, 6, 2]), line([6, 6, -1]), line([30, 8, -1]), line([30, 24, -3])]
    const plain = simulate(tool, face, 0.5)
    // the same path generated in the face frame, in a setup turned 90° with a moved work zero
    const turned = turnToolpath(toolpath(face), {
      rotation: 90,
      size: [STOCK.length, STOCK.width],
      zero: [3, -2],
    })
    const second: Move[] = [rapid([20, 20, 2]), line([20, 20, -5]), line([10, 25, -5])]
    const setups: SimulateSetup[] = [
      { direction: '-z', rotation: 0, toolpaths: [{ tool, toolpath: toolpath(second) }] },
      { direction: '+z', rotation: 90, zero: [3, -2], toolpaths: [{ tool, toolpath: turned }] },
      { direction: '+z', rotation: 0, toolpaths: [{ tool, toolpath: toolpath(second) }] },
    ]
    const maps = simulateHeightmap({ stock: STOCK, cell: 0.5, setups }).unwrap()
    expect(maps.map((m) => m.direction)).toEqual(['-z', '+z'])
    const top = maps[1]!
    const alone = simulate(tool, second, 0.5)
    expect(maps[0]!.h).toEqual(alone.h) // the bottom map is the bottom setup's only
    for (let k = 0; k < top.h.length; k++)
      expect(top.h[k]).toBeCloseTo(Math.min(plain.h[k]!, alone.h[k]!), 5)
  })

  it('stops at the stock bottom and refuses a cell too small or a map too large', () => {
    const m = simulate(endMill(6), [rapid([20, 15, 1]), line([20, 15, -25])], 0.5)
    expect(Math.min(...m.h)).toBe(-10)
    const tiny = simulateHeightmap({ stock: STOCK, cell: 0.05, setups: [] })
    expect(tiny.unwrapErr().issues[0]?.rule).toBe('tooSmall')
    const huge = simulateHeightmap({
      stock: { length: 2000, width: 1000, thickness: 10 },
      cell: 0.5,
      setups: [{ direction: '+z', rotation: 0, toolpaths: [] }],
    })
    expect(huge.unwrapErr().code).toBe('input.malformed')
    expect(huge.unwrapErr().issues[0]?.rule).toBe('tooLarge')
  })

  it('returns op.aborted between steps', () => {
    const r = simulateHeightmap(
      {
        stock: STOCK,
        setups: [
          {
            direction: '+z',
            rotation: 0,
            toolpaths: [{ tool: endMill(6), toolpath: toolpath([line([1, 1, -1])]) }],
          },
        ],
      },
      signalSteps(AbortSignal.abort()),
    )
    expect(r.unwrapErr().code).toBe('op.aborted')
  })

  // ≈ 1.5 s alone (the oracle's sweeps, ≈ 1.2 s of it): two programs against the oracle
  it('maps the enclosure programs as the oracle does, within one cell', { timeout: 60_000 }, () => {
    for (const url of [ENCLOSURE_TOP_NC, ENCLOSURE_BOTTOM_NC]) {
      const programs = parseGcode(readGcode(url))
      const m = simulateHeightmap({
        stock: ENCLOSURE_STOCK,
        setups: [{ direction: '+z', rotation: 0, toolpaths: programs }],
      }).unwrap()[0]!
      const o = oracle(programs, ENCLOSURE_STOCK, 0.5, 0.1)
      expect(offByMoreThanOneCell(m, o, 0.01)).toBe(0)
      // all but the cells whose centre lies exactly on the tool's edge are equal
      let equal = 0
      for (let k = 0; k < o.length; k++) if (Math.abs(m.h[k]! - o[k]!) <= 0.01) equal++
      expect(o.length - equal).toBeLessThan(5)
    }
  })
})

describe('simulate.heightmap task', () => {
  it('round-trips the maps through the worker boundary (schemas, structured clone)', async () => {
    const tool = endMill(6)
    const moves = [rapid([10, 10, 1]), line([10, 10, -2]), line([30, 20, -2])]
    const setup: SimulateSetup = {
      direction: '+z',
      rotation: 0,
      toolpaths: [{ tool, toolpath: toolpath(moves) }],
    }
    const input = { stock: STOCK, setups: [setup] }
    const ctl = { signal: new AbortController().signal, progress: () => undefined }
    const maps = expectOk(await inProcessWorkers.run(simulateHeightmapTask, input, ctl))
    expect(maps).toHaveLength(1)
    expect(maps[0]!.h).toEqual(simulateHeightmap(input).unwrap()[0]!.h)
    const bad = await inProcessWorkers.run(simulateHeightmapTask, { ...input, cell: 0.01 }, ctl)
    expectErrCode(bad, 'input.malformed')
  })
})
