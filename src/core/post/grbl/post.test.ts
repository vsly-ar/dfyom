/**
 * GRBL post: golden files per operation kind, dialect rules, and properties checked by re-parsing
 * the text with the virtual machine's parser. Spec: docs/architecture/grbl.md#post-processor-task-211
 */
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../../shared/testing/result'
import {
  initialParserState,
  parseBlock,
  type Move as GMove,
  type ParserState,
} from '../../run/grbl/emulator/gcode'
import { GrblEmulator } from '../../run/grbl/emulator/emulator'
import { machineSettings } from '../../run/grbl/emulator/settings'
import { connected, drive, until } from '../../run/grbl/sender.fixture'
import { rpm } from '../../library/library.fixture'
import type { Machine } from '../../library/machine'
import { generateChamfer } from '../../toolpath/chamfer'
import { generateDrilling } from '../../toolpath/drilling'
import { generateFacing } from '../../toolpath/facing'
import { generateLine } from '../../toolpath/line'
import { arc, line } from '../../geometry/2d/model'
import type { LinePathLevels } from '../../geometry/model'
import { importSvg } from '../../import/svg'
import { definitionOf } from '../../design/shape'
import { svgShapeItems } from '../../design/shape-import'
import { pathLevelProfile } from '../../design/shape-items'
import { resolveEngraving } from '../../design/engraving/resolve'
import { shapeFromDTO } from '../../design/shape'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { Quantity } from '../../quantity/quantity'
import type { Move, Toolpath, Vec3 } from '../../toolpath/model'
import { generatePocket } from '../../toolpath/pocket'
import { generateProfile } from '../../toolpath/profile'
import { arcSweep, toolpathStats } from '../../toolpath/stats'
import {
  chamferInput,
  chamferMill,
  drill,
  drillingInput,
  endMill,
  facingInput,
  lineInput,
  pocketInput,
  profileInput,
  RATES,
} from '../../toolpath/testing/fixtures'
import { exportGrbl, type ExportOperation, type GrblExport } from '../export'
import { exportInput, operation, OPTS, testMachine, testPartExport } from '../post.fixture'
import type { Block, MachiningProgram } from '../program'
import { formatNumber } from './format'
import { postGrbl, postGrblLines, type PostOptions } from './post'

// ── Inputs ──────────────────────────────────────────────────────────────────────────────

const facingOp = () => {
  const tool = endMill(10)
  return operation(
    generateFacing(facingInput({ length: 30, width: 20, thickness: 10 }, tool)).unwrap(),
    tool,
  )
}

const pocketOp = () => {
  const tool = endMill(6)
  const op = {
    kind: 'pocket',
    id: 'pocket1',
    onZ: 0,
    shape: { center: [20, 15], contour: { kind: 'circle', radius: 8 } },
    depth: 3,
    floorRadius: 0,
  } as const
  return operation(
    generatePocket(pocketInput({ length: 40, width: 30, thickness: 10 }, op, tool)).unwrap(),
    tool,
  )
}

const drillOps = () => {
  const tool = drill(6)
  const stock = { length: 40, width: 30, thickness: 20 }
  const hole = (id: string, x: number) =>
    ({
      kind: 'drilling',
      id,
      onZ: 0,
      center: [x, 15],
      diameter: 6,
      bottom: { kind: 'drillPoint', depth: 12, pointAngle: 118 },
    }) as const
  return [
    operation(
      generateDrilling(
        drillingInput(stock, hole('drill1', 10), tool, {
          cycle: 'peck',
          peckDepth: 5,
          breakthrough: 0.5,
        }),
      ).unwrap(),
      tool,
    ),
    operation(
      generateDrilling(
        drillingInput(stock, hole('drill2', 30), tool, {
          cycle: 'chipBreak',
          peckDepth: 4,
          chipBreakBack: 0.5,
          breakthrough: 0.5,
        }),
      ).unwrap(),
      tool,
    ),
  ]
}

const profileOp = () => {
  const tool = endMill(6)
  const op = {
    kind: 'profile',
    id: 'profile1',
    shape: {
      center: [30, 20],
      contour: { kind: 'rectangle', length: 40, width: 24, cornerRadius: 4 },
    },
    side: 'outside',
    slotWidth: 6,
    tabs: { count: 2, width: 4, thickness: 2 },
  } as const
  return operation(
    generateProfile(profileInput({ length: 60, width: 40, thickness: 6 }, op, tool)).unwrap(),
    tool,
  )
}

/**
 * Chamfers (v0.4 T1) on two holes of Ø `d` at the face: one contoured with a mill of DC = d, one
 * plunged with a mill twice as wide; in mm or inch sizes (1 mm or 1/32" wider than the hole).
 */
/**
 * A variable-depth Line from an SVG with levels (engraved-patterns.md E2): the E0 sample (stroke
 * colours, a data-level ramp, a coloured circle) imported, its levels taken as the shapes store
 * them (`svgShapeItems`, `pathLevelProfile`), cut 0.2–1.5 mm with a 60° V-bit; the three coloured
 * pieces chained into one line with blended steps.
 */
const lineLevelsOps = (): ExportOperation[] => {
  const nodeFs = (
    globalThis as unknown as {
      process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, e: 'utf8'): string } }
    }
  ).process.getBuiltinModule('node:fs')
  const text = nodeFs.readFileSync(
    new URL('../../design/__fixtures__/levels-sample.svg', import.meta.url),
    'utf8',
  )
  const shapes = expectOk(importSvg(text)).shapes
  const paths = shapes.map((s) => {
    const it = s.items[0]!
    return {
      center: [0, 0] as [number, number],
      contour:
        it.kind === 'path'
          ? { kind: 'path' as const, path: it.path }
          : {
              kind: 'region' as const,
              region: { pieces: [{ outer: it.loop, holes: [] }] },
            },
    }
  })
  const levels = shapes.map((s): LinePathLevels | null => {
    const item = definitionOf(expectOk(svgShapeItems(s, 'mm')))[0]!
    if (item.kind !== 'path' || item.levels === undefined) return null
    if (item.closed)
      return { kind: 'loops', level: typeof item.levels === 'number' ? item.levels : 1 }
    const p = pathLevelProfile(item)!
    return { kind: 'path', u: p.u, level: p.level }
  })
  const tool = chamferMill(6, 60)
  const op = {
    kind: 'line',
    id: 'line1',
    onZ: 0,
    paths,
    depth: { min: 0.2, max: 1.5 },
    levels,
    cutter: { kind: 'vBit', diameter: 6, angle: 60, tipDiameter: 0 },
  } as const
  const stock = { length: 100, width: 60, thickness: 10 }
  return [
    operation(
      generateLine(lineInput(stock, op, tool, {}, { stepdown: 0.8, feedRate: 1200 })).unwrap(),
      tool,
    ),
  ]
}

/**
 * An engraved pattern (engraved-patterns.md E3): the Rosette preset fitted to a 100 × 100 coaster
 * face less a 10 mm margin (Ø 80), its 14 rings cut 0.2–1 mm by their levels with a 60° V-bit;
 * the lines as the feature's owned shape resolves them.
 */
const engravingRosetteOps = (): ExportOperation[] => {
  const r = expectOk(
    resolveEngraving(
      {
        motif: { preset: 'rosette' },
        boundary: { min: [0, 0], max: [100, 100] },
        margin: 10,
        rotation: 0,
        fit: 'boundary',
      },
      new Map(),
      undefined,
    ),
  )
  const tool = chamferMill(6, 60)
  const op = {
    kind: 'line',
    id: 'engraving1_line',
    onZ: 0,
    paths: r.lines.map((l) => l.shape),
    depth: { min: 0.2, max: 1 },
    levels: r.lines.map((l) => l.levels),
    cutter: { kind: 'vBit', diameter: 6, angle: 60, tipDiameter: 0 },
  } as const
  const stock = { length: 100, width: 100, thickness: 6 }
  return [
    operation(
      generateLine(lineInput(stock, op, tool, {}, { stepdown: 0.5, feedRate: 1500 })).unwrap(),
      tool,
    ),
  ]
}

/** An engraved pattern's resolved lines as its owned Line, cut with a 60° V-bit (E3, E4). */
const engravingOps = (
  rec: Parameters<typeof resolveEngraving>[0],
  shapes: Parameters<typeof resolveEngraving>[1],
  stock: { length: number; width: number; thickness: number },
  depth: { min: number; max: number },
): ExportOperation[] => {
  const r = expectOk(resolveEngraving(rec, shapes, nodeRegion2d()))
  const tool = chamferMill(6, 60)
  const op = {
    kind: 'line',
    id: 'engraving1_line',
    onZ: 0,
    paths: r.lines.map((l) => l.shape),
    depth,
    levels: r.lines.map((l) => l.levels),
    cutter: { kind: 'vBit', diameter: 6, angle: 60, tipDiameter: 0 },
  } as const
  return [
    operation(
      generateLine(lineInput(stock, op, tool, {}, { stepdown: 0.5, feedRate: 1500 })).unwrap(),
      tool,
    ),
  ]
}

/**
 * Tiles (engraved-patterns.md E4): the Waves preset on its square lattice over a 60 × 40 face less
 * 3 mm, clipped; the tiles' waves chained into one line per row, 0.6 mm deep.
 */
const engravingWavesOps = (): ExportOperation[] =>
  engravingOps(
    {
      motif: { preset: 'waves' },
      boundary: { min: [0, 0], max: [60, 40] },
      margin: 3,
      rotation: 0,
      fit: 'clip',
      layout: { lattice: 'square', angle: 0, spacing: { gap: 0 } },
    },
    new Map(),
    { length: 60, width: 40, thickness: 6 },
    { min: 0.2, max: 0.6 },
  )

/**
 * A polar layout (E4): Scales 8 mm wide on rings round a Ø 60 coaster less 3 mm, each turned
 * radially to face out, clipped at the circle; 0.5 mm deep.
 */
const engravingPolarOps = (): ExportOperation[] => {
  const mm = (v: string) =>
    Quantity.parse(v, { kind: 'length', defaultUnit: 'mm' }).unwrap().toDTO()
  const coaster = expectOk(
    shapeFromDTO({
      id: 'shape1',
      name: 'Coaster',
      items: [{ kind: 'circle', op: 'add', center: [mm('0'), mm('0')], diameter: mm('60') }],
    } as never),
  )
  return engravingOps(
    {
      motif: { preset: 'scales' },
      boundary: { min: [0, 0], max: [70, 70] },
      area: { shapeId: 'shape1', center: [35, 35], rotation: 0 },
      margin: 3,
      rotation: 0,
      size: 8,
      fit: 'clip',
      layout: { lattice: 'polar', angle: 0, spacing: { gap: 2 } },
      radial: true,
    },
    new Map([['shape1', coaster]]),
    { length: 70, width: 70, thickness: 6 },
    { min: 0.2, max: 0.5 },
  )
}

/** Lines (engraved-patterns.md E1): a 60° V-bit fluting an open curve 0.2 → 1.5 mm. */
const lineRampOps = (): ExportOperation[] => {
  const tool = chamferMill(6, 60)
  const op = {
    kind: 'line',
    id: 'line1',
    onZ: 0,
    paths: [
      {
        center: [30, 20],
        contour: {
          kind: 'path',
          path: { elements: [line([-20, -5], [0, -5]), arc([0, -5], [10, 5], [0, 5], true)] },
        },
      },
    ],
    depth: { start: 0.2, end: 1.5 },
    cutter: { kind: 'vBit', diameter: 6, angle: 60, tipDiameter: 0 },
  } as const
  const stock = { length: 60, width: 40, thickness: 10 }
  return [operation(generateLine(lineInput(stock, op, tool)).unwrap(), tool)]
}

/** A constant 0.8 mm V-groove round a closed rounded square (E1). */
const lineClosedOps = (): ExportOperation[] => {
  const tool = chamferMill(6, 90)
  const r = 3
  const s = 10
  const op = {
    kind: 'line',
    id: 'line1',
    onZ: 0,
    paths: [
      {
        center: [20, 20],
        contour: {
          kind: 'region',
          region: {
            pieces: [
              {
                outer: {
                  elements: [
                    line([-s + r, -s], [s - r, -s]),
                    arc([s - r, -s], [s, -s + r], [s - r, -s + r], true),
                    line([s, -s + r], [s, s - r]),
                    arc([s, s - r], [s - r, s], [s - r, s - r], true),
                    line([s - r, s], [-s + r, s]),
                    arc([-s + r, s], [-s, s - r], [-s + r, s - r], true),
                    line([-s, s - r], [-s, -s + r]),
                    arc([-s, -s + r], [-s + r, -s], [-s + r, -s + r], true),
                  ],
                },
                holes: [],
              },
            ],
          },
        },
      },
    ],
    depth: { start: 0.8, end: 0.8 },
    cutter: { kind: 'vBit', diameter: 6, angle: 90, tipDiameter: 0 },
  } as const
  const stock = { length: 40, width: 40, thickness: 10 }
  return [operation(generateLine(lineInput(stock, op, tool)).unwrap(), tool)]
}

const chamferOps = (inch = false): ExportOperation[] => {
  const d = inch ? 25.4 / 4 : 6
  const stock = { length: 40, width: 30, thickness: 10 }
  const op = (id: string, x: number) =>
    ({
      kind: 'chamfer',
      id,
      onZ: 0,
      center: [x, 15],
      edgeOf: 'drill1',
      edgeDiameter: d,
      diameter: d + (inch ? 25.4 / 32 : 1),
      angle: 90,
    }) as const
  const small = chamferMill(d)
  const large = chamferMill(2 * d)
  return [
    operation(generateChamfer(chamferInput(stock, op('chamfer1', 10), small)).unwrap(), small),
    operation(
      generateChamfer(chamferInput(stock, op('chamfer2', 30), large, { entry: 'plunge' })).unwrap(),
      large,
    ),
  ]
}

/**
 * A stepped M3 countersink (v0.4 F7): the Ø3.4 hole bored helically by a 2.5 mm end mill, then
 * its terraces by the same end mill (one tool, no tool change).
 */
const steppedCountersinkOps = (): ExportOperation[] => {
  const tool = endMill(2.5)
  const stock = { length: 30, width: 30, thickness: 6 }
  const hole = {
    kind: 'drilling',
    id: 'hole1_drill',
    onZ: 0,
    center: [15, 15],
    diameter: 3.4,
    bottom: { kind: 'through' },
  } as const
  const sink = {
    kind: 'chamfer',
    id: 'hole1_countersink',
    onZ: 0,
    center: [15, 15],
    edgeOf: 'hole1_drill',
    edgeDiameter: 3.4,
    diameter: 7.12,
    angle: 90,
    stepdown: 1,
  } as const
  return [
    operation(
      generateDrilling(
        drillingInput(stock, hole, tool, {
          cycle: 'helix',
          helixPitch: 0.6,
          rampAngle: 3,
          direction: 'climb',
          breakthrough: 0.5,
        }),
      ).unwrap(),
      tool,
    ),
    operation(
      generateChamfer(chamferInput(stock, sink, tool, { entry: 'stepped' })).unwrap(),
      tool,
    ),
  ]
}

/**
 * Facing, the two holes, the profile: three tools, the drill at another speed. Every tool run
 * touches off on the top face (DF69: the program moves to each spot before the pause).
 */
const multiToolOps = (): ExportOperation[] => {
  const top = (x: number, y: number) =>
    ({ label: 'the top face', level: 0, at: [x, y], top: true }) as const
  const [facing, drill1, drill2] = [facingOp(), ...drillOps()]
  return [
    { ...facing!, zRef: top(15, 10) },
    { ...drill1!, zRef: top(20, 15) },
    drill2!,
    { ...profileOp(), zRef: top(30, 20) },
  ]
}

/**
 * As `multiToolOps` with the later tools touching off on the 0.5 mm faced floor (DF69): their Z
 * shifted by +0.5, the instruction lines before each pause.
 */
const facedMultiToolOps = (): ExportOperation[] => {
  const floor = (x: number, y: number) =>
    ({ label: 'Facing 1 floor', level: -0.5, at: [x, y], top: false }) as const
  const ops = multiToolOps()
  return [
    ops[0]!,
    { ...ops[1]!, zRef: floor(20, 15) },
    ops[2]!,
    { ...ops[3]!, zRef: floor(30, 20) },
  ]
}

const program = (blocks: Block[], over: Partial<MachiningProgram> = {}): MachiningProgram => ({
  name: 'P',
  setupName: 'S',
  units: 'mm',
  spindleControl: 'gcode',
  clearanceZ: 10,
  blocks,
  ...over,
})
const tool = (number = 1): Block => ({
  kind: 'toolChange',
  number,
  tool: { name: `T${number}`, diameter: 6, type: 'flatEndMill' },
})
const spin = (rpm: number | 'off' = 10000): Block => ({ kind: 'spindle', rpm })
const rapid = (x: number, y: number, z: number): Block => ({ kind: 'rapid', to: [x, y, z] })
const feed = (x: number, y: number, z: number, f = 500): Block => ({
  kind: 'feed',
  to: [x, y, z],
  feed: f,
})

const body = (lines: readonly string[]) => lines.slice(lines.indexOf('G0 Z10') + 1)

function exportOf(
  ops: ExportOperation[],
  machine = testMachine(),
  opts: PostOptions = OPTS,
): GrblExport {
  return expectOk(exportGrbl(exportInput(ops, machine), opts))
}

// ── Re-parsing with the virtual machine's parser ─────────────────────────────────────────

interface Parsed {
  readonly line: string
  readonly motion: ParserState['motion']
  readonly moves: readonly GMove[]
  readonly start: Vec3
}

/** Every line through parseBlock (GRBL's stripping: no spaces or comments, upper case). */
function reparse(lines: readonly string[]): Parsed[] {
  let state = initialParserState([0, 0, 0], [0, 0, 0])
  const out: Parsed[] = []
  for (const line of lines) {
    const code = line
      .replace(/\([^)]*\)/g, '')
      .replace(/;.*$/, '')
      .replace(/\s/g, '')
      .toUpperCase()
    if (code === '') continue
    const r = parseBlock(code, state, { arcTolerance: 0.002 })
    if (r.isErr()) throw new Error(`error:${r.unwrapErr()} in "${line}"`)
    const p = r.unwrap()
    const moves = p.actions.filter((a): a is GMove => a.kind === 'move')
    out.push({ line, motion: p.state.motion, moves, start: state.position })
    state = p.state
  }
  return out
}

const near = (a: readonly number[], b: readonly number[], tol: number) =>
  a.every((v, k) => Math.abs(v - b[k]!) <= tol)

/**
 * The modal state after suppression is right: every motion the text makes (re-parsed) is the
 * intended block, in order, with its rapid/feed mode, feed rate, arc circle and sweep.
 */
function expectIntendedMotion(p: MachiningProgram, lines: readonly string[]): void {
  const perMm = p.units === 'in' ? 1 / 25.4 : 1
  const d = p.units === 'in' ? 4 : 3
  const tol = (0.5 * 10 ** -d) / perMm + 1e-9
  const key = (v: Vec3) => v.map((c) => formatNumber(c * perMm, d)).join(' ')

  // Intended: motion blocks with their float start, without those the text cannot show. DF69:
  // each tool run's Z shifted by −level of its reference, and the rapid to the touch-off spot
  // (then to the new run's clearance) before a pause.
  const want: { b: Extract<Block, { to: Vec3 }>; from: Vec3 | undefined }[] = []
  let last: string | undefined
  let from: Vec3 | undefined
  let level = p.blocks.find((b) => b.kind === 'toolChange')?.zRef?.level ?? 0
  let first = true
  for (const raw of p.blocks) {
    if (raw.kind === 'toolChange') {
      last = undefined
      const pauses = !first || (raw.zRef !== undefined && !raw.zRef.top)
      first = false
      if (pauses && raw.zRef !== undefined && from !== undefined) {
        const to: Vec3 = [raw.zRef.at[0], raw.zRef.at[1], from[2]]
        want.push({ b: { kind: 'rapid', to }, from })
        from = to
      }
      if (pauses && (raw.zRef?.level ?? 0) !== level) {
        level = raw.zRef?.level ?? 0
        if (from !== undefined) {
          const to: Vec3 = [from[0], from[1], p.clearanceZ - level]
          want.push({ b: { kind: 'rapid', to }, from })
          from = to
        }
      }
    }
    if (!('to' in raw)) continue
    const b = { ...raw, to: [raw.to[0], raw.to[1], raw.to[2] - level] as Vec3 }
    // a full circle (end = start in X and Y) is written although its end is unchanged
    const full =
      b.kind === 'arc' && from !== undefined && b.to[0] === from[0] && b.to[1] === from[1]
    if (key(b.to) !== last || full) want.push({ b, from })
    last = key(b.to)
    from = b.to
  }
  // Text: lines that move (forced clearance lines usually do not).
  const got = reparse(lines).filter(
    (g) =>
      g.moves.length > 1 || // an arc's chords (full circles end where they start)
      (g.moves.length > 0 && !near(g.moves.at(-1)!.target, g.start, 1e-9)),
  )
  // The header's G0 Z, and the footer's retract when the program did not end at clearance.
  expect(got[0]!.line).toMatch(/^G0 Z/)
  const footer = got.length === want.length + 2
  if (footer) expect(got.at(-1)!.line).toMatch(/^(G0 )?Z[-\d.]+$/)
  const body = got.slice(1, footer ? -1 : undefined)
  expect(body.map((g) => g.line)).toHaveLength(want.length)
  body.forEach((g, k) => {
    const { b, from: start } = want[k]!
    const end = g.moves.at(-1)!
    expect(near(end.target, b.to, tol), `${g.line} → ${b.to}`).toBe(true)
    expect(end.rapid, g.line).toBe(b.kind === 'rapid')
    if (b.kind !== 'rapid')
      expect(Math.abs(end.feed - b.feed), g.line).toBeLessThanOrEqual(0.05 / perMm + 1e-9)
    if (b.kind !== 'arc' || start === undefined) return
    if (g.motion !== 2 && g.motion !== 3) return // a tiny arc written as G1
    expect(g.motion === 2, g.line).toBe(b.cw)
    const c: Vec3 = [start[0] + b.i, start[1] + b.j, 0]
    const r = Math.hypot(b.i, b.j)
    let swept = 0
    let prev = g.start
    for (const m of g.moves) {
      expect(Math.abs(Math.hypot(m.target[0] - c[0], m.target[1] - c[1]) - r), g.line).toBeLessThan(
        0.006,
      )
      const a0 = Math.atan2(prev[1] - c[1], prev[0] - c[0])
      const a1 = Math.atan2(m.target[1] - c[1], m.target[0] - c[0])
      swept += Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0))
      prev = m.target
    }
    const full = b.to[0] === start[0] && b.to[1] === start[1]
    const sweep = full ? (b.cw ? -2 : 2) * Math.PI : arcSweep(start, { ...b, center: [c[0], c[1]] })
    expect(Math.abs(swept - sweep) * r, g.line).toBeLessThan(0.006)
  })
}

const WORDS: Readonly<Record<string, RegExp>> = {
  G: /^(0|1|2|3|4|17|20|21|54|90|94)$/,
  M: /^(0|3|5|30)$/,
  F: /^\d+(\.[1-9])?$/,
  S: /^[1-9]\d*$/,
  P: /^\d+(\.\d?[1-9])?$/,
}

/** Dialect properties of every line. */
function expectDialect(lines: readonly string[], units: 'mm' | 'in'): void {
  const coord = units === 'in' ? /^-?\d+(\.\d{0,3}[1-9])?$/ : /^-?\d+(\.\d{0,2}[1-9])?$/
  // An arc (also modal G2/G3) needs an axis word in the plane (GRBL error:32).
  for (const p of reparse(lines))
    if ((p.motion === 2 || p.motion === 3) && /[XYZ]/.test(p.line))
      expect(p.line, 'arc without an in-plane axis word').toMatch(/[XY]/)
  for (const full of lines) {
    expect(full.length, full).toBeLessThanOrEqual(70)
    expect(full, 'printable ASCII').toMatch(/^[\x20-\x7e]+$/)
    // the only `;` comment: a pause's message on its M0 line (DF63)
    const pause = /^M0 ;([^()?!~;]+)$/.exec(full)
    if (full.includes(';')) expect(pause, full).not.toBeNull()
    const l = pause ? 'M0' : full
    expect(l).not.toMatch(/G8\d|G28|G30|G53|G92|G43|M6|M7|M8|M9|^N|%|;|R/)
    if (l.startsWith('(')) {
      expect(l).toMatch(/^\([^()?!~;]*\)$/)
      continue
    }
    for (const w of l.split(' ')) {
      const letter = w[0]!
      const value = w.slice(1)
      expect(value, w).not.toBe('-0')
      if ('XYZIJ'.includes(letter)) expect(value, w).toMatch(coord)
      else expect(value, w).toMatch(WORDS[letter] ?? /^$/)
    }
    // fixed word order
    const order = l.split(' ').map((w) => 'GMXYZIJFSP'.indexOf(w[0]!))
    expect(order, l).toEqual([...order].sort((a, b) => a - b))
  }
}

/** Streams `lines` through the virtual machine (no homing, so no soft limits). */
/** Streams `lines` with GrblSender, continuing every tool change and `M0` pause at once. */
async function streamed(lines: readonly string[], machine: Machine): Promise<void> {
  const emu = expectOk(GrblEmulator.create({ settings: machineSettings(machine), homing: false }))
  const r = await connected(emu)
  let finished = false
  const run = r.sender.run({ lines, sections: [] }).then((res) => {
    finished = true
    return res
  })
  const waiting = () => r.sender.phase === 'toolChange' || r.sender.phase === 'programPause'
  for (;;) {
    expect(await until(r.clock, () => finished || waiting(), 3_600_000)).toBe(true)
    if (finished) break
    expectOk(r.sender.continueProgram())
  }
  expectOk(await drive(r.clock, run))
  expect(r.io.received.filter((l) => l.startsWith('error'))).toEqual([])
  expect(emu.trace.violations).toEqual([])
}

// ── Golden files ────────────────────────────────────────────────────────────────────────

describe('golden files (also streamed through the virtual machine)', () => {
  const cases: [string, () => ExportOperation[], Machine?][] = [
    ['facing', () => [facingOp()]],
    ['pocket-circle-helix', () => [pocketOp()]],
    ['drilling-peck-chipBreak', drillOps],
    ['profile-tabs', () => [profileOp()]],
    ['multi-tool', multiToolOps],
    ['multi-tool-faced', facedMultiToolOps],
    ['chamfer', () => chamferOps()],
    ['chamfer-inch', () => chamferOps(true), testMachine({ programUnits: 'in' })],
    ['countersink-stepped', steppedCountersinkOps],
    ['line-ramp', lineRampOps],
    ['line-vgroove-closed', lineClosedOps],
    ['line-levels', lineLevelsOps],
    ['engraving-rosette', engravingRosetteOps],
    ['engraving-waves-tiled', engravingWavesOps],
    ['engraving-scales-polar', engravingPolarOps],
    [
      'multi-tool-inch-manual-spindle',
      facedMultiToolOps,
      testMachine({ programUnits: 'in', spindle: { control: 'manual', maxSpeed: rpm('24000') } }),
    ],
  ]
  for (const [name, ops, machine = testMachine()] of cases)
    it(name, async () => {
      const e = exportOf(ops(), machine)
      await expect(e.text).toMatchFileSnapshot(`__golden__/${name}.nc`)
      expectDialect(e.lines, machine.programUnits)
      expectIntendedMotion(e.program, e.lines)
      await streamed(e.lines, machine)
    })
})

it('a stepped countersink and its hole run on one tool: loaded once (F7)', () => {
  const e = exportOf(steppedCountersinkOps())
  expect(e.program.blocks.filter((b) => b.kind === 'toolChange')).toHaveLength(1)
})

// ── Dialect ─────────────────────────────────────────────────────────────────────────────

describe('postGrbl', () => {
  it('writes header, tool, spindle dwell, motion and footer', () => {
    const text = expectOk(
      postGrbl(program([tool(), spin(), rapid(1, 2, 10), feed(1, 2, -1)]), OPTS),
    )
    expect(text).toBe(
      [
        '(Program: P)',
        '(Setup: S)',
        '(Units: mm)',
        '(Tool 1: T1, dia 6 mm)',
        '(Generator: DFYOM test)',
        'G90 G94 G17 G21',
        'G54',
        'G0 Z10',
        '(DFYOM TOOL CHANGE 1: T1, 6 mm flat)',
        'M3 S10000',
        'G4 P3',
        'X1 Y2',
        'G1 Z-1 F500',
        'G0 Z10',
        'M5',
        'M30',
        '',
      ].join('\n'),
    )
  })

  // docs/architecture/grbl.md#setup-header-hardening-df58
  it('writes the setup instructions in the header: GRBL-safe comments of at most 70 bytes', () => {
    const setup = {
      number: 2,
      count: 2,
      up: 'top',
      front: 'front',
      right: 'right',
      fromFirst: 'flip about X, then turn 90 deg CCW',
      corner: 'front left',
      stock: [254, 101.6, 19.05] as Vec3,
    }
    const header = (units: 'mm' | 'in') =>
      expectOk(postGrbl(program([tool(), spin()], { setup, setupName: 'Top', units }), OPTS))
        .split('\n')
        .slice(0, 9)
    expect(header('mm')).toEqual([
      '(Program: P)',
      '(Setup 2 of 2: Top)',
      '(Stock X 254 Y 101.6 Z 19.05 mm on the machine)',
      '(Faces: top up, front towards you, right on the right)',
      '(From setup 1: flip about X, then turn 90 deg CCW)',
      '(Work zero G54 X0 Y0: front-left corner of the top face)',
      '(That corner sits front left on the machine)',
      '(Z0 on the top face: the stock surface facing up)',
      '(Units: mm)',
    ])
    expect(header('in')[2]).toBe('(Stock X 10 Y 4 Z 0.75 in on the machine)')
    for (const line of [...header('mm'), ...header('in')]) {
      expect(line.length).toBeLessThanOrEqual(70)
      expect(line).toMatch(/^\([^()]*\)$/)
    }
  })

  // docs/architecture/grbl.md#setup-header-hardening-df58 (DF59 reach lines)
  it('writes how far the tool reaches past the stock, rounded up, and the clamp note', () => {
    const base = {
      number: 1,
      count: 1,
      up: 'top',
      front: 'front',
      right: 'right',
      corner: 'front left',
      stock: [100, 50, 20] as Vec3,
    }
    const reach = (
      overreach: { xMin: number; xMax: number; yMin: number; yMax: number },
      units: 'mm' | 'in' = 'mm',
    ) =>
      expectOk(postGrbl(program([tool(), spin()], { setup: { ...base, overreach }, units }), OPTS))
        .split('\n')
        .filter((l) => /Tool (reaches|stays)|clamps/.test(l))
    expect(reach({ xMin: 0, xMax: 0, yMin: 0, yMax: 0 })).toEqual([
      '(Tool stays within the stock outline)',
      '(Keep clamps below clearance Z 10 mm)',
    ])
    expect(reach({ xMin: 4.2426, xMax: 4.2, yMin: 0, yMax: 0 })).toEqual([
      '(Tool reaches past stock: left 4.3, right 4.2 mm)',
      '(Keep clamps clear of those sides, below clearance Z 10 mm)',
    ])
    expect(reach({ xMin: 0, xMax: 0, yMin: 0, yMax: 25.4 }, 'in')).toEqual([
      '(Tool reaches past stock: back 1 in)',
      '(Keep clamps clear of those sides, below clearance Z 0.3937 in)',
    ])
    // four long sides do not fit one line: an X line and a Y line
    const long = reach({ xMin: 123.41, xMax: 123.41, yMin: 123.41, yMax: 123.41 })
    expect(long).toEqual([
      '(Tool reaches past stock: left 123.5, right 123.5 mm)',
      '(Tool reaches past stock: front 123.5, back 123.5 mm)',
      '(Keep clamps clear of those sides, below clearance Z 10 mm)',
    ])
    for (const line of long) expect(line.length).toBeLessThanOrEqual(70)
  })

  it('tool change: M5, retract, marker, M0, retract in the new WCS, spindle; forgets the position', () => {
    const lines = expectOk(
      postGrblLines(
        program([
          tool(1),
          spin(),
          rapid(1, 2, 10),
          feed(1, 2, -1),
          rapid(1, 2, 10),
          tool(2),
          spin(),
          rapid(1, 2, 10),
          feed(1, 2, -1),
        ]),
        OPTS,
      ),
    )
    expect(body(lines)).toEqual([
      '(DFYOM TOOL CHANGE 1: T1, 6 mm flat)',
      'M3 S10000',
      'G4 P3',
      'X1 Y2',
      'G1 Z-1 F500',
      'G0 Z10',
      '(Tool change to T2: spindle off, retract)',
      'M5',
      '(DFYOM TOOL CHANGE 2: T2, 6 mm flat)',
      'M0 ;Install T2 T2, 6 mm flat, then zero Z',
      'G90 G94 G17 G21',
      'G54',
      'G0 Z10',
      'M3 S10000',
      'G4 P3',
      'X1 Y2', // the same position, written again: the user jogged
      'G1 Z-1 F500', // F again too
      'G0 Z10',
      'M5',
      'M30',
    ])
  })

  it('pauses for the first tool when it is not loaded; no dwell with spinUpSeconds 0', () => {
    const lines = expectOk(
      postGrblLines(program([tool(), spin(), rapid(1, 2, 10)]), {
        ...OPTS,
        firstToolLoaded: false,
        spinUpSeconds: 0,
      }),
    )
    expect(body(lines)).toEqual([
      '(DFYOM TOOL CHANGE 1: T1, 6 mm flat)',
      'M0 ;Install T1 T1, 6 mm flat, then zero Z',
      'G90 G94 G17 G21',
      'G54',
      'G0 Z10',
      'M3 S10000',
      'X1 Y2',
      'M5',
      'M30',
    ])
  })

  it('manual spindle: S still written, then a pause with the speed to set', () => {
    const lines = expectOk(
      postGrblLines(
        program([tool(), spin(12000), rapid(1, 2, 10)], { spindleControl: 'manual' }),
        OPTS,
      ),
    )
    expect(body(lines).slice(1, 4)).toEqual([
      'M3 S12000',
      '(Set spindle to 12000 rpm)',
      'M0 ;Set spindle to 12000 rpm',
    ])
  })

  it('suppresses unchanged words, keeps F pending over dropped lines', () => {
    const lines = expectOk(
      postGrblLines(
        program([
          tool(),
          spin(),
          rapid(0, 0, 10),
          feed(0, 0, 10, 700),
          feed(5, 0, 10, 700),
          feed(5, 5, 10, 700),
          rapid(5, 5, 2),
          feed(5, 5, 0, 300),
        ]),
        OPTS,
      ),
    )
    expect(body(lines).slice(3)).toEqual([
      'X0 Y0',
      'G1 X5 F700',
      'Y5',
      'G0 Z2',
      'G1 Z0 F300',
      'G0 Z10',
      'M5',
      'M30',
    ])
  })

  it('arcs: I/J from the written start, full circles and helices keep an in-plane word', () => {
    const blocks: Block[] = [
      tool(),
      spin(),
      rapid(10, 0, 10),
      feed(10, 0, 0),
      { kind: 'arc', to: [10, 0, -1], i: -10, j: 0, cw: false, feed: 500 }, // full-circle helix
      { kind: 'arc', to: [10, 0, -1], i: -10, j: 0, cw: true, feed: 500 }, // full circle
      { kind: 'arc', to: [-10, 0, -1], i: -10, j: 0, cw: true, feed: 500 }, // half circle
    ]
    const lines = expectOk(postGrblLines(program(blocks), OPTS))
    expect(body(lines).slice(5, 8)).toEqual([
      'G3 X10 Y0 Z-1 I-10 J0',
      'G2 X10 Y0 I-10 J0',
      'X-10 I-10 J0',
    ])
    expectIntendedMotion(program(blocks), lines)
  })

  it('writes an arc whose ends round to nearly the same point as G1 (GRBL would cut a full circle)', () => {
    const r = 5
    const a = 0.0008 / r // chord 0.0008 mm
    const blocks: Block[] = [
      tool(),
      spin(),
      rapid(r, 0, 0),
      { kind: 'arc', to: [r * Math.cos(a), r * Math.sin(a), 0], i: -r, j: 0, cw: false, feed: 500 },
      {
        kind: 'arc',
        to: [r * Math.cos(0.1), r * Math.sin(0.1), 0],
        i: -r * Math.cos(a),
        j: -r * Math.sin(a),
        cw: false,
        feed: 500,
      },
    ]
    const lines = expectOk(postGrblLines(program(blocks), OPTS))
    // the first (chord 0.0008 mm) becomes G1, the second (chord 0.5 mm) stays an arc
    expect(body(lines).slice(4, 6)).toEqual(['G1 Y0.001 F500', 'G3 X4.975 Y0.499 I-5 J-0.001'])
    expectIntendedMotion(program(blocks), lines)
  })

  it('writes a flat arc (sagitta ≤ half a step) as G1: huge radii, short chords of small radii', () => {
    // a 225 m arc over 30 mm bows 0.0005 mm; over 300 mm 0.05 mm (stays an arc)
    const R = 225_000
    const arcTo = (x: number): Block => {
      const y = R - Math.sqrt(R * R - x * x)
      return { kind: 'arc', to: [x, y, 0], i: 0, j: R, cw: false, feed: 500 }
    }
    /** The motion lines after the rapid to the start, before the footer. */
    const moves = (lines: string[]) => body(lines).slice(body(lines).indexOf('X0 Y0 Z0') + 1, -3)
    const flat = expectOk(postGrblLines(program([tool(), spin(), rapid(0, 0, 0), arcTo(30)]), OPTS))
    expect(moves(flat)).toEqual(['G1 X30 Y0.002 F500'])
    // over 300 mm it bows 0.2 mm: chords within 0.001 mm (I/J of 225 m are never written)
    const bowed = program([tool(), spin(), rapid(0, 0, 0), arcTo(300)])
    const chords = moves(expectOk(postGrblLines(bowed, OPTS)))
    expect(chords.length).toBeGreaterThan(5)
    expect(chords.every((l) => /^(G1 )?X[\d.]+ Y[\d.]+( F500)?$/.test(l))).toBe(true)
    expect(chords.at(-1)).toBe('X300 Y0.2')
    // a 2 mm arc of 10° (sagitta 0.0076 mm) stays an arc; of 1° (chord 0.035 mm, sagitta
    // 0.00008 mm) it is a line although its chord is above the short-chord rule
    const small = (deg: number): string => {
      const a = (deg * Math.PI) / 180
      const to: Vec3 = [2 * Math.cos(a), 2 * Math.sin(a), 0]
      const lines = body(
        expectOk(
          postGrblLines(
            program([
              tool(),
              spin(),
              rapid(2, 0, 0),
              { kind: 'arc', to, i: -2, j: 0, cw: false, feed: 500 },
            ]),
            OPTS,
          ),
        ),
      )
      return lines[lines.indexOf('X2 Y0 Z0') + 1]!
    }
    expect(small(10)).toMatch(/^G3 /)
    expect(small(1)).toMatch(/^G1 /)
  })

  it('fails with model.invariant on values it cannot write', () => {
    const bad = (blocks: Block[], over: Partial<MachiningProgram> = {}, opts = OPTS) => {
      const e = expectErrCode(postGrbl(program(blocks, over), opts), 'model.invariant')
      return e.issues.map((i) => i.rule)
    }
    expect(bad([tool(), spin(), rapid(0, 0, 0), feed(1, 0, 0, 0.04)])).toEqual(['positive'])
    expect(bad([tool(), rapid(0, 0, 0), feed(1, 0, 0)])).toEqual(['spindleOff'])
    expect(bad([tool(), spin(0.4)])).toEqual(['positive'])
    expect(bad([tool(), spin(), rapid(Number.NaN, 0, 0)])).toEqual(['range'])
    expect(bad([tool(), spin(), rapid(1e6, 0, 0)])).toEqual(['range'])
    expect(bad([tool(0)])).toEqual(['integer'])
    expect(
      bad([tool(), spin(), { kind: 'arc', to: [1, 1, 0], i: 1, j: 0, cw: true, feed: 100 }]),
    ).toEqual(['arcStart'])
    expect(
      bad([
        tool(),
        spin(),
        rapid(0, 0, 0),
        { kind: 'arc', to: [4, 0, 0], i: 1, j: 0, cw: true, feed: 100 },
      ]),
    ).toEqual(['arcRadius'])
    expect(bad([tool()], {}, { ...OPTS, spinUpSeconds: -1 })).toEqual(['range'])
  })

  it('is deterministic and ends with one newline', () => {
    const a = expectOk(postGrbl(exportOf(multiToolOps()).program, OPTS))
    const b = expectOk(postGrbl(exportOf(multiToolOps()).program, OPTS))
    expect(a).toBe(b)
    expect(a.endsWith('M30\n')).toBe(true)
    expect(a).not.toContain('\r')
  })
})

// ── Properties over random toolpaths ─────────────────────────────────────────────────────

function random(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31
    return s / 2 ** 31
  }
}

/** Lines, arcs ≤ 180° (some tiny, some exactly 180°), helices; within 0..100 mm. */
function randomToolpath(seed: number): Toolpath {
  const rnd = random(seed)
  const moves: Move[] = []
  let p: Vec3 = [10 + 80 * rnd(), 10 + 80 * rnd(), 10]
  moves.push({ kind: 'rapid', to: p })
  p = [p[0], p[1], -1]
  moves.push({ kind: 'line', to: p, feed: 300 })
  for (let k = 0; k < 40; k++) {
    const kind = rnd()
    const z = rnd() < 0.3 ? p[2] - rnd() : p[2]
    if (kind < 0.3) {
      p = [
        Math.min(95, Math.max(5, p[0] + 20 * (rnd() - 0.5))),
        Math.min(95, Math.max(5, p[1] + 20 * (rnd() - 0.5))),
        p[2],
      ]
      moves.push({ kind: 'line', to: p, feed: 100 + Math.round(2000 * rnd()) / 3 })
      continue
    }
    const r = rnd() < 0.2 ? 0.05 + rnd() : 1 + 8 * rnd()
    const a0 = 2 * Math.PI * rnd()
    const sweepKind = rnd()
    const sweep =
      sweepKind < 0.15 ? Math.PI : sweepKind < 0.3 ? 1e-5 + 0.004 * rnd() : Math.PI * rnd()
    const cw = rnd() < 0.5
    const c = [p[0] - r * Math.cos(a0), p[1] - r * Math.sin(a0)] as const
    const a1 = a0 + (cw ? -sweep : sweep)
    p = [c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1), z]
    moves.push({ kind: 'arc', to: p, center: c, cw, feed: 800 })
  }
  moves.push({ kind: 'rapid', to: [p[0], p[1], 10] })
  const passes = [{ kind: 'rough' as const, moves }]
  return {
    planOperationId: `random${seed}`,
    tool: 'em6',
    spindleSpeed: 12000,
    passes,
    stats: toolpathStats(passes, RATES),
  }
}

describe('properties over 40 random toolpaths (mm and inch)', () => {
  for (const units of ['mm', 'in'] as const)
    it(`${units}: dialect, intended motion after suppression, runs on the virtual machine`, async () => {
      const machine = testMachine({ programUnits: units })
      for (let seed = 1; seed <= 40; seed++) {
        const e = exportOf([operation(randomToolpath(seed), endMill(6))], machine)
        expectDialect(e.lines, units)
        expectIntendedMotion(e.program, e.lines)
        if (seed % 8 === 0) await streamed(e.lines, machine)
      }
    })

  it('the test part program keeps the same properties', () => {
    const e = expectOk(exportGrbl(testPartExport(), OPTS))
    expectDialect(e.lines, 'mm')
    expectIntendedMotion(e.program, e.lines)
    expect(e.lines.some((l) => /G8[0-9]/.test(l))).toBe(false)
  })
})

// ── Review fixes (2.11) ─────────────────────────────────────────────────────────────────

describe('review fixes', () => {
  const inch = (blocks: Block[]) => program(blocks, { units: 'in' })

  it('a valid 162° inch arc (r 8.1 mm) exports: the sweep check only catches real flips', () => {
    const start: Vec3 = [54.51629515558574, 13.796223078180835, -1]
    const blocks: Block[] = [
      tool(),
      spin(),
      rapid(start[0], start[1], 10),
      feed(start[0], start[1], -1),
      {
        kind: 'arc',
        to: [45.40368169291071, 0.6060198625175692, -1],
        i: -5.5869,
        j: -5.8831,
        cw: true,
        feed: 500,
      },
    ]
    const lines = expectOk(postGrblLines(inch(blocks), OPTS))
    expectIntendedMotion(inch(blocks), lines)
  })

  // 300 seeded programs: ~1 s alone, several under a parallel `npm test` (docs/conventions/testing.md#commands)
  it('inch fuzz: 300 random toolpaths export and re-parse as intended', { timeout: 60_000 }, () => {
    const machine = testMachine({ programUnits: 'in' })
    for (let seed = 1000; seed < 1300; seed++) {
      const r = exportGrbl(
        exportInput([operation(randomToolpath(seed), endMill(6))], machine),
        OPTS,
      )
      expect(r.isOk(), `seed ${seed}: ${r.isErr() ? r.unwrapErr().message : ''}`).toBe(true)
      expectIntendedMotion(r.unwrap().program, r.unwrap().lines)
    }
  })

  it('reports only the bad arc, not every arc after it', () => {
    const blocks: Block[] = [
      tool(),
      spin(),
      rapid(0, 0, 0),
      { kind: 'arc', to: [4, 0, 0], i: 1, j: 0, cw: true, feed: 100 }, // not on its circle
      { kind: 'arc', to: [8, 0, 0], i: 2, j: 0, cw: true, feed: 100 }, // fine from (4, 0)
      { kind: 'arc', to: [4, 0, 0], i: -2, j: 0, cw: true, feed: 100 },
    ]
    const e = expectErrCode(postGrbl(program(blocks), OPTS), 'model.invariant')
    expect(e.issues.map((i) => i.path)).toEqual([['blocks', 3]])
  })

  it('a non-finite or huge tool diameter is an Err, not a throw', () => {
    for (const diameter of [Number.NaN, Number.POSITIVE_INFINITY, 1e22]) {
      const blocks: Block[] = [
        { kind: 'toolChange', number: 1, tool: { name: 'T', diameter, type: 'flatEndMill' } },
      ]
      const e = expectErrCode(postGrbl(program(blocks), OPTS), 'model.invariant')
      expect(e.issues.map((i) => i.rule)).toEqual(['range'])
    }
  })

  it('inch limits: S is not scaled, F is scaled once', () => {
    const rules = (blocks: Block[]) => {
      const r = postGrbl(inch(blocks), OPTS)
      return r.isOk() ? [] : r.unwrapErr().issues.map((i) => i.rule)
    }
    expect(rules([tool(), spin(200_000)])).toEqual(['range'])
    // 2 000 000 mm/min = 78 740 in/min: writable; 3 000 000 = 118 110 in/min: not
    expect(rules([tool(), spin(), rapid(0, 0, 0), feed(1, 0, 0, 2_000_000)])).toEqual([])
    expect(rules([tool(), spin(), rapid(0, 0, 0), feed(1, 0, 0, 3_000_000)])).toEqual(['range'])
  })

  it('manual spindle: asks to stop the spindle before a tool change and before the end', () => {
    const blocks: Block[] = [tool(1), spin(), rapid(1, 2, 10), tool(2), spin(), rapid(1, 2, 10)]
    const lines = expectOk(postGrblLines(program(blocks, { spindleControl: 'manual' }), OPTS))
    const k = lines.indexOf('(DFYOM TOOL CHANGE 2: T2, 6 mm flat)')
    expect(lines.slice(k - 1, k + 2)).toEqual([
      '(Stop the spindle)',
      '(DFYOM TOOL CHANGE 2: T2, 6 mm flat)',
      'M0 ;Stop spindle, install T2 T2, 6 mm flat, then zero Z',
    ])
    expect(lines.slice(-4)).toEqual(['M5', '(Stop the spindle)', 'M0 ;Stop the spindle', 'M30'])
    // gcode spindles get neither
    const g = expectOk(postGrblLines(program(blocks), OPTS))
    expect(g.filter((l) => l === '(Stop the spindle)')).toEqual([])
  })

  it('after a tool change M0: modes and G54 again before the retract', () => {
    const blocks: Block[] = [tool(1), spin(), rapid(1, 2, 10), tool(2), spin(), rapid(1, 2, 10)]
    const lines = expectOk(postGrblLines(program(blocks), OPTS))
    const k = lines.indexOf('(DFYOM TOOL CHANGE 2: T2, 6 mm flat)')
    expect(lines.slice(k + 1, k + 5)).toEqual([
      'M0 ;Install T2 T2, 6 mm flat, then zero Z',
      'G90 G94 G17 G21',
      'G54',
      'G0 Z10',
    ])
  })

  it('the motion check catches a wrong arc direction, also for full circles', () => {
    const blocks: Block[] = [
      tool(),
      spin(),
      rapid(10, 0, 10),
      feed(10, 0, 0),
      { kind: 'arc', to: [10, 0, 0], i: -10, j: 0, cw: true, feed: 500 },
    ]
    const lines = expectOk(postGrblLines(program(blocks), OPTS))
    expectIntendedMotion(program(blocks), lines)
    const wrong = lines.map((l) => l.replace(/^G2 /, 'G3 '))
    expect(wrong).not.toEqual(lines)
    expect(() => expectIntendedMotion(program(blocks), wrong)).toThrow()
  })
})
