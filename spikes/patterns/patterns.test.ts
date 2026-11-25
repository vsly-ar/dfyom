/**
 * Spike S8 (report: docs/research/2026-11-25-spike-s8-patterns.md): one pocket whose named shape
 * is N cells on a lattice inside a rectangle boundary less a margin, through the real code paths:
 * `design.shape.add` (the shape's fold of N `add` items through CavalierContours), the part's
 * geometry input and `evaluatePart` (Manifold), `plan.create`, `plan.toolpath.generate` (the
 * pocket and edge-chamfer generators), `exportPlan` (GRBL, safe links). With an optional edge
 * chamfer: which construction it takes (offset-loft or swept chords) and the per-cell lofts.
 *
 * Run: `npx vitest run -c spikes/patterns/vitest.config.mts --silent=false`.
 * Env: S8_COUNTS (default 100,500,2000), S8_CASES (hex-hex,hex-circle,square-hex,square-circle),
 * S8_CHAMFERS (default none,0.5,1.2), S8_FALLBACK_MAX (largest chord count whose swept-chord
 * fallback is evaluated, default 6 000), S8_PLAN (1: plan, generate and export; default 1).
 */
import { beforeAll, expect, it } from 'vitest'
import { Ok } from '../../src/shared/result'
import { expectOk } from '../../src/shared/testing/result'
import { createInProcessWorkers } from '../../src/core/commands/jobs'
import { uiSource } from '../../src/core/commands/testing'
import { resolveDefinition } from '../../src/core/design/shape'
import { partGeometryInput } from '../../src/core/design/load'
import { evaluatePart } from '../../src/core/geometry/evaluate'
import { loopChamferConstruction, loopChamferSolids } from '../../src/core/geometry/chamfer-solids'
import { loadManifold } from '../../src/core/geometry/manifold'
import type { PartGeometryInput, OperationGeometry } from '../../src/core/geometry/model'
import { flattenLoop } from '../../src/core/geometry/prism'
import { regionArea, regionLoops, type Region } from '../../src/core/geometry/2d/model'
import { nodeRegion2d } from '../../src/core/geometry/2d/testing/node-wasm'
import type { SolidKernel } from '../../src/core/geometry/solid-port'
import { nodeManifoldSource } from '../../src/core/geometry/testing/node-wasm'
import { deg, len, libraryInput, num } from '../../src/core/library/library.fixture'
import { exportPlan } from '../../src/core/post/plan-export'
import { planSetup } from '../../src/core/plan/plan.fixture'
import { createToolpathCache } from '../../src/core/toolpath/cache'
import type { Toolpath } from '../../src/core/toolpath/model'
import type { Steps } from '../../src/core/workers/steps'
import {
  boundaryFor,
  circleCell,
  directRegion,
  hexCell,
  patternRegion,
  type Cell,
  type LatticeKind,
} from './lattice'

const COUNTS = (process.env['S8_COUNTS'] ?? '100,500,2000').split(',').map(Number)
const CASES = (process.env['S8_CASES'] ?? 'hex-hex,hex-circle,square-hex,square-circle').split(',')
const CHAMFERS = (process.env['S8_CHAMFERS'] ?? 'none,0.5,1.2').split(',')
const FALLBACK_MAX = Number(process.env['S8_FALLBACK_MAX'] ?? 6000)
const PLAN = (process.env['S8_PLAN'] ?? '1') === '1'
const GAP = 2
const MARGIN = 5
const DEPTH = 1.5
const MB = 2 ** 20

const ui = uiSource()
const region2d = nodeRegion2d()
let kernel: SolidKernel
beforeAll(async () => {
  kernel = (await loadManifold(nodeManifoldSource())).unwrap()
})

const now = () => performance.now()
const f = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2))
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

const chamferMill = () => ({
  name: 'Chamfer 6',
  type: 'chamferMill' as const,
  diameter: len('6'),
  angle: deg('90'),
  fluteLength: len('8'),
  overallLength: len('50'),
  fluteCount: num('2'),
  toolMaterial: 'carbide' as const,
  presets: [],
})

/** Steps that record the longest gap between two steps (abort latency). */
function timedSteps(): Steps & { longest: number; longestLabel: string; count: number } {
  let last = now()
  const s = {
    longest: 0,
    longestLabel: '',
    count: 0,
    step(p?: { label?: string }) {
      const t = now()
      if (t - last > s.longest) {
        s.longest = t - last
        s.longestLabel = p?.label ?? '?'
      }
      s.count++
      last = t
      return Ok(undefined)
    },
  }
  return s
}

interface EvalRow {
  ms: number
  coldMs: number
  longestStep: number
  longestLabel: string
  triangles: number
  meshMB: number
  wasmMB: number
  volume: number
}

const errors: string[] = []

/** `evaluate`, recording a kernel failure (a WASM trap) instead of aborting the run. */
function tryEvaluate(what: string, input: PartGeometryInput, runs = 3): EvalRow | undefined {
  try {
    return evaluate(input, runs)
  } catch (e) {
    errors.push(`${what}: ${String(e)}`)
    console.log(`ERROR ${what}: ${String(e)}`)
    // the trapped kernel is unusable: the next case loads a fresh one
    return undefined
  }
}

function evaluate(input: PartGeometryInput, runs = 3): EvalRow {
  const st = timedSteps()
  const t0 = now()
  const first = kernel.withSolids((s) => evaluatePart(input, s, st, region2d)).unwrap()
  const coldMs = now() - t0
  const times: number[] = []
  for (let i = 0; i < runs - 1; i++) {
    const t = now()
    kernel.withSolids((s) => evaluatePart(input, s, undefined, region2d)).unwrap()
    times.push(now() - t)
  }
  return {
    ms: times.length === 0 ? coldMs : median(times),
    coldMs,
    longestStep: st.longest,
    longestLabel: st.longestLabel,
    triangles: first.stats.triangles,
    meshMB:
      (first.positions.byteLength + first.indices.byteLength + first.triangleSurface.byteLength) /
      MB,
    wasmMB: kernel.heapBytes().unwrapOr(0) / MB,
    volume: first.volume,
  }
}

/** Chords of a region at the chord tolerance (what the prism and the fallback sweep). */
const chordsOf = (r: Region) =>
  regionLoops(r).reduce((s, l) => s + flattenLoop(l, 'shrink').points.length, 0)

/** Region pieces sorted in rows (y bands, then x), so groups are spatially compact. */
function sortedPieces(r: Region) {
  const key = (p: Region['pieces'][number]) => {
    const a = p.outer.elements[0]!.a
    return [Math.round(a[1] / 5), a[0]] as const
  }
  return [...r.pieces].sort((p, q) => {
    const [py, px] = key(p)
    const [qy, qx] = key(q)
    return py - qy || px - qx
  })
}

/**
 * The chamfer (or pocket) split into operations of `k` cells each, same face and centre:
 * the per-cell (k = 1) or batched loft, unioned and subtracted by `evaluatePart`'s layers.
 */
function chunked(input: PartGeometryInput, id: string, k: number): PartGeometryInput {
  const ops: OperationGeometry[] = []
  for (const op of input.operations) {
    if (op.id !== id) {
      ops.push(op)
      continue
    }
    const shape = op.kind === 'chamfer' && op.edge !== undefined ? op.edge.shape : undefined
    const pocketShape = op.kind === 'pocket' ? op.shape : undefined
    const s = shape ?? pocketShape
    if (s === undefined || s.contour.kind !== 'region') throw new Error(`${id}: no region`)
    const pieces = sortedPieces(s.contour.region)
    for (let g = 0; g * k < pieces.length; g++) {
      const sub = {
        ...s,
        contour: { kind: 'region' as const, region: { pieces: pieces.slice(g * k, g * k + k) } },
      }
      if (op.kind === 'chamfer' && op.edge !== undefined)
        ops.push({ ...op, id: `${id}_${g}`, edge: { ...op.edge, shape: sub } })
      else if (op.kind === 'pocket') ops.push({ ...op, id: `${id}_${g}`, shape: sub })
    }
  }
  return { ...input, operations: ops }
}

interface Row {
  label: string
  n: number
  size: string
  chamfer: string
  shapeAddMs: number
  foldMs: number
  normaliseMs: number
  directMs: number
  inputMs: number
  chords: number
  construction: string
  ev?: EvalRow | undefined
  perCell?: EvalRow | undefined
  batch50?: EvalRow | undefined
  planMs?: number
  generateMs?: number
  pocketMoves?: number
  chamferMoves?: number
  pocketRapid?: number
  exportMs?: number
  lines?: number
  kB?: number
  minutes?: number
  rssMB: number
  volumeDelta?: number
  pocket100?: EvalRow | undefined
  perCellBuildMs?: number
  perCellLofts?: number
  caseMs?: number
}

const rows: Row[] = []

async function runCase(
  latticeKind: LatticeKind,
  cell: Cell,
  n: number,
  chamfer: string,
): Promise<Row> {
  const { size, centres } = boundaryFor(latticeKind, cell, GAP, MARGIN, n)
  const svc = {
    region2d,
    toolpaths: createToolpathCache(),
    workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  }
  const s = await planSetup({
    part: false,
    services: svc,
    stock: {
      name: 'Board',
      shape: 'block' as const,
      length: String(size[0]),
      width: String(size[1]),
      thickness: '20',
      material: { name: 'Walnut', class: 'hardwood' as const },
    },
  })
  // a fresh kernel per case: a WASM heap only grows, and a big case would starve the next
  kernel = (await loadManifold(nodeManifoldSource())).unwrap()
  await s.run('library.tool.add', { values: libraryInput(chamferMill()) })
  const items = centres.map((c) => cell.item(c))
  let t = now()
  await s.run('design.shape.add', { partId: s.partId, items })
  const shapeAddMs = now() - t

  // the fold the named shape takes (uncached) against one normalise and the direct pieces;
  // once per layout (the first chamfer variant)
  let foldMs = NaN
  let normaliseMs = NaN
  t = now()
  const built = directRegion(region2d, cell, centres)
  const directMs = now() - t
  if (chamfer === CHAMFERS[0] && process.env['S8_FOLD'] !== '0') {
    t = now()
    const fold = resolveDefinition(
      region2d,
      centres.map((c) => cell.def(c)),
    ).unwrap()
    foldMs = now() - t
    t = now()
    const direct = patternRegion(region2d, cell, centres)
    normaliseMs = now() - t
    if (fold.kind !== 'region') throw new Error('fold is not a region')
    expect(fold.region.pieces).toHaveLength(centres.length)
    expect(direct.pieces).toHaveLength(centres.length)
    expect(regionArea(direct)).toBeCloseTo(regionArea(fold.region), 3)
    expect(regionArea(built)).toBeCloseTo(regionArea(direct), 3)
  }

  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: {
      kind: 'named',
      shapeId: 'shape1',
      center: [String(size[0] / 2), String(size[1] / 2)],
    },
    depth: String(DEPTH),
  })
  if (chamfer !== 'none')
    await s.run('design.chamfer.add', { partId: s.partId, edgeOf: 'pocket1', width: chamfer })
  await s.run('project.apply', {})

  t = now()
  const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
  const inputMs = now() - t
  const pocket = input.operations.find((o) => o.id === 'pocket1')!
  const chords =
    pocket.kind === 'pocket' && pocket.shape.contour.kind === 'region'
      ? chordsOf(pocket.shape.contour.region)
      : 0
  const ch = input.operations.find((o) => o.id === 'chamfer1')
  const construction =
    ch?.kind === 'chamfer' && ch.edge !== undefined
      ? kernel
          .withSolids((sol) =>
            Ok(
              loopChamferConstruction(ch, {
                triangulate: (r) => sol.triangulate(r),
                region2d,
              }),
            ),
          )
          .unwrap()
      : '–'

  const row: Row = {
    label: `${latticeKind} / ${cell.name}`,
    n: centres.length,
    size: `${size[0]} × ${size[1]}`,
    chamfer,
    shapeAddMs,
    foldMs,
    normaliseMs,
    directMs,
    inputMs,
    chords,
    construction,
    rssMB: process.memoryUsage().rss / MB,
  }
  // the whole region's evaluation (the fallback only while it stays affordable)
  if (construction !== 'fallback' || chords <= FALLBACK_MAX)
    row.ev = tryEvaluate(`${row.label} ${row.n} ${chamfer} whole`, input)
  if (ch === undefined) row.pocket100 = tryEvaluate('pocket100', chunked(input, 'pocket1', 100), 1)
  if (ch?.kind === 'chamfer' && ch.edge !== undefined) {
    // per-cell loft build alone: the construction and the solids of each one-cell chamfer
    const shape = ch.edge.shape
    if (shape.contour.kind !== 'region') throw new Error('no region')
    let lofts = 0
    t = now()
    kernel
      .withSolids((sol) => {
        const ctx = {
          triangulate: (r: Parameters<typeof sol.triangulate>[0]) => sol.triangulate(r),
          region2d,
        }
        for (const piece of (shape.contour as { region: Region }).region.pieces) {
          const one = {
            ...ch,
            edge: {
              ...ch.edge,
              shape: {
                ...shape,
                contour: { kind: 'region' as const, region: { pieces: [piece] } },
              },
            },
          }
          if (loopChamferConstruction(one, ctx) === 'loft') lofts++
          loopChamferSolids(one, ctx).unwrap()
        }
        return Ok(undefined)
      })
      .unwrap()
    row.perCellBuildMs = now() - t
    row.perCellLofts = lofts
    if (row.ev === undefined && construction === 'loft')
      kernel = (await loadManifold(nodeManifoldSource())).unwrap()
    row.perCell = tryEvaluate(
      `${row.label} ${row.n} ${chamfer} per cell`,
      chunked(input, 'chamfer1', 1),
      1,
    )
    if (construction === 'loft')
      row.batch50 = tryEvaluate('batch50', chunked(input, 'chamfer1', 50), 1)
    // same part within the chord band (the fallback's chords against the loft's offsets)
    if (row.ev !== undefined && row.perCell !== undefined)
      row.volumeDelta = row.perCell.volume - row.ev.volume
  }

  if (PLAN && (row.ev !== undefined || row.perCell !== undefined)) {
    t = now()
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    row.planMs = now() - t
    t = now()
    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
      .value as { jobId: string }
    const gen = expectOk(await s.d.job(jobId).unwrap().result) as {
      operations: { planOperationId: string; status: string }[]
    }
    row.generateMs = now() - t
    expect(gen.operations.every((o) => o.status === 'generated')).toBe(true)
    const ops = s.plan(planId).setups.flatMap((x) => x.operations)
    const tp = (design: string) => {
      const op = ops.find((o) => o.designOperationIds.includes(design))
      if (op === undefined) return undefined
      return (
        s.query('plan.toolpath.get', { planId, planOperationId: op.id }) as { toolpath: Toolpath }
      ).toolpath
    }
    const moves = (p: Toolpath | undefined) =>
      p?.passes.reduce((a, x) => a + x.moves.length, 0) ?? 0
    const pt = tp('pocket1')
    row.pocketMoves = moves(pt)
    if (pt !== undefined) row.pocketRapid = pt.stats.rapidLength
    row.chamferMoves = moves(tp('chamfer1'))
    t = now()
    const e = expectOk(await exportPlan(s.d.doc, planId, svc))
    row.exportMs = now() - t
    row.lines = e.lines.length
    row.kB = e.lines.reduce((a, l) => a + l.length + 1, 0) / 1024
    row.minutes = e.stats.estimatedSeconds / 60
  }
  row.rssMB = Math.max(row.rssMB, process.memoryUsage().rss / MB)
  return row
}

const evalCell = (e: EvalRow | undefined) =>
  e === undefined
    ? 'skipped'
    : `${f(e.ms)} (cold ${f(e.coldMs)}, step ${f(e.longestStep)} ${e.longestLabel})`

it('S8: pattern pockets through design, evaluation, plan and export', async () => {
  for (const c of CASES) {
    const [lk, ck] = c.split('-') as [LatticeKind, string]
    const cell = ck === 'circle' ? circleCell : hexCell
    for (const n of COUNTS)
      for (const chamfer of CHAMFERS) {
        const t0 = now()
        const r = await runCase(lk, cell, n, chamfer)
        r.caseMs = now() - t0
        rows.push(r)
        console.log(JSON.stringify(r))
      }
  }
  const out = [
    '| Case | N | Boundary | Chamfer | shape.add | Fold | Normalise | Direct | Input | Chords | Construction | Eval ms (cold, longest step) | Tris | Mesh MB | WASM MB | Per-cell chamfer eval | Batch-50 eval | Plan | Generate | Pocket moves | Chamfer moves | Rapid m | Export | Lines | kB | Min | RSS MB |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows
      .map((r) =>
        [
          r.label,
          r.n,
          r.size,
          r.chamfer,
          f(r.shapeAddMs),
          f(r.foldMs),
          f(r.normaliseMs),
          f(r.directMs),
          f(r.inputMs),
          r.chords,
          r.construction,
          evalCell(r.ev),
          r.ev?.triangles ?? '–',
          r.ev === undefined ? '–' : f(r.ev.meshMB),
          r.ev === undefined ? '–' : f(r.ev.wasmMB),
          r.perCell === undefined ? '–' : evalCell(r.perCell),
          r.batch50 === undefined ? '–' : evalCell(r.batch50),
          r.planMs === undefined ? '–' : f(r.planMs),
          r.generateMs === undefined ? '–' : f(r.generateMs),
          r.pocketMoves ?? '–',
          r.chamferMoves ?? '–',
          r.pocketRapid === undefined ? '–' : f(r.pocketRapid / 1000),
          r.exportMs === undefined ? '–' : f(r.exportMs),
          r.lines ?? '–',
          r.kB === undefined ? '–' : f(r.kB),
          r.minutes === undefined ? '–' : f(r.minutes),
          f(r.rssMB),
        ].join(' | '),
      )
      .map((l) => `| ${l} |`),
  ]
  console.log(out.join('\n'))
  console.log(errors.join('\n'))
})
