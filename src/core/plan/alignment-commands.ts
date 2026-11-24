/**
 * Alignment phase 1 commands (hardening DF78): `plan.alignment.set` (a setup's alignment points)
 * and the work zero of `plan.setup.update { zero }` (`applySetupZero`), plus the per-setup view
 * `plan.warning.list` and `plan_get` carry.
 * Doc: docs/modes/alignment.md#commands, docs/modes/alignment.md#implementation-slice-1
 */
import type { Draft } from 'immer'
import { z } from 'zod'
import { collect, Err, fail, Ok, type AppResult } from '../../shared/result'
import { fieldContext } from '../design/operation'
import { Quantity } from '../quantity/quantity'
import type { UnitSystem } from '../project/document'
import { defineCommand } from '../commands/define'
import type { Region2dPort } from '../geometry/2d/port'
import type { ProjectDoc } from '../project/document'
import { planFlipAxes } from './aids'
import { alignmentFindings, setupAlignment, setupZero } from './alignment'
import {
  ALIGNMENT_POINTS_MAX,
  AlignmentSourceDtoSchema,
  ZERO_LIMIT_MM,
  type AlignmentPointDTO,
  type SetupZeroDTO,
} from './alignment.dto'
import { findPlanDTO, loadPlanDTO, type LoadedPlan } from './plan'
import { PlanIdSchema, PlanRecordIdSchema, type PlanDTO } from './plan.dto'
import { unknownSetup } from './setups'
import { checkAllowed } from './status'

const Xy = z.tuple([z.number(), z.number()])

/** A setup's zero and points as `plan.warning.list` and `plan_get` show them (mm). */
export const SetupAlignmentSchema = z.object({
  setupId: z.string(),
  zero: z.tuple([z.number(), z.number()]).describe('Work zero X, Y in the setup frame (mm)'),
  zeroPoint: z.string().optional().describe('The alignment point the zero is on'),
  points: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(['point', 'hole', 'edge']),
      wcs: z
        .tuple([z.number(), z.number()])
        .nullable()
        .describe('Expected X, Y in the WCS (mm); null = source missing'),
      oneAxis: z
        .enum(['x', 'y'])
        .optional()
        .describe('A mark on a side face: it checks this axis only (Q108)'),
    }),
  ),
  flipAxes: z
    .array(
      z.object({
        from: Xy,
        to: Xy,
        otherSetupId: z.string().describe('The setup on the other side of the flip'),
      }),
    )
    .optional()
    .describe('Flip axes of registration holes, in the setup frame (mm; Q106)'),
})

const r3 = (v: number) => Math.round(v * 1000) / 1000 || 0

/** The view of every setup that has a zero, points or a flip axis (empty for a plain plan). */
export function alignmentView(
  plan: LoadedPlan,
  port?: Region2dPort,
): z.output<typeof SetupAlignmentSchema>[] {
  const axes = planFlipAxes(plan)
  const xy = (p: readonly [number, number]): [number, number] => [r3(p[0]), r3(p[1])]
  const axesOf = (id: string) => [
    ...axes
      .filter((x) => x.setupId === id)
      .map((x) => ({ from: xy(x.axis.from), to: xy(x.axis.to), otherSetupId: x.laterSetupId })),
    ...axes
      .filter((x) => x.laterSetupId === id)
      .map((x) => ({
        from: xy(x.axis.later.from),
        to: xy(x.axis.later.to),
        otherSetupId: x.setupId,
      })),
  ]
  return plan.setups
    .filter(
      (s) => s.zero !== undefined || (s.alignment?.length ?? 0) > 0 || axesOf(s.id).length > 0,
    )
    .map((s) => {
      const a = setupAlignment(plan, s, port)
      const flips = axesOf(s.id)
      return {
        setupId: s.id,
        zero: [r3(a.zero[0]), r3(a.zero[1])],
        ...(a.zeroPoint === undefined ? {} : { zeroPoint: a.zeroPoint }),
        points: a.points.map((p) => ({
          id: p.id,
          name: p.name,
          kind: p.kind,
          wcs: p.wcs === undefined ? null : [r3(p.wcs[0]), r3(p.wcs[1])],
          ...(p.oneAxis === undefined ? {} : { oneAxis: p.oneAxis }),
        })),
        ...(flips.length === 0 ? {} : { flipAxes: flips }),
      }
    })
}

/** The next free `al<n>` id of the plan (ids are unique per plan, alignment.md § Alignment points). */
export function nextPointIds(plan: PlanDTO, count: number): string[] {
  let n = 0
  for (const s of plan.setups)
    for (const p of s.alignment ?? []) {
      const m = /^al(\d+)$/.exec(p.id)
      if (m !== null) n = Math.max(n, Number(m[1]))
    }
  return Array.from({ length: count }, (_, i) => `al${n + i + 1}`)
}

export function loaded(
  draft: Draft<ProjectDoc>,
  planId: string,
  where: string,
): AppResult<LoadedPlan> {
  const dto = findPlanDTO(draft as ProjectDoc, planId, where)
  if (dto.isErr()) return dto
  const allowed = checkAllowed(planId, dto.unwrap().status, where)
  if (allowed.isErr()) return Err(allowed.unwrapErr())
  return loadPlanDTO(dto.unwrap(), draft.unitSystem, where)
}

const Src = z.string().min(1).max(256)

/**
 * `plan.setup.update`'s `zero` arg: lengths as entered (project units), stored in mm
 * (`SetupZeroDtoSchema`).
 */
export const SetupZeroArgSchema = z
  .union([
    z.object({ at: z.tuple([Src, Src]) }).strict(),
    z.object({ point: PlanRecordIdSchema }).strict(),
  ])
  .nullable()
export type SetupZeroArg = z.output<typeof SetupZeroArgSchema>

/** The arg's lengths in mm (`input.malformed` / `model.invariant` issues under `zero.at`). */
function parseZero(
  arg: SetupZeroArg,
  units: UnitSystem,
  where: string,
): AppResult<SetupZeroDTO | null> {
  if (arg === null || 'point' in arg) return Ok(arg)
  const xy = collect(
    arg.at.map((src, k) =>
      Quantity.parse(src, fieldContext('length', units)).mapErr((e) =>
        e.prefixIssues('zero', 'at', k),
      ),
    ),
  )
  if (xy.isErr()) return Err(xy.unwrapErr().withContext(where))
  const [x, y] = xy.unwrap().map((q) => q.canonical) as [number, number]
  if (Math.abs(x) > ZERO_LIMIT_MM || Math.abs(y) > ZERO_LIMIT_MM)
    return fail(
      'plan.alignment',
      `the work zero must lie within ${ZERO_LIMIT_MM} mm of the corner`,
      {
        where,
        issues: [{ path: ['zero', 'at'], rule: 'range', message: 'too far from the stock' }],
      },
    )
  return Ok({ at: [x, y] })
}

/**
 * Sets a setup's work zero (`plan.setup.update { zero }`, Q61): `null` resets it to the corner.
 * Touch-off spots of the setup's tool runs (`zRef.at`, WCS) move with it so they stay on the same
 * place of the stock (S3). A `{ point }` must name one of the setup's points (`plan.alignment`,
 * rule `unknownPoint`).
 */
export function applySetupZero(
  draft: Draft<ProjectDoc>,
  planId: string,
  setupId: string,
  arg: SetupZeroArg,
  where: string,
  port?: Region2dPort,
): AppResult<void> {
  const parsed = parseZero(arg, draft.unitSystem, where)
  if (parsed.isErr()) return Err(parsed.unwrapErr())
  const zero = parsed.unwrap()
  const before = loaded(draft, planId, where)
  if (before.isErr()) return Err(before.unwrapErr())
  const setup = before.unwrap().setups.find((s) => s.id === setupId)
  if (setup === undefined) return unknownSetup(setupId, 'setupId', where)
  if (zero !== null && 'point' in zero && !(setup.alignment ?? []).some((p) => p.id === zero.point))
    return fail('plan.alignment', `${setup.name} has no alignment point ${zero.point}`, {
      where,
      issues: [{ path: ['zero', 'point'], rule: 'unknownPoint', message: 'no such point here' }],
    })
  const old = setupZero(before.unwrap(), setup, port)
  const target = draft.plans[planId]!.setups.find((s) => s.id === setupId)!
  if (zero === null || ('at' in zero && zero.at[0] === 0 && zero.at[1] === 0)) delete target.zero
  else target.zero = 'at' in zero ? { at: [zero.at[0], zero.at[1]] } : { point: zero.point }
  const after = loaded(draft, planId, where)
  if (after.isErr()) return Err(after.unwrapErr())
  const now = setupZero(after.unwrap(), target, port)
  const dx = old[0] - now[0]
  const dy = old[1] - now[1]
  if (dx !== 0 || dy !== 0)
    for (const op of target.operations)
      if (op.zRef?.at !== undefined) op.zRef.at = [r3(op.zRef.at[0] + dx), r3(op.zRef.at[1] + dy)]
  return Ok(undefined)
}

const PointInputSchema = z.object({
  id: PlanRecordIdSchema.optional().describe('Existing point; absent = new'),
  name: z.string().min(1).max(80).optional(),
  source: AlignmentSourceDtoSchema,
})

export const planAlignmentSet = defineCommand({
  kind: 'document',
  name: 'plan.alignment.set',
  summary:
    "Set a setup's alignment points (whole list, cycle order): stock corner, stock edge, or a hole or vertex of an earlier plan operation. Returns WCS X/Y and findings.",
  title: () => 'Set alignment points',
  machine: false,
  args: z.object({
    planId: PlanIdSchema,
    setupId: PlanRecordIdSchema,
    points: z.array(PointInputSchema).max(ALIGNMENT_POINTS_MAX),
  }),
  result: z.object({
    alignmentPointIds: z.array(z.string()),
    alignment: SetupAlignmentSchema.optional(),
    findings: z.array(
      z.object({ rule: z.string(), message: z.string(), alignmentPointId: z.string().optional() }),
    ),
  }),
  run(draft, args, ctx) {
    const where = 'plan.alignment.set'
    const port = ctx.services.region2d
    const before = loaded(draft, args.planId, where)
    if (before.isErr()) return before
    const plan = before.unwrap()
    const setup = plan.setups.find((s) => s.id === args.setupId)
    if (setup === undefined) return unknownSetup(args.setupId, 'setupId', where)
    const existing = new Set((setup.alignment ?? []).map((p) => p.id))
    const issues = args.points.flatMap((p, i) => {
      if (p.id !== undefined && !existing.has(p.id))
        return [
          { path: ['points', i, 'id'], rule: 'unknownPoint', message: 'not a point of this setup' },
        ]
      const s = p.source
      if ('operation' in s && !plan.operations.some((o) => o.id === s.operation))
        return [
          {
            path: ['points', i, 'source', 'operation'],
            rule: 'unknownPlanOperation',
            message: 'no such plan operation',
          },
        ]
      return []
    })
    const seen = new Set<string>()
    args.points.forEach((p, i) => {
      if (p.id === undefined) return
      if (seen.has(p.id))
        issues.push({ path: ['points', i, 'id'], rule: 'duplicate', message: 'listed twice' })
      seen.add(p.id)
    })
    if (issues.length > 0) return fail('plan.alignment', issues[0]!.message, { where, issues })
    const z0 = setup.zero
    if (z0 !== undefined && 'point' in z0 && !args.points.some((p) => p.id === z0.point))
      return fail('plan.alignment', 'the work zero is on a point this list drops; move it first', {
        where,
        issues: [
          {
            path: ['points'],
            rule: 'zeroPoint',
            message: 'the work zero is on this point',
            params: { alignmentPointId: z0.point },
          },
        ],
      })
    const fresh = nextPointIds(plan.dto, args.points.filter((p) => p.id === undefined).length)
    const points: AlignmentPointDTO[] = args.points.map((p) => ({
      id: p.id ?? fresh.shift()!,
      ...(p.name === undefined ? {} : { name: p.name }),
      source: p.source,
    }))
    const target = draft.plans[args.planId]!.setups.find((s) => s.id === args.setupId)!
    if (points.length === 0) delete target.alignment
    else target.alignment = points
    const after = loaded(draft, args.planId, where)
    if (after.isErr()) return after
    const view = alignmentView(after.unwrap(), port).find((v) => v.setupId === args.setupId)
    const findings = alignmentFindings(after.unwrap(), port)
      .filter((f) => f.params['setupId'] === args.setupId)
      .map((f) => ({
        rule: f.rule,
        message: f.message,
        ...(typeof f.params['alignmentPointId'] === 'string'
          ? { alignmentPointId: f.params['alignmentPointId'] }
          : {}),
      }))
    return Ok({
      alignmentPointIds: points.map((p) => p.id),
      ...(view === undefined ? {} : { alignment: view }),
      findings,
    })
  },
})
