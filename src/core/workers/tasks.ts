/**
 * The production worker tasks. The worker entry registers `WORKER_TASKS`; the test entry adds
 * fixtures. Doc: docs/architecture/workers.md#what-runs-on-a-worker
 */
import { z } from 'zod'
import { Err, Ok, tryAsync, type AppResult } from '../../shared/result'
import type { AnyWorkerTask, TaskControl, WorkerTask } from '../commands/jobs'
import {
  meshLevels,
  MeshLevelsSchema,
  type LevelOptions,
  type MeshLevels,
} from '../design/mesh-levels'
import { meshHoles, MeshHolesSchema, type HoleOptions, type MeshHoles } from '../design/mesh-holes'
import {
  compareBoolean,
  compareHeightmap,
  CompareRawSchema,
  isClosed,
  transformSoup,
  weldSoup,
  type CompareMesh,
  type CompareRaw,
} from '../design/reference-compare'
import { DIRECTIONS, type Direction, type StockSize } from '../geometry/face'
import { FEATURE_EDGE_DEG, featureEdges, meshSection, sectionChains } from '../design/mesh-section'
import {
  fitSection,
  FittedLoopSchema,
  type FittedLoop,
  type SectionFitOptions,
} from '../design/reference-section'
import { createStlParser, STL_LIMITS, StlPositions, type StlSummary } from '../design/stl'
import { svgImportTask } from '../import/svg/task'
import { evaluatePart, type PartEvaluation } from '../geometry/evaluate'
import type { PartGeometryInput } from '../geometry/model'
import { OperationCache } from '../geometry/operation-cache'
import { needsRegion2d } from '../geometry/operations'
import type { Region2dPort } from '../geometry/2d/port'
import { PartEvaluationSchema, PartGeometryInputSchema } from '../geometry/schemas'
import type { Toolpath } from '../toolpath/model'
import { generateRequest, GeneratorRequestSchema, type GeneratorRequest } from '../toolpath/request'
import { ToolpathSchema } from '../toolpath/schemas'

/** Operations built by earlier evaluations in this worker (unchanged ones are not rebuilt). */
const operationCache = new OperationCache()

/**
 * Triangles of the solids the geometry worker's kernel keeps across evaluations (unchanged
 * operations' solids and the part after the clone layers, `SolidPort.kept`): ≈ 40–60 MB of WASM
 * heap. A Clones feature of 100 counterbored holes keeps ≈ 60 000 (its operations ≈ 27 000, the
 * part after its clone layers ≈ 31 000), so this holds a few of them; 150 000 before clone
 * layers (docs/architecture/geometry.md#wasm-lifetime-and-ownership, #clone-layers).
 */
export const KEPT_TRIANGLES = 300_000

/** `evaluatePart` in the geometry lane, inside one `withSolids` arena. */
export const geometryEvaluate: WorkerTask<PartGeometryInput, PartEvaluation> = {
  name: 'geometry.evaluate',
  lane: 'geometry',
  input: PartGeometryInputSchema,
  output: PartEvaluationSchema,
  timeoutMs: 10_000,
  transfer: (e) => [e.positions, e.indices, e.triangleSurface],
  async run(input, ctl) {
    const kernel = await ctl.solids()
    if (kernel.isErr()) return Err(kernel.unwrapErr())
    // the 2D port only when a shape operation needs it (general shapes, G1)
    let region2d: Region2dPort | undefined
    if (needsRegion2d(input)) {
      const port = ctl.region2d()
      if (port.isErr()) return Err(port.unwrapErr())
      region2d = port.unwrap()
    }
    const solids = kernel.unwrap()
    solids.keepSolids(KEPT_TRIANGLES)
    return solids.withSolids((s) => evaluatePart(input, s, ctl.steps, region2d, operationCache))
  },
}

/** The toolpath of one plan operation (`GeneratorRequest`) in the toolpath lane. */
export const toolpathGenerate: WorkerTask<GeneratorRequest, Toolpath> = {
  name: 'toolpath.generate',
  lane: 'toolpath',
  input: GeneratorRequestSchema,
  output: ToolpathSchema,
  timeoutMs: 60_000,
  run: (request, ctl) => {
    const r = generateRequest(request, ctl.steps, ctl.region2d)
    // the job keeps a failure as data (stack dropped, plan.toolpath.generate); the log keeps it
    // whole, the one place it is reported
    if (r.isErr() && r.unwrapErr().code !== 'op.aborted') {
      const e = r.unwrapErr()
      ctl.log[e.severity]({ err: e.toJSON() }, 'toolpath generation failed')
    }
    return r
  },
}

const xyz = z.object({ x: z.number(), y: z.number(), z: z.number() })
export const StlSummarySchema: z.ZodType<StlSummary> = z.object({
  format: z.enum(['binary', 'ascii']),
  triangles: z.number().int().positive(),
  bounds: z.object({ min: xyz, max: xyz }),
  closed: z.boolean(),
})

/**
 * Parses a local STL file (a project asset) streamed through `ctl.files`, one step per chunk;
 * only the summary leaves the worker (docs/modes/reference-model.md#stl-parser-task-r2).
 */
export const stlParse: WorkerTask<{ path: string }, StlSummary> = {
  name: 'reference.parseStl',
  lane: 'geometry',
  input: z.object({ path: z.string().min(1) }),
  output: StlSummarySchema,
  timeoutMs: 120_000,
  async run({ path }, ctl) {
    const opened = await ctl.files.open(path)
    if (opened.isErr()) return opened
    const { size, chunks } = opened.unwrap()
    const created = createStlParser(size)
    if (created.isErr()) return created
    const parser = created.unwrap()
    const read = await tryAsync(
      async (): Promise<AppResult<StlSummary>> => {
        let done = 0
        for await (const chunk of chunks) {
          const step = ctl.steps.step({ done, total: size, label: 'Reading STL' })
          if (step.isErr()) return step
          const pushed = parser.push(chunk)
          if (pushed.isErr()) return pushed
          done += chunk.length
        }
        return parser.finish()
      },
      'persist.io',
      'reading the STL file failed',
    )
    return read.isOk() ? read.unwrap() : Err(read.unwrapErr().withContext('reference.parseStl'))
  },
}

/**
 * The triangles of an STL for the reference ghost: 9 float32 per triangle, source units, and its
 * feature edges (6 float32 per segment, source units; task U3 moved them off the renderer thread).
 */
export interface StlMesh {
  readonly positions: Float32Array
  readonly edges: Float32Array
}

/** Reads a stored reference's triangles with the streamed parser, one step per chunk. */
async function readStlPositions(
  path: string,
  triangles: number,
  ctl: TaskControl,
  where: string,
): Promise<AppResult<Float32Array>> {
  const opened = await ctl.files.open(path)
  if (opened.isErr()) return opened
  const { size, chunks } = opened.unwrap()
  const keep = new StlPositions(triangles)
  const created = createStlParser(size, STL_LIMITS, keep.add)
  if (created.isErr()) return created
  const parser = created.unwrap()
  const read = await tryAsync(
    async (): Promise<AppResult<Float32Array>> => {
      let done = 0
      for await (const chunk of chunks) {
        const step = ctl.steps.step({ done, total: size, label: 'Reading STL' })
        if (step.isErr()) return step
        const pushed = parser.push(chunk)
        if (pushed.isErr()) return pushed
        done += chunk.length
      }
      return parser.finish().map(() => keep.positions())
    },
    'persist.io',
    'reading the STL file failed',
  )
  return read.isOk() ? read.unwrap() : Err(read.unwrapErr().withContext(where))
}

const StlReadSchema = z.object({
  path: z.string().min(1),
  triangles: z.number().int().positive().max(STL_LIMITS.maxTriangles),
})

/**
 * Reads a stored reference's triangles for the viewport ghost (task R3,
 * docs/modes/reference-model.md#ghost-mesh-task-r3): the same streamed parser as `stlParse`, with
 * a sink that keeps every triangle. `triangles` (the record's count) sizes the buffer once. The
 * feature edges (`featureEdges`) are found here too (U3), so the renderer thread does not; both
 * buffers are transferred to the host, never cloned.
 */
export const stlMesh: WorkerTask<{ path: string; triangles: number }, StlMesh> = {
  name: 'reference.meshStl',
  lane: 'geometry',
  input: StlReadSchema,
  output: z.object({ positions: z.instanceof(Float32Array), edges: z.instanceof(Float32Array) }),
  timeoutMs: 120_000,
  transfer: (m) => [m.positions, m.edges],
  async run({ path, triangles }, ctl) {
    const read = await readStlPositions(path, triangles, ctl, 'reference.meshStl')
    if (read.isErr()) return read
    const positions = read.unwrap()
    return featureEdges(positions, FEATURE_EDGE_DEG, ctl.steps).map((edges) => ({
      positions,
      edges,
    }))
  },
}

/**
 * The last reference mesh read by the section and levels tasks, kept in the worker: a new depth
 * or face does not read the file again.
 */
let keptMesh: { readonly path: string; readonly positions: Float32Array } | undefined

/**
 * Holes found on the kept mesh by face matrix and options (DF60 P3): a scale change reads the
 * same faces again (`reference.featureBelowTool`), so they are not cut again. Cleared with the mesh.
 */
const keptHoles = new Map<string, MeshHoles>()
const KEPT_HOLES_MAX = 24

async function referencePositions(
  path: string,
  triangles: number,
  ctl: TaskControl,
  where: string,
): Promise<AppResult<Float32Array>> {
  if (keptMesh?.path !== path) {
    const read = await readStlPositions(path, triangles, ctl, where)
    if (read.isErr()) return read
    keptMesh = { path, positions: read.unwrap() }
    keptHoles.clear()
  }
  return Ok(keptMesh.positions)
}

/** A Float32Array from any realm (a jsdom test's arrays fail `instanceof` across realms). */
const FLOAT32 = z.custom<Float32Array>(
  (v) => Object.prototype.toString.call(v) === '[object Float32Array]',
  'expected a Float32Array',
)

export interface SectionInput {
  readonly path: string
  readonly triangles: number
  /** Column-major 4 × 4: source units → the face frame (mm), the plane normal third. */
  readonly matrix: readonly number[]
  /** The plane's height in the face frame (mm): the face's level minus the section depth. */
  readonly level: number
  /** Also chain, orient and fit the loops (DF60 P1; mm, degrees). */
  readonly fit?: SectionFitOptions | undefined
}

export interface SectionOutput {
  readonly segments: Float32Array
  readonly loops?: readonly FittedLoop[] | undefined
}

/**
 * The reference section (task U3, docs/modes/design-v0.3.md#measure-and-snap): a stored
 * reference's mesh cut by a face-parallel plane, as segments in the face frame (mm), and with
 * `fit` the fitted loops (DF60 P1, docs/modes/reference-tools.md#section). The mesh is read once
 * per file and kept for the next depth; only the segments and loops leave the worker.
 */
export const referenceSection: WorkerTask<SectionInput, SectionOutput> = {
  name: 'reference.section',
  lane: 'geometry',
  input: StlReadSchema.extend({
    matrix: z.array(z.number()).length(16),
    level: z.number(),
    fit: z
      .object({ tolerance: z.number().positive(), cornerAngle: z.number().positive() })
      .optional(),
  }),
  output: z.object({
    segments: FLOAT32,
    loops: z.array(FittedLoopSchema).readonly().optional(),
  }),
  timeoutMs: 120_000,
  transfer: (r) => [r.segments],
  async run({ path, triangles, matrix, level, fit }, ctl) {
    const read = await referencePositions(path, triangles, ctl, 'reference.section')
    if (read.isErr()) return read
    const positions = read.unwrap()
    const segments = meshSection(positions, matrix, level, ctl.steps)
    if (segments.isErr()) return segments
    if (fit === undefined) return Ok({ segments: segments.unwrap() })
    const chains = sectionChains(positions, matrix, level, ctl.steps)
    if (chains.isErr()) return chains
    return Ok({ segments: segments.unwrap(), loops: fitSection(chains.unwrap(), fit) })
  },
}

export interface LevelsInput {
  readonly path: string
  readonly triangles: number
  /** Column-major 4 × 4: source units → the face frame (mm), the face at w = 0. */
  readonly matrix: readonly number[]
  readonly options: LevelOptions
}

/** The depth levels of a stored reference seen from a face (DF60 P1, `meshLevels`). */
export const referenceLevels: WorkerTask<LevelsInput, MeshLevels> = {
  name: 'reference.levels',
  lane: 'geometry',
  input: StlReadSchema.extend({
    matrix: z.array(z.number()).length(16),
    options: z.object({
      minArea: z.number().nonnegative(),
      limit: z.number().int().positive(),
      sides: z.enum(['both', 'face']),
      extent: z.number(),
    }),
  }),
  output: MeshLevelsSchema,
  timeoutMs: 120_000,
  async run({ path, triangles, matrix, options }, ctl) {
    const read = await referencePositions(path, triangles, ctl, 'reference.levels')
    if (read.isErr()) return read
    return meshLevels(read.unwrap(), matrix, options, ctl.steps)
  },
}

export interface HolesInput {
  readonly path: string
  readonly triangles: number
  /** Column-major 4 × 4: source units → the face frame (mm), the face at w = 0. */
  readonly matrix: readonly number[]
  readonly options: HoleOptions
}

/** The holes of a stored reference seen from a face (DF60 P3, `meshHoles`). */
export const referenceHoles: WorkerTask<HolesInput, MeshHoles> = {
  name: 'reference.holes',
  lane: 'geometry',
  input: StlReadSchema.extend({
    matrix: z.array(z.number()).length(16),
    options: z.object({
      maxDiameter: z.number().positive(),
      limit: z.number().int().positive(),
    }),
  }),
  output: MeshHolesSchema,
  timeoutMs: 120_000,
  async run({ path, triangles, matrix, options }, ctl) {
    const read = await referencePositions(path, triangles, ctl, 'reference.holes')
    if (read.isErr()) return read
    const key = JSON.stringify([matrix, options])
    const kept = keptHoles.get(key)
    if (kept !== undefined) return Ok(kept)
    const r = meshHoles(read.unwrap(), matrix, options, ctl.steps)
    if (r.isOk()) {
      if (keptHoles.size >= KEPT_HOLES_MAX) keptHoles.clear()
      keptHoles.set(key, r.unwrap())
    }
    return r
  },
}

/** A Uint32Array from any realm (see `FLOAT32`). */
const UINT32 = z.custom<Uint32Array>(
  (v) => Object.prototype.toString.call(v) === '[object Uint32Array]',
  'expected a Uint32Array',
)

export interface CompareInput {
  readonly path: string
  readonly triangles: number
  /** Column-major 4 × 4: source units → the part frame (mm). */
  readonly matrix: readonly number[]
  readonly part: CompareMesh
  readonly threshold: number
  readonly stock: StockSize
  /** Faces the design's operations use, for the height maps. */
  readonly directions: readonly Direction[]
}

/**
 * The design against its reference (DF60 P4, docs/modes/reference-tools.md#method-rt-f): the
 * kept reference mesh placed in the part frame and the evaluated part mesh; booleans when the
 * welded reference is closed and the library takes it, else height maps. Only the regions'
 * summaries leave the worker.
 */
export const referenceCompare: WorkerTask<CompareInput, CompareRaw> = {
  name: 'reference.compare',
  lane: 'geometry',
  input: StlReadSchema.extend({
    matrix: z.array(z.number()).length(16),
    part: z.object({ positions: FLOAT32, indices: UINT32, triangleSurface: UINT32 }),
    threshold: z.number().positive(),
    stock: z.object({
      length: z.number().positive(),
      width: z.number().positive(),
      thickness: z.number().positive(),
    }),
    directions: z.array(z.enum(DIRECTIONS)),
  }),
  output: CompareRawSchema,
  timeoutMs: 120_000,
  async run(input, ctl) {
    const read = await referencePositions(input.path, input.triangles, ctl, 'reference.compare')
    if (read.isErr()) return read
    const placed = transformSoup(read.unwrap(), input.matrix)
    const opts = { threshold: input.threshold, stock: input.stock, directions: input.directions }
    const welded = weldSoup(placed)
    if (!isClosed(welded))
      return compareHeightmap(placed, input.part, opts, ctl.steps, 'the reference mesh is open')
    const kernel = await ctl.solids()
    if (kernel.isErr()) return Err(kernel.unwrapErr())
    const r = compareBoolean(kernel.unwrap(), welded, input.part, input.threshold, ctl.steps)
    if (r.isOk() || r.unwrapErr().code !== 'geometry.evaluation') return r
    return compareHeightmap(
      placed,
      input.part,
      opts,
      ctl.steps,
      `the solid library refused the meshes (${r.unwrapErr().message})`,
    )
  },
}

export const WORKER_TASKS: readonly AnyWorkerTask[] = [
  geometryEvaluate,
  toolpathGenerate,
  stlParse,
  stlMesh,
  referenceSection,
  referenceLevels,
  referenceHoles,
  referenceCompare,
  svgImportTask,
]
