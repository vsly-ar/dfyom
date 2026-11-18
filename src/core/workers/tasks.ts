/**
 * The production worker tasks. The worker entry registers `WORKER_TASKS`; the test entry adds
 * fixtures. Doc: docs/architecture/workers.md#what-runs-on-a-worker
 */
import { Err } from '../../shared/result'
import type { AnyWorkerTask, WorkerTask } from '../commands/jobs'
import { evaluatePart, type PartEvaluation } from '../geometry/evaluate'
import type { PartGeometryInput } from '../geometry/model'
import { PartEvaluationSchema, PartGeometryInputSchema } from '../geometry/schemas'
import type { Toolpath } from '../toolpath/model'
import { generateRequest, GeneratorRequestSchema, type GeneratorRequest } from '../toolpath/request'
import { ToolpathSchema } from '../toolpath/schemas'

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
    return kernel.unwrap().withSolids((s) => evaluatePart(input, s, ctl.steps))
  },
}

/** The toolpath of one plan operation (`GeneratorRequest`) in the toolpath lane. */
export const toolpathGenerate: WorkerTask<GeneratorRequest, Toolpath> = {
  name: 'toolpath.generate',
  lane: 'toolpath',
  input: GeneratorRequestSchema,
  output: ToolpathSchema,
  timeoutMs: 60_000,
  run: (request, ctl) => generateRequest(request, ctl.steps),
}

export const WORKER_TASKS: readonly AnyWorkerTask[] = [geometryEvaluate, toolpathGenerate]
