/**
 * Alignment aids, commands (alignment phase 1 slice 2, hardening DF78): `plan.aid.set` (add,
 * update, remove, or place two with the helpers) and the order check every setup edit runs
 * (`checkAlignmentOrder`).
 * Doc: docs/modes/alignment.md#commands, docs/modes/alignment.md#implementation-slice-2
 */
import { z } from 'zod'
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import { defineCommand } from '../commands/define'
import { fieldContext } from '../design/operation'
import { Tool } from '../library/tool'
import type { UnitSystem } from '../project/document'
import { Quantity } from '../quantity/quantity'
import { flipPartner, isAid, nextAidName, suggestHoles, suggestMarks } from './aids'
import { alignmentFindings } from './alignment'
import { loaded, nextPointIds } from './alignment-commands'
import {
  AID,
  AID_KINDS,
  AidDtoSchema,
  ALIGNMENT_POINTS_MAX,
  type AidDTO,
  type AlignmentPointDTO,
} from './alignment.dto'
import { resolveAndAssign } from './build'
import { evaluateOperation } from './evaluate'
import { loadPlanDTO, type LoadedPlan } from './plan'
import {
  PlanIdSchema,
  PlanRecordIdSchema,
  type PlanDTO,
  type PlanOperationDTO,
  type SetupDTO,
} from './plan.dto'
import { setupDirection, setupRotation, unknownSetup } from './setups'

const Src = z.string().min(1).max(256)

/**
 * Setups after a move, split or merge (`writeSetups`): an aid stays in a setup of its frame (same
 * direction and rotation; `plan.aid`, rule `otherFrame`), and the change adds no `notYetCut`
 * point (`plan.alignment`, rule `notYetCut`; alignment.md § Amendment to plan-v0.2.md).
 */
export function checkAlignmentOrder(
  before: LoadedPlan,
  next: PlanDTO,
  units: UnitSystem,
  path: string,
  where: string,
): AppResult<void> {
  const frame = (s: SetupDTO) => `${setupDirection(s)} ${setupRotation(s)}`
  const frameOf = new Map<string, string>()
  for (const s of before.setups)
    for (const o of s.operations) if (isAid(o)) frameOf.set(o.id, frame(s))
  for (const s of next.setups)
    for (const o of s.operations) {
      const was = frameOf.get(o.id)
      if (was !== undefined && was !== frame(s))
        return fail('plan.aid', `${o.aid?.name ?? 'An aid'} must stay in a setup of its frame`, {
          where,
          issues: [
            {
              path: [path],
              rule: 'otherFrame',
              message: 'an aid is placed in its setup frame; add a new one in the other setup',
            },
          ],
        })
    }
  const hasPoints = before.setups.some((s) => (s.alignment?.length ?? 0) > 0)
  if (!hasPoints) return Ok(undefined)
  const after = loadPlanDTO(next, units, where)
  if (after.isErr()) return Err(after.unwrapErr())
  const notYetCut = (p: LoadedPlan) =>
    new Set(
      alignmentFindings(p)
        .filter((f) => f.rule === 'notYetCut')
        .map((f) => `${String(f.params['setupId'])}/${String(f.params['alignmentPointId'])}`),
    )
  const old = notYetCut(before)
  const added = [...notYetCut(after.unwrap())].filter((k) => !old.has(k))
  if (added.length === 0) return Ok(undefined)
  return fail('plan.alignment', 'an alignment point would come before the cut it checks', {
    where,
    issues: added.map((k) => ({
      path: [path],
      rule: 'notYetCut',
      message: 'a later setup aligns on what this order would cut after it',
      params: { alignmentPointId: k.split('/')[1]! },
    })),
  })
}

/** `plan.aid.set`'s `aid` arg: lengths as entered (project units), setup frame. */
const AidArgSchema = z
  .object({
    kind: z.enum(AID_KINDS).optional().describe('Required on add'),
    name: z.string().min(1).max(AID.nameMax).optional(),
    at: z.tuple([Src, Src]).optional().describe('Mark spot X, Y'),
    from: z.tuple([Src, Src]).optional().describe('Mark line start'),
    to: z.tuple([Src, Src]).optional().describe('Mark line end'),
    center: z.tuple([Src, Src]).optional().describe('Hole centre'),
    diameter: Src.optional().describe('Hole Ø; default 6.2 mm (6 mm dowel)'),
    markDiameter: Src.optional().describe('Mark Ø at the face; default 1 mm'),
    spoilboardDepth: Src.optional().describe('Below the stock; default 10 mm, max 15'),
  })
  .strict()
  .describe('X, Y in the setup frame (from the front-left corner of the up face)')
type AidArg = z.output<typeof AidArgSchema>

type IssueList = { path: (string | number)[]; rule: string; message: string }[]

/** The aid after applying `arg` to `current` (an add when undefined), lengths in mm. */
function applyAidArg(
  current: AidDTO | undefined,
  arg: AidArg,
  name: (kind: AidDTO['kind']) => string,
  units: UnitSystem,
  where: string,
): AppResult<AidDTO> {
  const issues: IssueList = []
  const len = (src: string | undefined, key: string): number | undefined => {
    if (src === undefined) return undefined
    const q = Quantity.parse(src, fieldContext('length', units))
    if (q.isErr()) {
      issues.push({ path: ['aid', key], rule: 'parse', message: q.unwrapErr().message })
      return undefined
    }
    return q.unwrap().canonical
  }
  const xy = (
    v: readonly [string, string] | undefined,
    key: string,
  ): [number, number] | undefined => {
    if (v === undefined) return undefined
    const x = len(v[0], key)
    const y = len(v[1], key)
    return x === undefined || y === undefined ? undefined : [x, y]
  }
  const kind = arg.kind ?? current?.kind
  if (kind === undefined)
    return fail('plan.aid', 'name the aid kind', {
      where,
      issues: [
        { path: ['aid', 'kind'], rule: 'required', message: 'witnessMark or registrationHole' },
      ],
    })
  const at = xy(arg.at, 'at')
  const from = xy(arg.from, 'from')
  const to = xy(arg.to, 'to')
  const center = xy(arg.center, 'center')
  const diameter = len(arg.diameter, 'diameter')
  const markD = len(arg.markDiameter, 'markDiameter')
  const depth = len(arg.spoilboardDepth, 'spoilboardDepth')
  if (issues.length > 0) return fail('input.malformed', issues[0]!.message, { where, issues })
  const missing = (key: string, message: string) =>
    fail('plan.aid', message, {
      where,
      issues: [{ path: ['aid', key], rule: 'required', message: 'missing' }],
    })
  const nm = arg.name ?? current?.name ?? name(kind)
  let out: AidDTO
  if (kind === 'witnessMark') {
    const prev = current?.kind === 'witnessMark' ? current : undefined
    const md = markD ?? prev?.markDiameter
    const extra = md === undefined ? {} : { markDiameter: md }
    const line =
      from !== undefined ||
      to !== undefined ||
      (at === undefined && prev !== undefined && 'from' in prev)
    if (line) {
      const f = from ?? (prev !== undefined && 'from' in prev ? prev.from : undefined)
      const t = to ?? (prev !== undefined && 'to' in prev ? prev.to : undefined)
      if (f === undefined) return missing('from', 'a line mark needs from and to')
      if (t === undefined) return missing('to', 'a line mark needs from and to')
      out = { kind, name: nm, from: f, to: t, ...extra }
    } else {
      const p = at ?? (prev !== undefined && 'at' in prev ? prev.at : undefined)
      if (p === undefined) return missing('at', 'a witness mark needs at, or from and to')
      out = { kind, name: nm, at: p, ...extra }
    }
  } else {
    const prev = current?.kind === 'registrationHole' ? current : undefined
    const c = center ?? prev?.center
    if (c === undefined) return missing('center', 'a registration hole needs center')
    const sd = depth ?? prev?.spoilboardDepth
    out = {
      kind,
      name: nm,
      center: c,
      diameter: diameter ?? prev?.diameter ?? AID.holeDiameter,
      ...(sd === undefined ? {} : { spoilboardDepth: sd }),
    }
  }
  const checked = AidDtoSchema.safeParse(out)
  if (!checked.success)
    return fail('plan.aid', `the aid is out of range: ${checked.error.issues[0]!.message}`, {
      where,
      issues: checked.error.issues.map((i) => ({
        path: ['aid', ...i.path.map((p) => (typeof p === 'symbol' ? String(p) : p))],
        rule: 'range',
        message: i.message,
      })),
    })
  if ('from' in out && Math.hypot(out.to[0] - out.from[0], out.to[1] - out.from[1]) > AID.lineMax)
    return fail('plan.aid', `a line mark is at most ${AID.lineMax} mm long`, {
      where,
      issues: [{ path: ['aid', 'to'], rule: 'range', message: 'too long for a mark' }],
    })
  return Ok(out)
}

/** Where a new aid goes in its setup: registration holes after the facings, marks last. */
function aidIndex(setup: SetupDTO, plan: LoadedPlan, aid: AidDTO): number {
  if (aid.kind === 'witnessMark') return setup.operations.length
  let at = 0
  setup.operations.forEach((o, i) => {
    if (!isAid(o) && evaluateOperation(plan, o).kind === 'facing') at = i + 1
  })
  return at
}

const mmText = (v: number) => `${Math.round(v * 1e6) / 1e6 || 0} mm`

export const planAidSet = defineCommand({
  kind: 'document',
  name: 'plan.aid.set',
  summary:
    'Add, update or remove an alignment aid (witness mark: V-bit spot or line across an edge; registration hole through into the spoilboard), or place two in the waste. With forSetupId each new aid becomes an alignment point of that later setup.',
  title: () => 'Set alignment aid',
  machine: false,
  args: z.object({
    planId: PlanIdSchema,
    setupId: PlanRecordIdSchema.optional().describe('Setup that cuts it (add, place)'),
    planOperationId: PlanRecordIdSchema.optional().describe('Aid to update; without aid: remove'),
    aid: AidArgSchema.optional(),
    place: z
      .enum(['marks', 'holes'])
      .optional()
      .describe(
        'Add two: line marks across opposite edges, or holes on the flip axis to the later flipped setup (else at opposite corners)',
      ),
    forSetupId: PlanRecordIdSchema.optional().describe('Later setup that aligns on the new aids'),
  }),
  result: z.object({
    planOperationIds: z.array(z.string()).describe('Added or updated aids'),
    alignmentPointIds: z.array(z.string()).describe('Points added to forSetupId'),
    findings: z.array(
      z.object({
        rule: z.string(),
        message: z.string(),
        planOperationId: z.string().optional(),
        alignmentPointId: z.string().optional(),
      }),
    ),
  }),
  run(draft, args, ctx) {
    const where = 'plan.aid.set'
    const port = ctx.services.region2d
    const before = loaded(draft, args.planId, where)
    if (before.isErr()) return before
    const plan = before.unwrap()
    const units = draft.unitSystem
    const target = draft.plans[args.planId]!
    const malformed = (path: string, rule: string, message: string) =>
      fail('input.malformed', message, { where, issues: [{ path: [path], rule, message }] })
    const touched: string[] = []
    let pointIds: string[] = []
    if (args.planOperationId !== undefined) {
      // update or remove
      if (args.place !== undefined || args.setupId !== undefined || args.forSetupId !== undefined)
        return malformed('planOperationId', 'conflict', 'give planOperationId alone, or with aid')
      const setup = target.setups.find((s) =>
        s.operations.some((o) => o.id === args.planOperationId),
      )
      const op = setup?.operations.find((o) => o.id === args.planOperationId)
      if (setup === undefined || op?.aid === undefined)
        return fail('plan.aid', `${args.planOperationId} is not an alignment aid of this plan`, {
          where,
          issues: [{ path: ['planOperationId'], rule: 'notAnAid', message: 'no such aid' }],
        })
      if (args.aid === undefined) {
        setup.operations = setup.operations.filter((o) => o.id !== op.id)
        // the last aid of a setup that held only aids (S20): the empty setup goes, as on a move
        if (setup.operations.length === 0 && target.setups.length > 1)
          target.setups = target.setups.filter((s) => s.id !== setup.id)
      } else {
        const old = op.aid
        const next = applyAidArg(old, args.aid, () => old.name, units, where)
        if (next.isErr()) return next
        op.aid = next.unwrap()
        touched.push(op.id)
      }
    } else {
      if (args.setupId === undefined)
        return malformed('setupId', 'required', 'setupId: the setup that cuts the aid')
      const si = target.setups.findIndex((s) => s.id === args.setupId)
      if (si < 0) return unknownSetup(args.setupId, 'setupId', where)
      const fi =
        args.forSetupId === undefined
          ? -1
          : target.setups.findIndex((s) => s.id === args.forSetupId)
      if (args.forSetupId !== undefined && fi < 0)
        return unknownSetup(args.forSetupId, 'forSetupId', where)
      if (args.forSetupId !== undefined && fi <= si)
        return fail('plan.aid', 'the aligning setup must come after the setup that cuts the aid', {
          where,
          issues: [{ path: ['forSetupId'], rule: 'notLater', message: 'not a later setup' }],
        })
      const setupDto = plan.setups[si]!
      const aids: AidDTO[] = []
      const skip = { witnessMark: 0, registrationHole: 0 }
      const nameOf = (kind: AidDTO['kind']) => nextAidName(target as PlanDTO, kind, skip[kind]++)
      const parsed = (src: string | undefined, dflt: number): AppResult<number> =>
        src === undefined
          ? Ok(dflt)
          : Quantity.parse(src, fieldContext('length', units)).map((q) => q.canonical)
      if (args.place === 'marks') {
        const md = parsed(args.aid?.markDiameter, AID.markDiameter)
        if (md.isErr()) return Err(md.unwrapErr().withContext(where))
        for (const l of suggestMarks(plan, setupDto, md.unwrap(), port)) {
          const a = applyAidArg(
            undefined,
            {
              kind: 'witnessMark',
              from: [mmText(l.from[0]), mmText(l.from[1])],
              to: [mmText(l.to[0]), mmText(l.to[1])],
              ...(args.aid?.markDiameter === undefined
                ? {}
                : { markDiameter: args.aid.markDiameter }),
            },
            nameOf,
            units,
            where,
          )
          if (a.isErr()) return a
          aids.push(a.unwrap())
        }
      } else if (args.place === 'holes') {
        const d = parsed(args.aid?.diameter, AID.holeDiameter)
        if (d.isErr()) return Err(d.unwrapErr().withContext(where))
        // on the flip axis to the later setup that turns the stock over (S25, Q106 assumed)
        const flip = flipPartner(plan, setupDto, args.forSetupId)
        for (const c of suggestHoles(plan, setupDto, d.unwrap(), port, flip?.axis)) {
          const a = applyAidArg(
            undefined,
            {
              kind: 'registrationHole',
              center: [mmText(c[0]), mmText(c[1])],
              diameter: mmText(d.unwrap()),
              ...(args.aid?.spoilboardDepth === undefined
                ? {}
                : { spoilboardDepth: args.aid.spoilboardDepth }),
            },
            nameOf,
            units,
            where,
          )
          if (a.isErr()) return a
          aids.push(a.unwrap())
        }
      } else {
        if (args.aid === undefined) return malformed('aid', 'required', 'aid or place: what to add')
        const a = applyAidArg(undefined, args.aid, nameOf, units, where)
        if (a.isErr()) return a
        aids.push(a.unwrap())
      }
      const setup = target.setups[si]!
      // the aids of one call keep their order (hole 1 before hole 2)
      const start = aids[0] === undefined ? 0 : aidIndex(setup as SetupDTO, plan, aids[0])
      aids.forEach((aid, k) => {
        const op: PlanOperationDTO = {
          id: ctx.ids.next('planOp'),
          designOperationIds: [],
          source: 'aid',
          aid,
          overrides: {},
          strategy: {},
        }
        setup.operations.splice(start + k, 0, op)
        touched.push(op.id)
      })
      // tools as a rebuild resolves them: a drilling's for holes, a pointed V-bit for marks
      const resolved = resolveAndAssign(target as PlanDTO, touched, {
        ids: ctx.ids,
        now: new Date(ctx.clock.now()).toISOString(),
        units,
        tools:
          ctx.services.library === undefined
            ? []
            : ctx.services.library.list('tool').items.filter((i) => i.values instanceof Tool),
        ...(port === undefined ? {} : { region2d: port }),
      })
      if (resolved.isErr()) return Err(resolved.unwrapErr().withContext(where))
      if (args.forSetupId !== undefined) {
        const later = target.setups[fi]!
        if ((later.alignment?.length ?? 0) + touched.length > ALIGNMENT_POINTS_MAX)
          return fail('plan.alignment', `a setup has at most ${ALIGNMENT_POINTS_MAX} points`, {
            where,
            issues: [{ path: ['forSetupId'], rule: 'tooMany', message: 'too many points' }],
          })
        const ids = nextPointIds(target as PlanDTO, touched.length)
        const points: AlignmentPointDTO[] = touched.map((id, k) => ({
          id: ids[k]!,
          source: { aid: id },
        }))
        later.alignment = [...(later.alignment ?? []), ...points]
        pointIds = points.map((p) => p.id)
      }
    }
    const after = loaded(draft, args.planId, where)
    if (after.isErr()) return after
    const a = after.unwrap()
    const mine = new Set([...touched, ...pointIds])
    const findings = [
      ...a.operations
        .filter((o) => touched.includes(o.id))
        .flatMap((o) => evaluateOperation(a, o, undefined, undefined, port).findings)
        .filter((f) => f.code === 'plan.aid' || f.severity === 'error'),
      ...alignmentFindings(a, port).filter(
        (f) =>
          mine.has(String(f.params['alignmentPointId'])) ||
          mine.has(String(f.params['planOperationId'])),
      ),
    ].map((f) => ({
      rule: f.rule,
      message: f.message,
      ...(f.planOperationId === undefined ? {} : { planOperationId: f.planOperationId }),
      ...(typeof f.params['alignmentPointId'] === 'string'
        ? { alignmentPointId: f.params['alignmentPointId'] }
        : {}),
    }))
    return Ok({ planOperationIds: touched, alignmentPointIds: pointIds, findings })
  },
})
