/**
 * `GeneratorRequest`: the generator inputs of one plan operation (the `toolpath.generate` worker
 * task's input) and running it. Doc: docs/architecture/workers.md#plan-operation-to-generator-input
 *
 * Built in the host by `toGeneratorInputs` (inputs.ts); run in the worker. Drilling holds one
 * input per hole, in visiting order; their toolpaths are joined into one.
 */
import { z } from 'zod'
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import { noSteps, type Steps } from '../workers/steps'
import { generateDrilling } from './drilling'
import { generateFacing } from './facing'
import type { DrillingInput, FacingInput, Pass, PocketInput, ProfileInput, Toolpath } from './model'
import { generatePocket } from './pocket'
import { generateProfile } from './profile'
import {
  DrillingInputSchema,
  FacingInputSchema,
  PocketInputSchema,
  ProfileInputSchema,
} from './schemas'
import { toolpathStats } from './stats'
import { turnToolpath, type SetupWcs } from './wcs'
import { Vec2Schema } from '../geometry/schemas'

export type GeneratorRequest = (
  | { readonly kind: 'facing'; readonly inputs: readonly FacingInput[] }
  | { readonly kind: 'pocket'; readonly inputs: readonly PocketInput[] }
  | { readonly kind: 'drilling'; readonly inputs: readonly DrillingInput[] }
  | { readonly kind: 'profile'; readonly inputs: readonly ProfileInput[] }
) & {
  /**
   * The setup's quarter turn (v0.2 task C3): the inputs are in the face frame, the toolpath is
   * turned into the setup's WCS after generation. Absent = the face frame is the WCS.
   */
  readonly wcs?: SetupWcs
}

const one = <S extends z.ZodType>(s: S) => z.array(s).length(1).readonly()

const wcs = z
  .object({ rotation: z.union([z.literal(90), z.literal(180), z.literal(270)]), size: Vec2Schema })
  .exactOptional()

export const GeneratorRequestSchema: z.ZodType<GeneratorRequest> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('facing'), inputs: one(FacingInputSchema), wcs }),
  z.object({ kind: z.literal('pocket'), inputs: one(PocketInputSchema), wcs }),
  z.object({
    kind: z.literal('drilling'),
    inputs: z.array(DrillingInputSchema).min(1).readonly(),
    wcs,
  }),
  z.object({ kind: z.literal('profile'), inputs: one(ProfileInputSchema), wcs }),
])

/**
 * The toolpath of one plan operation in the setup's WCS; `steps` per level/pass, and per hole
 * for drilling.
 */
export function generateRequest(
  request: GeneratorRequest,
  steps: Steps = noSteps,
): AppResult<Toolpath> {
  const tp = generateLocal(request, steps)
  const turn = request.wcs
  if (turn === undefined) return tp
  return tp.map((t) => turnToolpath(t, turn, request.inputs[0]?.maxFeedRate))
}

/** The toolpath in the face frame (generators are top-down). */
function generateLocal(request: GeneratorRequest, steps: Steps): AppResult<Toolpath> {
  switch (request.kind) {
    case 'facing':
      return generateFacing(request.inputs[0]!, steps)
    case 'pocket':
      return generatePocket(request.inputs[0]!, steps)
    case 'profile':
      return generateProfile(request.inputs[0]!, steps)
    case 'drilling':
      return generateHoles(request.inputs, steps)
  }
}

/**
 * One drilling toolpath per hole, joined: passes concatenated (each hole starts and ends at
 * clearance), stats recomputed over all of them.
 */
function generateHoles(inputs: readonly DrillingInput[], steps: Steps): AppResult<Toolpath> {
  const first = inputs[0]
  if (first === undefined)
    return fail('internal.unexpected', 'drilling request without holes', {
      where: 'generateRequest',
    })
  const passes: Pass[] = []
  for (const [i, input] of inputs.entries()) {
    const step = steps.step({
      done: i,
      total: inputs.length,
      label: `hole ${i + 1}/${inputs.length}`,
    })
    if (step.isErr()) return Err(step.unwrapErr())
    const tp = generateDrilling(input, steps)
    if (tp.isErr()) return Err(tp.unwrapErr().withContext('generateRequest', { hole: i }))
    passes.push(...tp.unwrap().passes)
  }
  return Ok({
    planOperationId: first.planOperationId,
    tool: first.tool.id,
    spindleSpeed: first.cutting.spindleSpeed,
    passes,
    stats: toolpathStats(passes, first.maxFeedRate),
  })
}
