/**
 * The production worker tasks. The worker entry registers `WORKER_TASKS`; the test entry adds
 * fixtures. Doc: docs/architecture/workers.md#what-runs-on-a-worker
 */
import { z } from 'zod'
import { Err, tryAsync, type AppResult } from '../../shared/result'
import type { AnyWorkerTask, WorkerTask } from '../commands/jobs'
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

/** The triangles of an STL for the reference ghost: 9 float32 per triangle, source units. */
export interface StlMesh {
  readonly positions: Float32Array
}

/**
 * Reads a stored reference's triangles for the viewport ghost (task R3,
 * docs/modes/reference-model.md#ghost-mesh-task-r3): the same streamed parser as `stlParse`, with
 * a sink that keeps every triangle. `triangles` (the record's count) sizes the buffer once; the
 * positions are transferred to the host, never cloned.
 */
export const stlMesh: WorkerTask<{ path: string; triangles: number }, StlMesh> = {
  name: 'reference.meshStl',
  lane: 'geometry',
  input: z.object({
    path: z.string().min(1),
    triangles: z.number().int().positive().max(STL_LIMITS.maxTriangles),
  }),
  output: z.object({ positions: z.instanceof(Float32Array) }),
  timeoutMs: 120_000,
  transfer: (m) => [m.positions],
  async run({ path, triangles }, ctl) {
    const opened = await ctl.files.open(path)
    if (opened.isErr()) return opened
    const { size, chunks } = opened.unwrap()
    const keep = new StlPositions(triangles)
    const created = createStlParser(size, STL_LIMITS, keep.add)
    if (created.isErr()) return created
    const parser = created.unwrap()
    const read = await tryAsync(
      async (): Promise<AppResult<StlMesh>> => {
        let done = 0
        for await (const chunk of chunks) {
          const step = ctl.steps.step({ done, total: size, label: 'Reading STL' })
          if (step.isErr()) return step
          const pushed = parser.push(chunk)
          if (pushed.isErr()) return pushed
          done += chunk.length
        }
        return parser.finish().map(() => ({ positions: keep.positions() }))
      },
      'persist.io',
      'reading the STL file failed',
    )
    return read.isOk() ? read.unwrap() : Err(read.unwrapErr().withContext('reference.meshStl'))
  },
}

export const WORKER_TASKS: readonly AnyWorkerTask[] = [
  geometryEvaluate,
  toolpathGenerate,
  stlParse,
  stlMesh,
  svgImportTask,
]
