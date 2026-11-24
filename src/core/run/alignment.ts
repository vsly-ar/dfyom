/**
 * The Run alignment step (hardening DF78, alignment phase 1 A7/A10), pure part: the step's entries
 * (the work zero, then the setup's alignment points with their WCS targets), the pointer's jog
 * moves to an entry (Z up to the clearance height, then X/Y), the tick and confirm rules, and how
 * a status change keeps or clears the ticks. The state lives on the machine port
 * (`MachineService.alignment`) and shows in `RunStatus.alignment`; `align-commands.ts` drives it.
 * Pure, headless.
 * Doc: docs/modes/alignment.md#run-the-alignment-step, #ticks-and-the-confirm-gate, #state
 */
import { z } from 'zod'
import { fail, Ok, type AppResult } from '../../shared/result'
import { setupAlignment } from '../plan/alignment'
import type { LoadedPlan } from '../plan/plan'
import type { SetupDTO } from '../plan/plan.dto'
import type { Region2dPort } from '../geometry/2d/port'

/** The pointer is at an entry within this (mm) of its target, WCS X/Y. */
export const AT_ENTRY_MM = 0.01
/** A G54 X/Y change larger than this (mm) clears every tick. */
const ZERO_EPS = 1e-4
/** Jog feeds of the pointer's moves (mm/min); GRBL caps them at the machine's max rates. */
export const POINTER_FEED = { xy: 2000, z: 500 } as const
/** The pointer's Z never goes higher than this below machine zero (mm). */
const TOP_MARGIN = 0.5

const Xy = z.tuple([z.number(), z.number()])

export const AlignmentEntrySchema = z.object({
  /** `zero` or an alignment point id. */
  id: z.string(),
  name: z.string(),
  /** WCS X, Y (mm). */
  target: Xy,
  ticked: z.boolean(),
})
export type AlignmentEntry = z.output<typeof AlignmentEntrySchema>

/** `RunStatus.alignment` (docs/modes/alignment.md#state). */
export const AlignmentStepSchema = z.object({
  planId: z.string(),
  setupId: z.string(),
  entries: z.array(AlignmentEntrySchema),
  /** The entry the pointer was last sent to. */
  current: z.string().exactOptional(),
  confirmed: z.boolean(),
  /** Entries confirmed without a tick. */
  skipped: z.array(z.string()),
  /** G54 X, Y (machine mm) the ticks were taken at; a change clears them. */
  zeroAt: Xy,
})
export type AlignmentStep = z.output<typeof AlignmentStepSchema>

/** What the step reads of the run status. */
export interface StepStatus {
  readonly connection: { readonly state: string }
  readonly state: string
  readonly homed: boolean
  readonly mpos: readonly [number, number, number]
  readonly wpos: readonly [number, number, number]
  readonly workZero: readonly [number, number, number]
  readonly spindle: number
  readonly zeroLevel?: number | undefined
}

/**
 * The step's entries for a setup: the work zero (WCS 0, 0), then its alignment points in cycle
 * order; a point whose source is missing is left out (its error blocks the export already).
 */
export function alignmentEntries(
  plan: LoadedPlan,
  setup: SetupDTO,
  port?: Region2dPort,
): AlignmentEntry[] {
  const a = setupAlignment(plan, setup, port)
  return [
    { id: 'zero', name: 'Work zero', target: [0, 0], ticked: false },
    ...a.points.flatMap((p) =>
      p.wcs === undefined
        ? []
        : [
            {
              id: p.id,
              name: p.name,
              target: [p.wcs[0], p.wcs[1]] as [number, number],
              ticked: false,
            },
          ],
    ),
  ]
}

/** A new step at the current G54. */
export function startStep(
  planId: string,
  setupId: string,
  entries: readonly AlignmentEntry[],
  status: Pick<StepStatus, 'workZero'>,
): AlignmentStep {
  return {
    planId,
    setupId,
    entries: entries.map((e) => ({ ...e, target: [e.target[0], e.target[1]], ticked: false })),
    confirmed: false,
    skipped: [],
    zeroAt: [status.workZero[0], status.workZero[1]],
  }
}

/**
 * The step after a status report: dropped when the connection closed, the machine lost its
 * position (alarm, not homed); every tick and the confirmation cleared when G54 X or Y moved
 * (from any source), `zeroAt` then the new G54.
 */
export function reconcileStep(
  step: AlignmentStep | undefined,
  status: StepStatus,
): AlignmentStep | undefined {
  if (step === undefined) return undefined
  if (status.connection.state !== 'open' || !status.homed || status.state.startsWith('Alarm'))
    return undefined
  const [x, y] = status.workZero
  if (Math.abs(x - step.zeroAt[0]) <= ZERO_EPS && Math.abs(y - step.zeroAt[1]) <= ZERO_EPS)
    return step
  return {
    ...step,
    entries: step.entries.map((e) => ({ ...e, ticked: false })),
    confirmed: false,
    skipped: [],
    zeroAt: [x, y],
  }
}

/** Where `next` / `previous` / an id leads from the current entry (wrapping), or undefined. */
export function entryTo(
  step: Pick<AlignmentStep, 'entries' | 'current'>,
  to: string,
): AlignmentEntry | undefined {
  const n = step.entries.length
  if (to !== 'next' && to !== 'previous') return step.entries.find((e) => e.id === to)
  const i = step.entries.findIndex((e) => e.id === step.current)
  if (i < 0) return step.entries[0]
  return step.entries[(i + (to === 'next' ? 1 : -1) + n) % n]
}

/** Moving the pointer is allowed: Idle, homed, spindle off (rules `state`, `spindleOn`). */
export function pointerReady(status: StepStatus, where: string): AppResult<void> {
  if (status.spindle > 0)
    return fail('run.state', 'switch the spindle off before the pointer moves', {
      where,
      data: { state: status.state, spindle: status.spindle },
      issues: [{ path: [], rule: 'spindleOn', message: 'the spindle turns' }],
    })
  if (status.state !== 'Idle' || !status.homed)
    return fail(
      'run.state',
      `the machine must be Idle and homed (is ${status.state}${status.homed ? '' : ', not homed'})`,
      { where, data: { state: status.state, homed: status.homed } },
    )
  return Ok(undefined)
}

/** One jog of the pointer (machine coordinates, mm; feed mm/min). */
export interface PointerMove {
  readonly to: readonly [number, number, number]
  readonly feed: number
}

/**
 * The jogs to an entry's target (WCS X/Y): up to the clearance height above the surface G54 Z is
 * on (`min(G54.z − zeroLevel + clearance, −0.5)`, never lower than now), then X/Y at that height.
 * None when the pointer is there already.
 */
export function pointerMoves(
  status: Pick<StepStatus, 'mpos' | 'workZero' | 'zeroLevel'>,
  target: readonly [number, number],
  clearance: number,
): PointerMove[] {
  const [x, y, z0] = status.mpos
  const tx = status.workZero[0] + target[0]
  const ty = status.workZero[1] + target[1]
  if (Math.abs(x - tx) <= AT_ENTRY_MM && Math.abs(y - ty) <= AT_ENTRY_MM) return []
  const safe = Math.min(status.workZero[2] - (status.zeroLevel ?? 0) + clearance, -TOP_MARGIN)
  const up = Math.max(z0, safe)
  return [
    ...(up > z0 + 1e-6 ? [{ to: [x, y, up] as const, feed: POINTER_FEED.z }] : []),
    { to: [tx, ty, up] as const, feed: POINTER_FEED.xy },
  ]
}

/** Whether the pointer (WPos) is at the entry's target. */
export const atEntry = (status: Pick<StepStatus, 'wpos'>, entry: AlignmentEntry): boolean =>
  Math.abs(status.wpos[0] - entry.target[0]) <= AT_ENTRY_MM &&
  Math.abs(status.wpos[1] - entry.target[1]) <= AT_ENTRY_MM

/**
 * Ticks or un-ticks an entry (rule `notAtPoint`: a tick needs the pointer there). Any tick change
 * withdraws a confirmation.
 */
export function tickEntry(
  step: AlignmentStep,
  id: string,
  ticked: boolean,
  status: Pick<StepStatus, 'wpos'>,
  where: string,
): AppResult<AlignmentStep> {
  const entry = step.entries.find((e) => e.id === id)
  if (entry === undefined)
    return fail('input.malformed', `the step has no entry ${id}`, {
      where,
      issues: [{ path: ['entry'], rule: 'unknownEntry', message: 'not an entry of this step' }],
    })
  if (ticked && !atEntry(status, entry))
    return fail('run.state', `go to ${entry.name} first`, {
      where,
      data: { entry: id },
      issues: [
        { path: ['entry'], rule: 'notAtPoint', message: `the pointer is not at ${entry.name}` },
      ],
    })
  return Ok({
    ...step,
    entries: step.entries.map((e) => (e.id === id ? { ...e, ticked } : e)),
    confirmed: false,
    skipped: [],
  })
}

/** Confirms the step; unticked entries need `skipUnticked` (rule `unticked`) and are recorded. */
export function confirmStep(
  step: AlignmentStep,
  skipUnticked: boolean,
  where: string,
): AppResult<AlignmentStep> {
  const unticked = step.entries.filter((e) => !e.ticked).map((e) => e.id)
  if (unticked.length > 0 && !skipUnticked)
    return fail(
      'run.state',
      `${unticked.length} of ${step.entries.length} entries are not checked`,
      {
        where,
        data: { unticked },
        issues: [{ path: ['confirm'], rule: 'unticked', message: 'check them or skip them' }],
      },
    )
  return Ok({ ...step, confirmed: true, skipped: unticked })
}

/**
 * The gate of `run.job.start` (AL3, every connection): a setup with alignment points runs only
 * after its step was confirmed at the current G54 (rule `alignmentPending`).
 */
export function alignmentGate(
  step: AlignmentStep | undefined,
  planId: string,
  setup: SetupDTO,
  status: Pick<StepStatus, 'workZero'>,
  where: string,
): AppResult<void> {
  if ((setup.alignment?.length ?? 0) === 0) return Ok(undefined)
  const same =
    step !== undefined &&
    step.planId === planId &&
    step.setupId === setup.id &&
    step.confirmed &&
    Math.abs(step.zeroAt[0] - status.workZero[0]) <= ZERO_EPS &&
    Math.abs(step.zeroAt[1] - status.workZero[1]) <= ZERO_EPS
  if (same) return Ok(undefined)
  const unticked =
    step?.setupId === setup.id ? step.entries.filter((e) => !e.ticked).map((e) => e.id) : []
  return fail(
    'run.state',
    `align ${setup.name} first: point at the zero and its points, then confirm`,
    {
      where,
      data: { setupId: setup.id, unticked },
      issues: [{ path: ['setupId'], rule: 'alignmentPending', message: 'alignment not confirmed' }],
    },
  )
}
