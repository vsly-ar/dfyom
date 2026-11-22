/**
 * The GRBL post fed with the region generators' arcs (v0.3 T3, docs/modes/plan-v0.3.md#arcs-in-g2g3-out):
 * golden programs of a shape pocket and profile, and properties of every shape program in mm and
 * inch – re-parsed by the virtual machine's parser, every G2/G3 sweeps ≤ 180°, its end lies on its
 * circle within GRBL's `$12` arc tolerance (0.002 mm; inch: one written step more), and the
 * program as GRBL executes it (arcs as `$12` chords) gouges nothing and leaves nothing the
 * heightmap oracle says the tool reaches. Goldens update with `-u` (docs/conventions/testing.md).
 */
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import type { Loop, Region } from '../../geometry/2d/model'
import { dumbbell } from '../../geometry/2d/testing/fixtures'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import type { Machine } from '../../library/machine'
import { initialParserState, parseBlock, type Move as GMove } from '../../run/grbl/emulator/gcode'
import { streamProgram } from '../../run/grbl/sender.fixture'
import type { Move, Toolpath, ToolpathTool, Vec3 } from '../../toolpath/model'
import { generateRegionPocket } from '../../toolpath/region-pocket'
import { generateRegionProfile, type RegionProfileOperation } from '../../toolpath/region-profile'
import { cutting, endMill, HEIGHTS, RATES } from '../../toolpath/testing/fixtures'
import { placeLoops, regionCoverage } from '../../toolpath/testing/region-coverage'
import {
  bracket,
  hook,
  randomRegion,
  slot,
  svgBracket,
  triangle,
  twoIslands,
} from '../../toolpath/testing/region-fixtures'
import { exportGrbl, type GrblExport } from '../export'
import { exportInput, operation, OPTS, testMachine } from '../post.fixture'

const port = nodeRegion2d()
const D6 = endMill(6)
/** GRBL's default `$12` (mm). */
const ARC_TOLERANCE = 0.002

interface Case {
  readonly name: string
  readonly tp: Toolpath
  /** The cut region and its tool-centre region for the oracle. */
  readonly region: Region
  readonly c0: Region
  readonly floor: number
  readonly size: { length: number; width: number }
}

function pocketCase(name: string, loops: Loop[], depth: number, helix = true): Case {
  const placed = placeLoops(loops)
  const region = port.normalise(placed.loops).unwrap()
  const tp = expectOk(
    generateRegionPocket(
      {
        planOperationId: name,
        tool: D6,
        cutting: cutting(D6, { stepdown: 2 }),
        heights: HEIGHTS,
        stock: { ...placed.size, thickness: 20 },
        operation: { region, onZ: 0, depth },
        strategy: {
          entry: helix ? 'helix' : 'ramp',
          helixDiameter: 4.8,
          rampAngle: 3,
          finishAllowance: 0.2,
          finishStepdown: depth,
          direction: 'climb',
        },
        maxFeedRate: RATES,
      },
      port,
    ),
  )
  return { name, tp, region, c0: port.offset(region, 3).unwrap(), floor: -depth, size: placed.size }
}

/** A profile case; the oracle's region is the slot (the band the profile cuts). */
function profileCase(
  name: string,
  chain: Loop,
  op: Partial<Omit<RegionProfileOperation, 'chain'>>,
): Case {
  const placed = placeLoops([chain], 15)
  const operation: RegionProfileOperation = {
    chain: placed.loops[0]!,
    closed: true,
    side: 'outside',
    slotWidth: 6,
    onZ: 0,
    depth: 6,
    through: true,
    tabs: { positions: [], width: 6, thickness: 2 },
    ...op,
  }
  const tp = expectOk(
    generateRegionProfile(
      {
        planOperationId: name,
        tool: D6,
        cutting: cutting(D6, { stepdown: 2 }),
        heights: HEIGHTS,
        stock: { ...placed.size, thickness: 6 },
        operation,
        strategy: {
          entry: 'ramp',
          rampAngle: 3,
          breakthrough: 0.5,
          finishAllowance: 0.2,
          direction: 'climb',
          leadRadius: 3,
        },
        maxFeedRate: RATES,
      },
      port,
    ),
  )
  const sw = operation.slotWidth
  const c = operation.chain
  let slotRegion: Region
  if (!operation.closed) slotRegion = port.offsetPath(c, sw / 2).unwrap()
  else {
    const L = port.normalise([c]).unwrap()
    slotRegion =
      operation.side === 'outside'
        ? port.difference(port.offset(L, -sw).unwrap(), L).unwrap()
        : operation.side === 'inside'
          ? port.difference(L, port.offset(L, sw).unwrap()).unwrap()
          : port
              .difference(port.offset(L, -sw / 2).unwrap(), port.offset(L, sw / 2).unwrap())
              .unwrap()
  }
  const floor = operation.through ? -operation.depth - 0.5 : -operation.depth
  return {
    name,
    tp,
    region: slotRegion,
    c0: port.offset(slotRegion, 3).unwrap(),
    floor,
    size: placed.size,
  }
}

/** The shape programs: S4's corpus, T2's profiles (tiny corner arcs, near-180° splits, helices). */
function cases(): Case[] {
  return [
    pocketCase('pocket-two-islands', twoIslands(), 4),
    pocketCase('pocket-neck', [dumbbell(5)], 3),
    pocketCase('pocket-triangle', [triangle(30, 40)], 2),
    pocketCase('pocket-slot', slot(), 3, false),
    ...[3, 7, 8, 9].map((seed) => {
      const r = randomRegion(seed)
      return pocketCase(`pocket-random-${seed}`, r.loops, 2)
    }),
    profileCase('profile-bracket-outside', svgBracket(), {}),
    profileCase('profile-bracket-inside', svgBracket(), { side: 'inside' }),
    profileCase('profile-on-closed', bracket(), { side: 'on', slotWidth: 8 }),
    profileCase('profile-on-open', hook(), {
      side: 'on',
      closed: false,
      depth: 3,
      through: false,
    }),
  ]
}

function exported(tp: Toolpath, tool: ToolpathTool, machine: Machine): GrblExport {
  return expectOk(exportGrbl(exportInput([operation(tp, tool)], machine), OPTS))
}

interface ArcLine {
  readonly line: string
  readonly cw: boolean
  /** Sweep (rad, > 0). */
  readonly sweep: number
  /** |end − centre| − |start − centre| (mm). */
  readonly radiusError: number
  /** |start − centre| (mm). */
  readonly radius: number
}

/** Re-parses the program with the virtual machine's parser: its arcs and every executed move. */
function reparse(lines: readonly string[]): { arcs: ArcLine[]; moves: GMove[] } {
  let state = initialParserState([0, 0, 0], [0, 0, 0])
  const arcs: ArcLine[] = []
  const moves: GMove[] = []
  for (const line of lines) {
    const code = line
      .replace(/\([^)]*\)/g, '')
      .replace(/\s/g, '')
      .toUpperCase()
    if (code === '') continue
    const r = parseBlock(code, state, { arcTolerance: ARC_TOLERANCE })
    if (r.isErr()) throw new Error(`error:${r.unwrapErr()} in "${line}"`)
    const p = r.unwrap()
    const ms = p.actions.filter((a): a is GMove => a.kind === 'move')
    moves.push(...ms)
    if ((p.state.motion === 2 || p.state.motion === 3) && ms.length > 0) {
      const perMm = p.state.metric ? 1 : 25.4
      const i = Number(/I(-?[\d.]+)/.exec(code)?.[1] ?? 0) * perMm
      const j = Number(/J(-?[\d.]+)/.exec(code)?.[1] ?? 0) * perMm
      const s = state.position
      const e = ms.at(-1)!.target
      const c = [s[0] + i, s[1] + j]
      const cw = p.state.motion === 2
      const a0 = Math.atan2(s[1] - c[1]!, s[0] - c[0]!)
      const a1 = Math.atan2(e[1] - c[1]!, e[0] - c[0]!)
      let sweep = cw ? a0 - a1 : a1 - a0
      while (sweep <= 1e-9) sweep += 2 * Math.PI
      arcs.push({
        line,
        cw,
        sweep,
        radiusError: Math.abs(Math.hypot(e[0] - c[0]!, e[1] - c[1]!) - Math.hypot(i, j)),
        radius: Math.hypot(i, j),
      })
    }
    state = p.state
  }
  return { arcs, moves }
}

/** The executed moves (mm) as a toolpath of lines for the heightmap. */
function executed(moves: readonly GMove[], like: Toolpath): Toolpath {
  const out: Move[] = moves.map((m) =>
    m.rapid
      ? { kind: 'rapid', to: m.target as Vec3 }
      : { kind: 'line', to: m.target as Vec3, feed: m.feed },
  )
  return { ...like, passes: [{ kind: 'rough', moves: out }] }
}

describe('golden files of shape programs (also streamed through the virtual machine)', () => {
  const all = cases()
  const golden: [string, string, Machine][] = [
    ['shape-pocket-two-islands', 'pocket-two-islands', testMachine()],
    ['shape-profile-bracket-outside', 'profile-bracket-outside', testMachine()],
    ['shape-profile-on-open-inch', 'profile-on-open', testMachine({ programUnits: 'in' })],
  ]
  for (const [file, name, machine] of golden)
    it(file, async () => {
      const e = exported(all.find((c) => c.name === name)!.tp, D6, machine)
      expect(e.warnings).toEqual([])
      await expect(e.text).toMatchFileSnapshot(`__golden__/${file}.nc`)
      await streamProgram(e.lines, machine)
    })
})

describe('properties of shape programs (mm and inch)', () => {
  const all = cases()
  for (const units of ['mm', 'in'] as const)
    it(
      `${units}: G2/G3 ≤ 180°, ends on their circle within $12, no gouge or leftover as executed`,
      { timeout: 120_000 }, // ≈ 6 s alone (heightmaps at 0.25 mm)
      () => {
        const machine = testMachine({ programUnits: units })
        // one written step of the text (0.001 mm, 0.0001″ = 0.00254 mm)
        const step = units === 'in' ? 0.00254 : 0.001
        const radiusTolerance = ARC_TOLERANCE + (units === 'in' ? step : 0)
        let arcs = 0
        for (const c of all) {
          const e = exported(c.tp, D6, machine)
          const parsed = reparse(e.lines)
          arcs += parsed.arcs.length
          for (const a of parsed.arcs) {
            // toolpath arcs sweep ≤ 180°; each written end moves by up to √½ step
            expect(a.sweep, `${c.name}: ${a.line}`).toBeLessThanOrEqual(
              Math.PI + (1.5 * step) / a.radius,
            )
            expect(a.radiusError, `${c.name}: ${a.line}`).toBeLessThanOrEqual(radiusTolerance)
          }
          // the program as GRBL executes it against the oracle (profiles: the tabs stay, so
          // only the gouge is checked there)
          const cov = regionCoverage(
            c.region,
            c.c0,
            executed(parsed.moves, c.tp),
            D6,
            c.size,
            c.floor + (units === 'in' ? step / 2 : 0), // inch: the floor as written
            0.25,
            0.01 + ARC_TOLERANCE + (units === 'in' ? 0.0013 : 0.0005),
          )
          expect(cov.gouge, c.name).toBe(0)
          // the floor as written: inch rounds Z by up to half a step (0.00127 mm)
          const lowest = Math.min(...parsed.moves.filter((m) => !m.rapid).map((m) => m.target[2]))
          expect(lowest, c.name).toBeGreaterThanOrEqual(c.floor - step / 2 - 1e-9)
          if (c.name.startsWith('pocket')) {
            if (units === 'mm') expect(cov.belowFloor, c.name).toBe(0)
            expect(cov.leftover, c.name).toBeLessThan(0.5)
          }
        }
        // the programs are arc-heavy: helices, corner arcs, lead arcs, tab lifts along arcs
        expect(arcs).toBeGreaterThan(200)
      },
    )
})
