/**
 * `GeneratorRequest`: the generator inputs of one plan operation (the `toolpath.generate` worker
 * task's input) and running it. Doc: docs/architecture/workers.md#plan-operation-to-generator-input
 *
 * Built in the host by `toGeneratorInputs` (inputs.ts); run in the worker. Drilling holds one
 * input per hole, in visiting order (chamfers, v0.4 T1, likewise one per chamfer); their toolpaths
 * are joined into one; a partly cleared `regionPocket` holds two (the uncovered part above the
 * cleared level, then the whole region), joined likewise. `regionPocket` and
 * `regionProfile` (v0.3 T1/T2 wiring) carry general shapes; their generators take the 2D port of
 * the worker (`TaskControl.region2d()`). Doc: docs/modes/plan-v0.3.md#wiring-t1-t2
 */
import { z } from 'zod'
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import type { Region2dPort } from '../geometry/2d/port'
import { noSteps, type Steps } from '../workers/steps'
import { generateChamfer } from './chamfer'
import { generateEdgeChamfer, type EdgeChamferInput } from './edge-chamfer'
import { generateMark, type MarkInput } from './mark'
import { generateLine, type LineInput } from './line'
import { generateDrilling } from './drilling'
import { generateFacing } from './facing'
import type {
  ChamferInput,
  DrillingInput,
  FacingInput,
  GeneratorInput,
  Pass,
  PocketInput,
  ProfileInput,
  Toolpath,
} from './model'
import { generatePocket } from './pocket'
import { generateProfile } from './profile'
import { generateRegionPocket, type RegionPocketInput } from './region-pocket'
import { generateRegionProfile, type RegionProfileInput } from './region-profile'
import {
  ChamferInputSchema,
  DrillingInputSchema,
  EdgeChamferInputSchema,
  FacingInputSchema,
  MarkInputSchema,
  LineInputSchema,
  PocketInputSchema,
  ProfileInputSchema,
  RegionPocketInputSchema,
  RegionProfileInputSchema,
} from './schemas'
import { toolpathStats } from './stats'
import { turnToolpath, type SetupWcs } from './wcs'
import type { Unmachined } from './keep-out'
import { Vec2Schema } from '../geometry/schemas'

/**
 * A clone group (hardening DF146) of a kind cut one operation at a time (facing, pocket, profile,
 * Line, edge chamfer): each instance's own request, generated in turn and joined in path order
 * (each part starts and ends at clearance), every pass named by its design operation.
 * Doc: docs/modes/features.md#implementation-df146
 */
export interface GroupRequest {
  readonly kind: 'group'
  readonly parts: readonly SingleRequest[]
  /** The design operation each part machines (its passes' `operationId`), as `parts`. */
  readonly operationIds: readonly string[]
  /** The parts' unmachined material (WH-D), host side only. */
  readonly unmachined?: readonly Unmachined[]
}

export type GeneratorRequest = SingleRequest | GroupRequest

/** The request of one plan operation over one generator kind. */
export type SingleRequest = (
  | { readonly kind: 'facing'; readonly inputs: readonly FacingInput[] }
  | { readonly kind: 'pocket'; readonly inputs: readonly PocketInput[] }
  | { readonly kind: 'drilling'; readonly inputs: readonly DrillingInput[] }
  | { readonly kind: 'profile'; readonly inputs: readonly ProfileInput[] }
  | { readonly kind: 'regionPocket'; readonly inputs: readonly RegionPocketInput[] }
  | { readonly kind: 'regionProfile'; readonly inputs: readonly RegionProfileInput[] }
  | { readonly kind: 'chamfer'; readonly inputs: readonly ChamferInput[] }
  | { readonly kind: 'edgeChamfer'; readonly inputs: readonly EdgeChamferInput[] }
  | { readonly kind: 'mark'; readonly inputs: readonly MarkInput[] }
  | { readonly kind: 'line'; readonly inputs: readonly LineInput[] }
) & {
  /**
   * The setup's quarter turn (v0.2 task C3) and work zero (alignment phase 1): the inputs are in
   * the face frame, the toolpath is turned and shifted into the setup's WCS after generation.
   * Absent = the face frame is the WCS.
   */
  readonly wcs?: SetupWcs
  /**
   * Material a facing or pocket leaves under workholding (WH-D, face frame), for the
   * `plan.workholding.unmachined` finding; host side only (the worker ignores it).
   */
  readonly unmachined?: readonly Unmachined[]
}

const one = <S extends z.ZodType>(s: S) => z.array(s).length(1).readonly()

const wcs = z
  .object({
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    size: Vec2Schema,
    zero: Vec2Schema.exactOptional(),
  })
  .exactOptional()

const SingleRequestSchema: z.ZodType<SingleRequest> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('facing'), inputs: one(FacingInputSchema), wcs }),
  z.object({ kind: z.literal('pocket'), inputs: one(PocketInputSchema), wcs }),
  z.object({
    kind: z.literal('drilling'),
    inputs: z.array(DrillingInputSchema).min(1).readonly(),
    wcs,
  }),
  z.object({ kind: z.literal('profile'), inputs: one(ProfileInputSchema), wcs }),
  z.object({
    kind: z.literal('regionPocket'),
    inputs: z.array(RegionPocketInputSchema).min(1).max(2).readonly(),
    wcs,
  }),
  z.object({ kind: z.literal('regionProfile'), inputs: one(RegionProfileInputSchema), wcs }),
  z.object({
    kind: z.literal('chamfer'),
    inputs: z.array(ChamferInputSchema).min(1).readonly(),
    wcs,
  }),
  z.object({ kind: z.literal('edgeChamfer'), inputs: one(EdgeChamferInputSchema), wcs }),
  z.object({ kind: z.literal('mark'), inputs: one(MarkInputSchema), wcs }),
  // DF147 SL4: a one-sided chamfer's rings, one Line each
  z.object({ kind: z.literal('line'), inputs: z.array(LineInputSchema).min(1).readonly(), wcs }),
])

export const GeneratorRequestSchema: z.ZodType<GeneratorRequest> = z.union([
  SingleRequestSchema,
  z
    .object({
      kind: z.literal('group'),
      parts: z.array(SingleRequestSchema).min(1).readonly(),
      operationIds: z.array(z.string()).readonly(),
    })
    .refine((g) => g.parts.length === g.operationIds.length, {
      message: 'one operation id per part',
    }),
])

/** The 2D port of the worker, loaded on first use; the region generators need it. */
export type PortSource = () => AppResult<Region2dPort>

const noPort: PortSource = () =>
  fail('internal.unexpected', 'no 2D port for a region generator', { where: 'generateRequest' })

/**
 * The toolpath of one plan operation in the setup's WCS; `steps` per level/pass, and per hole
 * for drilling.
 */
export function generateRequest(
  request: GeneratorRequest,
  steps: Steps = noSteps,
  region2d: PortSource = noPort,
): AppResult<Toolpath> {
  if (request.kind === 'group') return generateGroup(request, steps, region2d)
  const tp = generateLocal(request, steps, region2d)
  const turn = request.wcs
  if (turn === undefined) return tp
  return tp.map((t) => turnToolpath(t, turn, request.inputs[0]?.maxFeedRate))
}

/**
 * A clone group's toolpath (DF146): each part in the setup's WCS, in turn, joined; stats over
 * all of them. Each pass names its instance's design operation (position comments, P-E).
 */
function generateGroup(
  request: GroupRequest,
  steps: Steps,
  region2d: PortSource,
): AppResult<Toolpath> {
  const passes: Pass[] = []
  let first: Toolpath | undefined
  for (const [i, part] of request.parts.entries()) {
    const total = request.parts.length
    const step = steps.step({ done: i, total, label: `instance ${i + 1}/${total}` })
    if (step.isErr()) return Err(step.unwrapErr())
    const tp = generateRequest(part, steps, region2d)
    if (tp.isErr()) return Err(tp.unwrapErr().withContext('generateRequest', { instance: i }))
    first ??= tp.unwrap()
    const operationId = request.operationIds[i]
    passes.push(
      ...tp.unwrap().passes.map((p) => (operationId === undefined ? p : { ...p, operationId })),
    )
  }
  if (first === undefined)
    return fail('internal.unexpected', 'a clone group without parts', { where: 'generateRequest' })
  return Ok({
    ...first,
    passes,
    stats: toolpathStats(passes, request.parts[0]?.inputs[0]?.maxFeedRate),
  })
}

/** The toolpath in the face frame (generators are top-down). */
function generateLocal(
  request: SingleRequest,
  steps: Steps,
  region2d: PortSource,
): AppResult<Toolpath> {
  switch (request.kind) {
    case 'facing':
      return generateFacing(request.inputs[0]!, steps)
    case 'pocket':
      return generatePocket(request.inputs[0]!, steps)
    case 'profile':
      return generateProfile(request.inputs[0]!, steps)
    case 'drilling':
      return joined(request.inputs, generateDrilling, 'hole', steps)
    case 'chamfer':
      return joined(request.inputs, generateChamfer, 'chamfer', steps)
    case 'mark':
      return generateMark(request.inputs[0]!, steps)
    case 'line':
      // DF147 SL4: a one-sided chamfer's rings, joined
      return request.inputs.length === 1
        ? generateLine(request.inputs[0]!, steps)
        : joined(request.inputs, generateLine, 'chamfer', steps)
    case 'edgeChamfer': {
      const input = request.inputs[0]!
      return region2d().andThen((port) => generateEdgeChamfer(input, port, steps))
    }
    case 'regionPocket':
      return region2d().andThen((port) => {
        // a partly cleared pocket (DF61 follow-up): the uncovered part above the cleared level,
        // then the whole region below it, as one toolpath
        const parts: Toolpath[] = []
        for (const input of request.inputs) {
          const tp = generateRegionPocket(input, port, steps)
          if (tp.isErr()) return tp
          parts.push(tp.unwrap())
        }
        const first = parts[0]!
        if (parts.length === 1) return Ok(first)
        const passes = parts.flatMap((t) => t.passes)
        return Ok({
          ...first,
          passes,
          stats: toolpathStats(passes, request.inputs[0]!.maxFeedRate),
        })
      })
    case 'regionProfile': {
      const input = request.inputs[0]!
      return region2d().andThen((port) => generateRegionProfile(input, port, steps))
    }
  }
}

/**
 * One toolpath per hole (or chamfer), joined: passes concatenated (each starts and ends at
 * clearance), stats recomputed over all of them.
 */
function joined<
  I extends GeneratorInput<{ readonly id: string }, unknown, { spindleSpeed: number }>,
>(
  inputs: readonly I[],
  generate: (input: I, steps: Steps) => AppResult<Toolpath>,
  what: 'hole' | 'chamfer',
  steps: Steps,
): AppResult<Toolpath> {
  const first = inputs[0]
  if (first === undefined)
    return fail('internal.unexpected', `request without a ${what}`, { where: 'generateRequest' })
  const passes: Pass[] = []
  for (const [i, input] of inputs.entries()) {
    const step = steps.step({
      done: i,
      total: inputs.length,
      label: `${what} ${i + 1}/${inputs.length}`,
    })
    if (step.isErr()) return Err(step.unwrapErr())
    const tp = generate(input, steps)
    if (tp.isErr()) return Err(tp.unwrapErr().withContext('generateRequest', { [what]: i }))
    // each pass names its hole or chamfer (clone position comments, plan-v0.4.md P-E)
    passes.push(...tp.unwrap().passes.map((p) => ({ ...p, operationId: input.operation.id })))
  }
  return Ok({
    planOperationId: first.planOperationId,
    tool: first.tool.id,
    spindleSpeed: first.cutting.spindleSpeed,
    passes,
    stats: toolpathStats(passes, first.maxFeedRate),
  })
}
