/**
 * The production worker tasks. The worker entry registers `WORKER_TASKS`; the test entry adds
 * fixtures. Doc: docs/architecture/workers.md#what-runs-on-a-worker
 */
import { z } from 'zod'
import { Err, tryAsync, type AppResult } from '../../shared/result'
import type { AnyWorkerTask, TaskControl, WorkerTask } from '../commands/jobs'
import { FEATURE_EDGE_DEG, featureEdges, meshSection } from '../design/mesh-section'
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
 * operations' solids, `SolidPort.kept`): ≈ 20–30 MB of WASM heap
 * (docs/architecture/geometry.md#wasm-lifetime-and-ownership).
 */
export const KEPT_TRIANGLES = 150_000

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
  run: (request, ctl) => generateRequest(request, ctl.steps, ctl.region2d),
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

/** The last mesh a section was cut from, kept in the worker: a new depth does not read again. */
let sectionMesh: { readonly path: string; readonly positions: Float32Array } | undefined

export interface SectionInput {
  readonly path: string
  readonly triangles: number
  /** Column-major 4 × 4: source units → the face frame (mm), the plane normal third. */
  readonly matrix: readonly number[]
  /** The plane's height in the face frame (mm): the face's level minus the section depth. */
  readonly level: number
}

/**
 * The reference section (task U3, docs/modes/design-v0.3.md#measure-and-snap): a stored
 * reference's mesh cut by a face-parallel plane, as segments in the face frame (mm). The mesh is
 * read once per file and kept for the next depth; only the segments leave the worker.
 */
export const referenceSection: WorkerTask<SectionInput, { segments: Float32Array }> = {
  name: 'reference.section',
  lane: 'geometry',
  input: StlReadSchema.extend({ matrix: z.array(z.number()).length(16), level: z.number() }),
  output: z.object({ segments: z.instanceof(Float32Array) }),
  timeoutMs: 120_000,
  transfer: (r) => [r.segments],
  async run({ path, triangles, matrix, level }, ctl) {
    if (sectionMesh?.path !== path) {
      const read = await readStlPositions(path, triangles, ctl, 'reference.section')
      if (read.isErr()) return read
      sectionMesh = { path, positions: read.unwrap() }
    }
    return meshSection(sectionMesh.positions, matrix, level, ctl.steps).map((segments) => ({
      segments,
    }))
  },
}

export const WORKER_TASKS: readonly AnyWorkerTask[] = [
  geometryEvaluate,
  toolpathGenerate,
  stlParse,
  stlMesh,
  referenceSection,
  svgImportTask,
]
