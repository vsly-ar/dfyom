/**
 * Plan commands and queries (v0.1, without toolpaths) and the `plan.draftFollow` apply hook.
 * Doc: docs/modes/plan-v0.1.md#commands-and-queries-v01, docs/modes/plan-v0.1.md#plan-status
 *
 * All commands are `document` commands (one undo step each). Every command except
 * `plan.create` checks the plan's status (`plan.status`). A plan reads only its own design
 * snapshot and library copies; the library is read synchronously to take or refresh a copy.
 * `plan.toolpath.generate` (job) and `plan.toolpath.get` come with tasks 2.9/2.10 on the seam in
 * inputs.ts.
 */
import type { Draft } from 'immer'
import { z } from 'zod'
import { type Issue, issueSummary } from '../../shared/errors/app-error'
import { collect, Err, fail, Ok, type AppResult } from '../../shared/result'
import type { CommandContext, Services } from '../commands/context'
import {
  defineCommand,
  defineQuery,
  type AnyCommand,
  type ApplyHook,
  type QueryDef,
} from '../commands/define'
import type { PlanApply } from '../commands/apply'
import { listedAs } from '../commands/json-schema'
import { OPERATION_UPDATE_ARGS, updateOperation, writeOperationList } from '../design/commands'
import { checkDisabledList } from '../design/disabled'
import { fieldContext, partFromDTO } from '../design/operation'
import { OperationIdSchema, PartIdSchema } from '../design/part.dto'
import { ItemIdSchema, NAME_MAX, type LibraryItemKind } from '../library/item'
import type { LibraryItem } from '../library/library-item'
import { Tool } from '../library/tool'
import { isBuiltinWorkholding, withBuiltinWorkholding } from '../library/workholding-builtins'
import { deepEqual, refreshSnapshot, Snapshot, takeSnapshot } from '../library/snapshot'
import type { ProjectDoc, UnitSystem } from '../project/document'
import { Quantity } from '../quantity/quantity'
import type { ParseContext } from '../quantity/parse'
import {
  assignTool,
  createPlan,
  duplicatePlan,
  nextSnapshotId,
  rebuildPlan,
  type BuildContext,
} from './build'
import { PlanWarningSchema, type PlanWarning } from './checks'
import { namedPlanMessages } from './labels'
import { evaluateOperation, planFindings } from './evaluate'
import { feedModeIssues, type LockState, type ResolvedFeed } from './feeds'
import { planThroughDepth } from './through'
import {
  knownSurfaceId,
  planZReferences,
  zRefFindings,
  type ZRefCandidate,
  type ZRefOutline,
} from './z-reference'
import { findPlanDTO, findPlanOperation, loadPlan, loadPlanDTO, type LoadedPlan } from './plan'
import {
  checkNoNewOrderViolation,
  directionMismatch,
  mergeSetups,
  setupDirection,
  splitSetup,
  unknownSetup,
} from './setups'
import {
  FEED_FIELDS,
  lengthDTO,
  PlanDtoSchema,
  PlanIdSchema,
  PlanRecordIdSchema,
  PlanStatusSchema,
  SETUP_ROTATIONS,
  type FeedField,
  type PlanDTO,
  type PlanOperationDTO,
  type SetupDTO,
} from './plan.dto'
import { planPendingApply } from './pending'
import { planOperationInputs, type PlanOperationInput } from './inputs'
import {
  clampFindings,
  currentSetupLinks,
  linksFindings,
  linksSummaryDTO,
  setupRetraction,
} from './setup-links'
import { RETRACTIONS } from '../toolpath/links'
import { designChanged, hasPlanEdits, planStale } from './snapshot'
import { shapeFindings } from './shape-findings'
import { checkPart, sameValue } from './validity'
import { StepSchema, stepToDTO } from '../feeds-speeds/commands'
import { workholdingSet } from './workholding/commands'
import { reresolveCopy } from './workholding/devices'
import {
  dropShadowedShortStickout,
  planHasHolder,
  planStickouts,
  workholdingFindings,
} from './workholding/findings'
import { setupWorkholding } from './workholding/setup'
import { defaultClearance } from './build'
import { DEFAULT_RIGIDITY } from '../feeds-speeds/data'
import { machineLimits } from '../feeds-speeds/suggest'
import { checkAllowed, nextStatus } from './status'
import { cutIds, cutLocked, firstCut } from './cut'
import { applyStrategyArgs, StrategyArgSchema, strategyIssues, resolveStrategy } from './strategy'
import { suggestTools } from './suggest'
import { designToolFindings } from './tool-resolution'
import { alignmentFindings, alignmentSources } from './alignment'
import { AlignmentSourceDtoSchema } from './alignment.dto'
import { checkAlignmentOrder, planAidSet } from './aid-commands'
import {
  alignmentView,
  applySetupZero,
  planAlignmentSet,
  SetupAlignmentSchema,
  SetupZeroArgSchema,
} from './alignment-commands'

// ── helpers ───────────────────────────────────────────────────────────────────────────────

const Src = z.string().min(1).max(256)
const PlanArg = { planId: PlanIdSchema }
const Empty = z.object({})
const nowIso = (ctx: CommandContext) => new Date(ctx.clock.now()).toISOString()

function libraryTools(services: Services): LibraryItem[] {
  return services.library === undefined
    ? []
    : services.library.list('tool').items.filter((i) => i.values instanceof Tool)
}

function buildContext(ctx: CommandContext, units: UnitSystem): BuildContext {
  return {
    ids: ctx.ids,
    now: nowIso(ctx),
    units,
    tools: libraryTools(ctx.services),
    ...(ctx.services.region2d === undefined ? {} : { region2d: ctx.services.region2d }),
  }
}

/** A library item by id (synchronous read, docs/architecture/commands.md#command-definition). */
function libraryItem(
  ctx: CommandContext,
  kind: LibraryItemKind,
  id: string,
  path: string,
  where: string,
  /** The project's: picks a built-in workholding device's value set (WL2). */
  units: UnitSystem = 'mm',
): AppResult<LibraryItem> {
  const library = ctx.services.library
  const builtin = kind === 'workholding' && isBuiltinWorkholding(id)
  if (library === undefined && !builtin)
    return fail('internal.unexpected', 'no library service configured', { where })
  const found = withBuiltinWorkholding(library?.lookup, units)(kind, id)
  if (found.state === 'found') return Ok(found.item)
  return fail('input.malformed', `${kind} ${id} is not in the library or does not load`, {
    issues: [
      {
        path: [path],
        rule: found.state === 'missing' ? 'unknownItem' : 'unreadableItem',
        message: found.state === 'missing' ? `no such library ${kind}` : 'the file does not load',
      },
    ],
    where,
  })
}

/** The plan, after the status check of `command`. */
function planFor(draft: Draft<ProjectDoc>, planId: string, command: string): AppResult<PlanDTO> {
  const plan = findPlanDTO(draft as ProjectDoc, planId, command)
  if (plan.isErr()) return plan
  const allowed = checkAllowed(planId, plan.unwrap().status, command)
  return allowed.isErr() ? Err(allowed.unwrapErr()) : plan
}

/** Loaded models of a plan from a draft, after the status check. */
function loadedFor(
  draft: Draft<ProjectDoc>,
  planId: string,
  command: string,
): AppResult<LoadedPlan> {
  return planFor(draft, planId, command).andThen((p) => loadPlanDTO(p, draft.unitSystem, command))
}

const plainCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

type Json = Record<string, unknown> | unknown[]
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null

/**
 * Writes `value` into `target` (a draft) changing only what differs, so patches name the changed
 * fields and operations, not the whole record.
 */
function writeDiff(target: Json, value: Json): void {
  if (Array.isArray(target) && Array.isArray(value)) {
    value.forEach((v, i) => {
      if (i >= target.length) target.push(v)
      else if (!deepEqual(target[i], v)) {
        const t = target[i]
        if (isObj(t) && isObj(v) && Array.isArray(t) === Array.isArray(v)) writeDiff(t, v)
        else target[i] = v
      }
    })
    if (target.length > value.length) target.splice(value.length)
    return
  }
  const t = target as Record<string, unknown>
  const v = value as Record<string, unknown>
  for (const key of Object.keys(t))
    if (!Object.hasOwn(v, key) || v[key] === undefined) delete t[key]
  for (const [key, next] of Object.entries(v)) {
    if (next === undefined || deepEqual(t[key], next)) continue
    const cur = t[key]
    if (isObj(cur) && isObj(next) && Array.isArray(cur) === Array.isArray(next))
      writeDiff(cur, next)
    else t[key] = next
  }
}

/** Writes a plan record, changing only what differs (no patch for an equal value). */
function writePlan(draft: Draft<ProjectDoc>, plan: PlanDTO): void {
  const current = draft.plans[plan.id]
  if (current === undefined) draft.plans[plan.id] = plan
  else writeDiff(current as unknown as Json, plan as unknown as Json)
}

function invalid(issues: Issue[], where: string): AppResult<never> {
  return fail('model.invariant', issueSummary(issues), { issues, where })
}

function needsDiscard(planId: string, where: string): AppResult<never> {
  return fail(
    'input.malformed',
    `plan ${planId} has plan-only edits; pass discardPlanEdits: true`,
    {
      issues: [
        {
          path: ['discardPlanEdits'],
          rule: 'planEdits',
          message: 'the plan has plan-only edits; true discards them',
        },
      ],
      where,
    },
  )
}

/** Rebuild from the current design (shared by `plan.rebuild`, `→ draft` and `plan.draftFollow`). */
function rebuild(
  draft: Draft<ProjectDoc>,
  plan: PlanDTO,
  ctx: CommandContext,
  where: string,
): AppResult<PlanDTO> {
  return rebuildPlan(plan, draft as ProjectDoc, buildContext(ctx, draft.unitSystem), where)
}

const parseContexts = (units: UnitSystem): Record<FeedField, ParseContext> => ({
  spindleSpeed: { kind: 'spindleSpeed', defaultUnit: 'rpm' },
  feedRate: { kind: 'feedRate', defaultUnit: units === 'mm' ? 'mm/min' : 'in/min' },
  plungeRate: { kind: 'feedRate', defaultUnit: units === 'mm' ? 'mm/min' : 'in/min' },
  stepdown: fieldContext('length', units),
  stepover: fieldContext('length', units),
})

/**
 * A resolved value (canonical) as the text of an entered quantity in the project units, rounded
 * to the field's display precision (rpm whole, feeds 0.1 mm/min or 0.01 in/min, lengths 0.001 mm
 * or 0.0001 in): what a lock pins when nothing is entered.
 */
function pinnedSource(field: FeedField, value: number, units: UnitSystem): string {
  const trim = (n: number, d: number) =>
    n
      .toFixed(d)
      .replace(/(\.\d*?)0+$/, '$1')
      .replace(/\.$/, '')
  if (field === 'spindleSpeed') return `${trim(value, 0)} rpm`
  const feed = field === 'feedRate' || field === 'plungeRate'
  if (units === 'mm') return feed ? `${trim(value, 1)} mm/min` : `${trim(value, 3)} mm`
  return feed ? `${trim(value / 25.4, 2)} in/min` : `${trim(value / 25.4, 4)} in`
}

/** `plan.operation.update` lock refusal: model.invariant, rule lockUnavailable (docs: Impossible locks). */
function lockUnavailable(
  field: FeedField,
  reason: string,
  message: string,
  where: string,
): AppResult<never> {
  return fail('model.invariant', `${field} can't be locked: ${message}`, {
    issues: [{ path: ['locks', field], rule: 'lockUnavailable', message, params: { reason } }],
    where,
  })
}

function unlock(op: PlanOperationDTO, field: FeedField): void {
  if (op.locked === undefined) return
  op.locked = op.locked.filter((f) => f !== field)
  if (op.locked.length === 0) delete op.locked
}

// ── plan lifecycle ────────────────────────────────────────────────────────────────────────

const planCreate = defineCommand({
  kind: 'document',
  name: 'plan.create',
  summary:
    'Create a draft plan of a part: design snapshot, one setup per face direction, every operation with a suggested tool.',
  title: () => 'Create plan',
  machine: false,
  // apply first: docs/architecture/apply.md#implicit-apply
  applyFirst: true,
  args: z.object({
    partId: PartIdSchema,
    name: z.string().min(1).max(NAME_MAX).optional().describe('Default "Plan <n>"'),
    machineLibraryItemId: ItemIdSchema.optional().describe('Library machine to take a copy of'),
  }),
  result: z.object({ planId: PlanIdSchema, setupIds: z.array(PlanRecordIdSchema) }),
  run(draft, args, ctx) {
    const where = 'plan.create'
    let machine: LibraryItem | undefined
    if (args.machineLibraryItemId !== undefined) {
      const m = libraryItem(
        ctx,
        'machine',
        args.machineLibraryItemId,
        'machineLibraryItemId',
        where,
      )
      if (m.isErr()) return m
      machine = m.unwrap()
    }
    const plan = createPlan(
      draft as ProjectDoc,
      {
        partId: args.partId,
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(machine === undefined ? {} : { machine }),
      },
      buildContext(ctx, draft.unitSystem),
      where,
    )
    if (plan.isErr()) return plan
    draft.plans[plan.unwrap().id] = plan.unwrap()
    return Ok({ planId: plan.unwrap().id, setupIds: plan.unwrap().setups.map((x) => x.id) })
  },
})

const planDuplicate = defineCommand({
  kind: 'document',
  name: 'plan.duplicate',
  summary:
    'Copy a plan with its design snapshot and library copies; the copy starts as settledDesign.',
  title: () => 'Duplicate plan',
  machine: false,
  args: z.object({ ...PlanArg, name: z.string().min(1).max(NAME_MAX).optional() }),
  result: z.object({ planId: PlanIdSchema }),
  run(draft, args, ctx) {
    const source = planFor(draft, args.planId, 'plan.duplicate')
    if (source.isErr()) return source
    const id = ctx.ids.next('plan')
    draft.plans[id] = duplicatePlan(plainCopy(source.unwrap()), id, args.name)
    return Ok({ planId: id })
  },
})

const planUpdate = defineCommand({
  kind: 'document',
  name: 'plan.update',
  summary: 'Rename a plan.',
  title: (a) => (a.disabled !== undefined ? 'Disable in plan' : 'Rename plan'),
  machine: false,
  args: z.object({
    ...PlanArg,
    name: z.string().min(1).max(NAME_MAX).optional(),
    disabled: z.array(z.string().min(1)).optional().describe('Design ids off in this plan only'),
  }),
  result: Empty,
  run(draft, args, ctx) {
    const where = 'plan.update'
    const found = planFor(draft, args.planId, where)
    if (found.isErr()) return found
    if (args.disabled !== undefined) {
      // DF106 (plan-v0.4.md#disabling-in-a-plan-df106): checked against the plan's own snapshot,
      // applied by rebuilding from it (never from the current design)
      const current = found.unwrap()
      const { list, issues } = checkDisabledList(current.design.taken, args.disabled, 'disabled')
      const unknown = issues.filter((i) => i.rule === 'unknownItem')
      if (unknown.length > 0)
        return fail('input.malformed', issueSummary(unknown), { issues: unknown, where })
      if (issues.length > 0) return fail('model.invariant', issueSummary(issues), { issues, where })
      if (!sameValue(current.disabled ?? [], list)) {
        const plan = plainCopy(current)
        if (list.length === 0) delete plan.disabled
        else plan.disabled = list
        const rebuilt = rebuildPlan(
          plan,
          draft as ProjectDoc,
          buildContext(ctx, draft.unitSystem),
          where,
          true,
        )
        if (rebuilt.isErr()) return rebuilt
        writePlan(draft, rebuilt.unwrap())
      }
    }
    if (args.name !== undefined) draft.plans[args.planId]!.name = args.name
    return Ok({})
  },
})

const planRemove = defineCommand({
  kind: 'document',
  name: 'plan.remove',
  summary: 'Delete a plan; requires confirm: true. An inUse plan must be archived first.',
  title: () => 'Delete plan',
  machine: false,
  args: z.object({
    ...PlanArg,
    confirm: z.literal(true), // the primer says what confirm: true asserts (llm-api.md#schemas)
  }),
  result: Empty,
  run(draft, args) {
    const plan = planFor(draft, args.planId, 'plan.remove')
    if (plan.isErr()) return plan
    delete draft.plans[args.planId]
    return Ok({})
  },
})

const planStatusSet = defineCommand({
  kind: 'document',
  name: 'plan.status.set',
  summary:
    'Change the status of a plan (draft, settledDesign, finalized, inUse, archived); without status, un-archive.',
  title: (a) => (a.status === undefined ? 'Un-archive plan' : `Set plan status to ${a.status}`),
  machine: false,
  // apply first into draft, and before un-archiving (which may restore draft):
  // docs/architecture/apply.md#implicit-apply
  applyFirst: (a) => a.status === 'draft' || a.status === undefined,
  args: z.object({
    ...PlanArg,
    status: PlanStatusSchema.optional().describe('Omit to un-archive (restores the previous one)'),
    discardPlanEdits: z
      .boolean()
      .optional()
      .describe('Back to draft rebuilds from the design; true discards plan-only edits'),
  }),
  result: Empty,
  run(draft, args, ctx) {
    const where = 'plan.status.set'
    const found = findPlanDTO(draft as ProjectDoc, args.planId, where)
    if (found.isErr()) return found
    const current = found.unwrap()
    const next = nextStatus(args.planId, current.status, current.statusBeforeArchive, args.status)
    if (next.isErr()) return next
    const status = next.unwrap()
    if (status === current.status) return Ok({})
    let plan = plainCopy(current)
    if (status === 'draft') {
      if (hasPlanEdits(plan) && args.discardPlanEdits !== true)
        return needsDiscard(args.planId, where)
      if (hasPlanEdits(plan) || designChanged(plan, draft as ProjectDoc)) {
        const rebuilt = rebuild(draft, plan, ctx, where)
        if (rebuilt.isErr()) return rebuilt
        plan = rebuilt.unwrap()
      }
    }
    if (status === 'archived')
      plan.statusBeforeArchive = current.status as typeof plan.statusBeforeArchive
    else delete plan.statusBeforeArchive
    plan.status = status
    writePlan(draft, plan)
    return Ok({})
  },
})

const planRebuild = defineCommand({
  kind: 'document',
  name: 'plan.rebuild',
  summary:
    'Replace the plan’s design snapshot with the current design; plan operations keep their tools and settings.',
  title: () => 'Rebuild plan from design',
  machine: false,
  // apply first: docs/architecture/apply.md#implicit-apply
  applyFirst: true,
  args: z.object({
    ...PlanArg,
    discardPlanEdits: z.boolean().optional().describe('Required (true) when there are plan edits'),
  }),
  result: Empty,
  run(draft, args, ctx) {
    const where = 'plan.rebuild'
    const plan = planFor(draft, args.planId, where)
    if (plan.isErr()) return plan
    if (hasPlanEdits(plan.unwrap()) && args.discardPlanEdits !== true)
      return needsDiscard(args.planId, where)
    const rebuilt = rebuild(draft, plainCopy(plan.unwrap()), ctx, where)
    if (rebuilt.isErr()) return rebuilt
    writePlan(draft, rebuilt.unwrap())
    return Ok({})
  },
})

const libraryItemUpdate = defineCommand({
  kind: 'document',
  name: 'plan.libraryItem.update',
  summary:
    "Re-import one of the plan's library copies (stock, machine, tool or workholding) from the library.",
  title: () => 'Update plan copy from library',
  machine: false,
  args: z.object({
    ...PlanArg,
    snapshotId: z.string().min(1).describe("Id of the copy in the plan's snapshots"),
  }),
  result: z.object({ updated: z.boolean().describe('False when nothing changed') }),
  run(draft, args, ctx) {
    const where = 'plan.libraryItem.update'
    const found = planFor(draft, args.planId, where)
    if (found.isErr()) return found
    const plan = plainCopy(found.unwrap())
    const r = refreshCopy(plan, args.snapshotId, draft.unitSystem, ctx, where)
    if (r.isErr() || !r.unwrap()) return r.map((updated) => ({ updated }))
    writePlan(draft, plan)
    return Ok({ updated: true })
  },
})

/**
 * Re-imports one library copy of `plan` (a plain copy, changed in place) from the library:
 * `false` when the values are equal. A new stock copy must keep the plan's part valid.
 * Shared by `plan.libraryItem.update` and the `plan.draftFollow` apply hook.
 */
function refreshCopy(
  plan: PlanDTO,
  snapshotId: string,
  units: UnitSystem,
  ctx: CommandContext,
  where: string,
): AppResult<boolean> {
  const index = plan.snapshots.findIndex((s) => s.id === snapshotId)
  const dto = plan.snapshots[index]
  if (dto === undefined)
    return fail('input.malformed', `plan ${plan.id} has no copy ${snapshotId}`, {
      issues: [{ path: ['snapshotId'], rule: 'unknownSnapshot', message: 'no such copy' }],
      where,
    })
  if (dto.libraryItemId === undefined)
    return fail('input.malformed', `copy ${snapshotId} is the project's own stock`, {
      issues: [{ path: ['snapshotId'], rule: 'ownStock', message: 'not from the library' }],
      where,
    })
  const item = libraryItem(ctx, dto.kind, dto.libraryItemId, 'snapshotId', where, units)
  if (item.isErr()) return item
  const refreshed = Snapshot.fromDTO(dto).andThen((s) =>
    refreshSnapshot(s, item.unwrap(), nowIso(ctx)),
  )
  if (refreshed.isErr()) return Err(refreshed.unwrapErr().withContext(where))
  if (deepEqual(refreshed.unwrap().values.toDTO(), dto.values)) return Ok(false)
  plan.snapshots[index] = refreshed.unwrap().toDTO()
  if (dto.kind === 'stock') {
    // the plan's part must stay valid with the new stock
    const loaded = loadPlanDTO(plan, units, where)
    if (loaded.isErr()) return loaded
    const { part, stock } = loaded.unwrap()
    const ok = checkPart(part, stock, ctx.services.region2d)
    if (ok.isErr()) return Err(ok.unwrapErr().withContext(where))
  }
  if (dto.kind === 'workholding') {
    // every item placed from the copy takes the new device values (WL2)
    const loaded = loadPlanDTO(plan, units, where)
    if (loaded.isErr()) return loaded
    const issues = reresolveCopy(plan, snapshotId, loaded.unwrap().stock, units)
    if (issues.length > 0)
      return fail('model.invariant', `the new device does not fit: ${issueSummary(issues)}`, {
        issues,
        where,
      })
  }
  return Ok(true)
}

const designOperationUpdate = defineCommand({
  kind: 'document',
  name: 'plan.design.operation.update',
  summary:
    "Edit an operation of the plan's design snapshot for this plan only (settledDesign); same parameters as design.<kind>.update.",
  title: () => 'Edit operation in plan',
  machine: false,
  args: z.object({ ...PlanArg, operationId: OperationIdSchema, ...OPERATION_UPDATE_ARGS }),
  // the same shape as on the pocket and profile add tools (llm-api.md#schemas, listed sketches)
  listedArgs: { shape: listedAs('object', 'design.pocket.add shape') },
  result: Empty,
  run(draft, rawArgs, ctx) {
    const where = 'plan.design.operation.update'
    const { planId, operationId, ...params } = rawArgs as {
      planId: string
      operationId: string
    } & Record<string, unknown>
    const loaded = loadedFor(draft, planId, where)
    if (loaded.isErr()) return loaded
    const l = loaded.unwrap()
    const ops = updateOperation(
      // plan-only edits work per owned operation (features.md § Plan): no feature checks here
      { dto: l.dto.design.part, part: l.part, stock: l.stock, units: l.units, features: [] },
      operationId,
      params,
      where,
      ctx.services.region2d,
    )
    if (ops.isErr()) return ops
    writeOperationList(draft.plans[planId]!.design.part.operations, ops.unwrap())
    return Ok({})
  },
})

/**
 * Copies the `taken` version of a plan operation's design operations back into the plan's part
 * (one undo step). Unedited operations are left as they are; nothing edited = no patch.
 * Doc: docs/modes/plan-v0.2.md#plan-only-edits-and-the-snapshot-scene
 */
const designOperationRevert = defineCommand({
  kind: 'document',
  name: 'plan.design.operation.revert',
  summary:
    "Revert the plan-only edits of a plan operation's design operations to the design snapshot as taken (settledDesign).",
  title: () => 'Revert to design',
  machine: false,
  args: z.object({ ...PlanArg, planOperationId: PlanRecordIdSchema }),
  result: z.object({
    reverted: z
      .array(OperationIdSchema)
      .describe('Design operations whose plan-only edits were reverted (empty: none had any)'),
  }),
  run(draft, args, ctx) {
    const where = 'plan.design.operation.revert'
    const loaded = loadedFor(draft, args.planId, where)
    if (loaded.isErr()) return loaded
    const l = loaded.unwrap()
    const index = findPlanOperation(l, args.planOperationId, where)
    if (index.isErr()) return index
    const design = plainCopy(l.dto.design)
    const reverted: string[] = []
    for (const id of index.unwrap().op.designOperationIds) {
      const i = design.part.operations.findIndex((o) => o.id === id)
      const taken = design.taken.operations.find((o) => o.id === id)
      if (i < 0 || taken === undefined || sameValue(taken, design.part.operations[i])) continue
      design.part.operations[i] = plainCopy(taken)
      reverted.push(id)
    }
    if (reverted.length === 0) return Ok({ reverted })
    // the plan's stock copy may have changed since the snapshot: the reverted part must fit it
    const part = partFromDTO(design.part)
    if (part.isErr()) return Err(part.unwrapErr().withContext(where))
    const ok = checkPart(part.unwrap(), l.stock, ctx.services.region2d)
    if (ok.isErr()) return Err(ok.unwrapErr().withContext(where))
    const target = draft.plans[args.planId]!.design.part.operations
    for (const id of reverted) {
      const i = target.findIndex((o) => o.id === id)
      target[i] = design.part.operations[i]!
    }
    return Ok({ reverted })
  },
})

// ── machine, setup, operations ────────────────────────────────────────────────────────────

const machineSet = defineCommand({
  kind: 'document',
  name: 'plan.machine.set',
  summary: 'Set the machine of a plan (the plan takes its own copy).',
  title: () => 'Set plan machine',
  machine: false,
  args: z.object({ ...PlanArg, machineLibraryItemId: ItemIdSchema }),
  result: Empty,
  run(draft, args, ctx) {
    const where = 'plan.machine.set'
    const found = planFor(draft, args.planId, where)
    if (found.isErr()) return found
    const item = libraryItem(
      ctx,
      'machine',
      args.machineLibraryItemId,
      'machineLibraryItemId',
      where,
    )
    if (item.isErr()) return item
    const plan = plainCopy(found.unwrap())
    const values = item.unwrap().values.toDTO()
    const old = plan.snapshots.find((s) => s.id === plan.machine)
    if (
      old !== undefined &&
      old.libraryItemId === item.unwrap().id &&
      deepEqual(old.values, values)
    )
      return Ok({})
    const snap = takeSnapshot(item.unwrap(), nextSnapshotId(plan, ctx.ids), nowIso(ctx))
    if (snap.isErr()) return Err(snap.unwrapErr().withContext(where))
    plan.snapshots = [...plan.snapshots.filter((s) => s.id !== plan.machine), snap.unwrap().toDTO()]
    plan.machine = snap.unwrap().id
    writePlan(draft, plan)
    return Ok({})
  },
})

const SetupArg = { ...PlanArg, setupId: PlanRecordIdSchema }

/**
 * Writes the plan's setups after a setup command (an emptied setup is removed); `plan.order` if
 * the new order adds an order violation. Doc: docs/modes/plan-v0.2.md#merge-split-reorder
 */
function writeSetups(
  draft: Draft<ProjectDoc>,
  plan: LoadedPlan,
  setups: SetupDTO[],
  path: string,
  where: string,
): AppResult<void> {
  const ok = checkNoNewOrderViolation(plan.setups, setups, plan.part, path, where)
  if (ok.isErr()) return ok
  const next = plainCopy(plan.dto)
  next.setups = plainCopy(setups.filter((x) => x.operations.length > 0))
  if (next.setups.length === 0) next.setups = plainCopy(setups.slice(0, 1))
  // alignment (S19): an aid stays in its setup's frame, and no point becomes `notYetCut`
  const aligned = checkAlignmentOrder(plan, next, draft.unitSystem, path, where)
  if (aligned.isErr()) return aligned
  writePlan(draft, next)
  return Ok(undefined)
}

function pastSetupEnd(setup: SetupDTO, index: number, where: string): AppResult<never> {
  const max = setup.operations.length - index
  return fail('input.malformed', 'count runs past the end of the setup', {
    issues: [
      { path: ['count'], rule: 'range', message: `must be at most ${max}`, params: { max } },
    ],
    where,
  })
}

function pastEnd(max: number, where: string): AppResult<never> {
  return fail('input.malformed', 'toIndex is past the end of the list', {
    issues: [
      { path: ['toIndex'], rule: 'range', message: `must be at most ${max}`, params: { max } },
    ],
    where,
  })
}

const setupUpdate = defineCommand({
  kind: 'document',
  name: 'plan.setup.update',
  summary:
    'Rename or rotate a setup, move its work zero, set its safe heights, links or clamp height.',
  title: () => 'Update setup',
  machine: false,
  args: z.object({
    ...SetupArg,
    name: z.string().min(1).max(NAME_MAX).optional(),
    rotation: z.literal(SETUP_ROTATIONS).optional().describe('Degrees about the spindle axis'),
    clearanceHeight: Src.optional().describe(
      "Up from the stock top; > retractHeight; 'auto' follows the workholding",
    ),
    retractHeight: Src.optional().describe("Up from the operation's on surface; > 0"),
    retraction: z.enum(RETRACTIONS).optional().describe('full: links at clearance'),
    clampHeight: Src.nullable().optional().describe('Above stock top; null = unknown'),
    zero: SetupZeroArgSchema.optional().describe(
      'At [x, y] from the up face front-left corner (negative ok) or on a point; null = corner',
    ),
  }),
  result: Empty,
  run(draft, args, ctx) {
    const where = 'plan.setup.update'
    const found = planFor(draft, args.planId, where)
    if (found.isErr()) return found
    const setup = found.unwrap().setups.find((s) => s.id === args.setupId)
    if (setup === undefined) return unknownSetup(args.setupId, 'setupId', where)
    const ctxL = fieldContext('length', draft.unitSystem)
    // WH-C: 'auto' restores the default, raised to the workholding's top + margin
    const auto = args.clearanceHeight?.trim().toLowerCase() === 'auto'
    const parse = (key: 'clearanceHeight' | 'retractHeight') => {
      const src = args[key]
      if (key === 'clearanceHeight' && auto)
        return Quantity.fromDTO(defaultClearance(draft.unitSystem))
      return src === undefined
        ? Quantity.fromDTO(setup[key])
        : Quantity.parse(src, ctxL).mapErr((e) => e.prefixIssues(key))
    }
    const both = collect([parse('clearanceHeight'), parse('retractHeight')])
    if (both.isErr()) return Err(both.unwrapErr().withContext(where))
    const [clearance, retract] = both.unwrap() as [Quantity, Quantity]
    const clamp =
      args.clampHeight === undefined || args.clampHeight === null
        ? undefined
        : Quantity.parse(args.clampHeight, ctxL).mapErr((e) => e.prefixIssues('clampHeight'))
    if (clamp?.isErr()) return Err(clamp.unwrapErr().withContext(where))
    const issues: Issue[] = []
    if (clamp !== undefined && clamp.unwrap().canonical < 0)
      issues.push({ path: ['clampHeight'], rule: 'nonNegative', message: 'must be ≥ 0' })
    if (retract.canonical <= 0)
      issues.push({ path: ['retractHeight'], rule: 'positive', message: 'must be > 0' })
    if (clearance.canonical <= retract.canonical)
      issues.push({
        path: ['clearanceHeight'],
        rule: 'aboveRetract',
        message: 'must be greater than the retract height',
      })
    if (issues.length > 0) return invalid(issues, where)
    const target = draft.plans[args.planId]!.setups.find((s) => s.id === args.setupId)!
    if (args.clearanceHeight !== undefined) {
      target.clearanceHeight = lengthDTO(clearance)
      if (auto) delete target.clearanceHeightSet
      else target.clearanceHeightSet = true
    }
    if (args.retractHeight !== undefined) target.retractHeight = lengthDTO(retract)
    // DF64: `minimum` and an unknown clamp height are stored as absent
    if (args.retraction === 'minimum') delete target.retraction
    else if (args.retraction !== undefined) target.retraction = args.retraction
    if (args.clampHeight === null) delete target.clampHeight
    else if (clamp !== undefined) target.clampHeight = lengthDTO(clamp.unwrap())
    if (args.name !== undefined && args.name !== target.name) target.name = args.name
    // 0° is stored as absent (v0.1 records)
    if (args.rotation === 0) delete target.rotation
    else if (args.rotation !== undefined) target.rotation = args.rotation
    // alignment phase 1: docs/modes/alignment.md#setup-work-zero-q61
    if (args.zero !== undefined) {
      const z = applySetupZero(
        draft,
        args.planId,
        args.setupId,
        args.zero,
        where,
        ctx.services.region2d,
      )
      if (z.isErr()) return z
    }
    return Ok({})
  },
})

const setupSplit = defineCommand({
  kind: 'document',
  name: 'plan.setup.split',
  summary:
    'Move plan operations of a setup into a new setup of the same direction right after it (e.g. rough the top, flip, finish the top later).',
  title: () => 'Split setup',
  machine: false,
  args: z.object({
    ...SetupArg,
    planOperationIds: z.array(PlanRecordIdSchema).min(1).describe('Operations to move'),
    name: z.string().min(1).max(NAME_MAX).optional().describe('Default e.g. "Top 2"'),
  }),
  result: z.object({ setupId: PlanRecordIdSchema }),
  run(draft, args, ctx) {
    const where = 'plan.setup.split'
    const loaded = loadedFor(draft, args.planId, where)
    if (loaded.isErr()) return loaded
    const plan = loaded.unwrap()
    // DF135: already-cut operations keep their place (docs/modes/cut-state.md)
    const cut = firstCut(plan.dto, args.planOperationIds)
    if (cut !== undefined) return cutLocked(plan.dto, cut, where)
    const setups = splitSetup(plan.dto, args, ctx.ids, where)
    if (setups.isErr()) return setups
    const created = setups.unwrap()[plan.setups.findIndex((x) => x.id === args.setupId) + 1]!
    const written = writeSetups(draft, plan, setups.unwrap(), 'planOperationIds', where)
    return written.isErr() ? written : Ok({ setupId: created.id })
  },
})

const setupMerge = defineCommand({
  kind: 'document',
  name: 'plan.setup.merge',
  summary:
    'Join setups of the same direction into the first of them in machining order; different directions fail with plan.setup.',
  title: () => 'Merge setups',
  machine: false,
  args: z.object({ ...PlanArg, setupIds: z.array(PlanRecordIdSchema).min(2) }),
  result: z.object({ setupId: PlanRecordIdSchema }),
  run(draft, args) {
    const where = 'plan.setup.merge'
    const loaded = loadedFor(draft, args.planId, where)
    if (loaded.isErr()) return loaded
    const plan = loaded.unwrap()
    // DF135: a setup with already-cut operations keeps its order
    const cut = firstCut(
      plan.dto,
      plan.setups
        .filter((x) => args.setupIds.includes(x.id))
        .flatMap((x) => x.operations.map((o) => o.id)),
    )
    if (cut !== undefined) return cutLocked(plan.dto, cut, where)
    const setups = mergeSetups(plan.dto, args.setupIds, where)
    if (setups.isErr()) return setups
    const into = setups.unwrap().find((x) => args.setupIds.includes(x.id))!
    const written = writeSetups(draft, plan, setups.unwrap(), 'setupIds', where)
    return written.isErr() ? written : Ok({ setupId: into.id })
  },
})

const setupMove = defineCommand({
  kind: 'document',
  name: 'plan.setup.move',
  summary:
    'Move a setup in the setup order; operations must stay after the ones whose surfaces they start from.',
  title: () => 'Move setup',
  machine: false,
  args: z.object({
    ...SetupArg,
    toIndex: z.number().int().min(0).describe('New 0-based position'),
  }),
  result: Empty,
  run(draft, args) {
    const where = 'plan.setup.move'
    const loaded = loadedFor(draft, args.planId, where)
    if (loaded.isErr()) return loaded
    const plan = loaded.unwrap()
    const from = plan.setups.findIndex((x) => x.id === args.setupId)
    if (from < 0) return unknownSetup(args.setupId, 'setupId', where)
    if (args.toIndex >= plan.setups.length) return pastEnd(plan.setups.length - 1, where)
    if (from === args.toIndex) return Ok({})
    const cut = firstCut(
      plan.dto,
      plan.setups[from]!.operations.map((o) => o.id),
    )
    if (cut !== undefined) return cutLocked(plan.dto, cut, where)
    const setups = [...plan.setups]
    const [moved] = setups.splice(from, 1)
    setups.splice(args.toIndex, 0, moved!)
    const written = writeSetups(draft, plan, setups, 'toIndex', where)
    return written.isErr() ? written : Ok({})
  },
})

const PlanOpArg = { ...PlanArg, planOperationId: PlanRecordIdSchema }

const operationUpdate = defineCommand({
  kind: 'document',
  name: 'plan.operation.update',
  summary:
    'Change preset or auto mode, stickout, entered feeds-and-speeds values, their locks, strategy parameters, or the Z reference of the tool run a plan operation starts.',
  title: () => 'Update plan operation',
  machine: false,
  args: z.object({
    ...PlanOpArg,
    presetName: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe('Tool preset (leaves auto mode, clears locks); null = default'),
    auto: z
      .boolean()
      .optional()
      .describe(
        'true: auto mode, feeds from the calculator (clears presetName); false: back to the default (clears locks)',
      ),
    stickout: Src.nullable().optional().describe("null = the tool's stickout, else flute length"),
    overrides: z
      .object(
        Object.fromEntries(FEED_FIELDS.map((f) => [f, Src.nullable().optional()])) as Record<
          FeedField,
          z.ZodOptional<z.ZodNullable<typeof Src>>
        >,
      )
      .optional()
      .describe('Feeds-and-speeds values as entered; null removes one (and its lock)'),
    locks: z
      .object(
        Object.fromEntries(FEED_FIELDS.map((f) => [f, z.boolean().optional()])) as Record<
          FeedField,
          z.ZodOptional<z.ZodBoolean>
        >,
      )
      .optional()
      .describe(
        'Auto mode only. true locks a field (the other recommendations follow it; pins the shown value when none is entered); false unlocks it and keeps the value',
      ),
    strategy: StrategyArgSchema.optional(),
    zRef: z
      .object({
        surface: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('stock.top or <operation id>.floor'),
        at: z.tuple([Src, Src]).optional().describe('Touch-off spot X, Y in the setup WCS'),
      })
      .nullable()
      .optional()
      .describe(
        "Z reference of the tool run it starts (plan_get toolRuns[].zRef); surface absent = the default surface's spot moved; null = the default",
      ),
  }),
  result: Empty,
  run(draft, args) {
    const where = 'plan.operation.update'
    const loaded = loadedFor(draft, args.planId, where)
    if (loaded.isErr()) return loaded
    const plan = loaded.unwrap()
    const index = findPlanOperation(plan, args.planOperationId, where)
    if (index.isErr()) return index
    if (cutIds(plan.dto).has(args.planOperationId))
      return cutLocked(plan.dto, index.unwrap().op, where)
    const units = draft.unitSystem
    const op: PlanOperationDTO = plainCopy(index.unwrap().op)
    const kind = evaluateOperation(plan, op).kind
    const tool = op.tool === undefined ? undefined : plan.tools.get(op.tool)
    const issues: Issue[] = []
    const parsed: AppResult<unknown>[] = []
    if (args.auto === true && typeof args.presetName === 'string')
      return fail('input.malformed', 'auto mode and a cutting preset exclude each other', {
        issues: [{ path: ['auto'], rule: 'autoAndPreset', message: 'pass auto or presetName' }],
        where,
      })
    if (args.auto === true) {
      op.auto = true
      delete op.presetName
    } else if (args.auto === false) {
      // leaving auto mode clears the locks; entered values stay
      delete op.auto
      delete op.locked
    }
    if (args.presetName === null) delete op.presetName
    else if (args.presetName !== undefined) {
      if (tool === undefined || !tool.presets.some((p) => p.name === args.presetName))
        return fail('input.malformed', `the tool has no preset "${args.presetName}"`, {
          issues: [{ path: ['presetName'], rule: 'unknownPreset', message: 'no such preset' }],
          where,
        })
      op.presetName = args.presetName
      delete op.auto
      delete op.locked
    }
    if (args.stickout === null) delete op.stickout
    else if (args.stickout !== undefined) {
      const q = Quantity.parse(args.stickout, fieldContext('length', units)).mapErr((e) =>
        e.prefixIssues('stickout'),
      )
      parsed.push(q)
      q.map((v) => {
        op.stickout = lengthDTO(v)
        const oal = tool?.overallLength.canonical ?? Infinity
        if (v.canonical <= 0 || v.canonical >= oal)
          issues.push({
            path: ['stickout'],
            rule: 'stickoutRange',
            message: 'must be > 0 and < the overall length',
            params: { max: oal },
          })
      })
    }
    const contexts = parseContexts(units)
    for (const field of FEED_FIELDS) {
      const src = args.overrides?.[field]
      if (src === undefined) continue
      if (src === null) {
        delete op.overrides[field]
        unlock(op, field)
        continue
      }
      if (
        (kind === 'drilling' || kind === 'chamfer') &&
        (field === 'stepdown' || field === 'stepover')
      ) {
        issues.push({
          path: ['overrides', field],
          rule: 'notForKind',
          message: `${kind} has no stepdown/stepover (see strategy)`,
        })
        continue
      }
      const q = Quantity.parse(src, contexts[field]).mapErr((e) =>
        e.prefixIssues('overrides', field),
      )
      parsed.push(q)
      q.map((v) => {
        op.overrides[field] = v.toDTO() as never // kind fixed by parseContexts
        if (v.canonical <= 0)
          issues.push({ path: ['overrides', field], rule: 'positive', message: 'must be > 0' })
        if (tool === undefined) return
        const D = tool.diameter.canonical
        if (field === 'stepover') {
          const max = kind === 'profile' ? D : 0.9 * D
          if (v.canonical > max)
            issues.push({
              path: ['overrides', field],
              rule: 'stepoverMax',
              message: `must be at most ${kind === 'profile' ? 'D' : '0.9 D'}`,
              params: { max },
            })
        }
        if (field === 'stepdown' && kind !== 'facing' && v.canonical > tool.fluteLength.canonical)
          issues.push({
            path: ['overrides', field],
            rule: 'fluteLength',
            message: 'must be at most the flute length',
            params: { max: tool.fluteLength.canonical },
          })
      })
    }
    const all = collect(parsed)
    if (all.isErr()) return Err(all.unwrapErr().withContext(where))
    // DF83: a witness mark's cut is fixed (one plunge or line at the depth of its Ø, S14), and a
    // registration hole's breakthrough is its spoilboardDepth: both are set with plan.aid.set
    if (args.strategy !== undefined && op.aid !== undefined) {
      const keys = Object.keys(args.strategy)
      const fixed = op.aid.kind === 'witnessMark' ? keys : keys.filter((k) => k === 'breakthrough')
      if (fixed.length > 0)
        return fail(
          'plan.aid',
          op.aid.kind === 'witnessMark'
            ? "a witness mark's cut is fixed: set its markDiameter or markDepth with plan.aid.set"
            : "a registration hole's depth below the stock is its spoilboardDepth (plan.aid.set)",
          {
            where,
            issues: fixed.map((k) => ({
              path: ['strategy', k],
              rule: 'aidParameter',
              message: 'set with plan.aid.set',
            })),
          },
        )
    }
    // DF122: a roughing pocket's wall margin is its owner's roughing setting (design), and it
    // has no finishing pass (docs/modes/roughing.md#stock-to-leave-wall-and-floor)
    const roughingKeys = (['finishAllowance', 'finishStepdown'] as const).filter(
      (k) => typeof args.strategy?.[k] === 'string',
    )
    if (
      roughingKeys.length > 0 &&
      evaluateOperation(plan, op).ops.some(
        (o) => (o.kind === 'pocket' || o.kind === 'profile') && o.roughing === true,
      )
    )
      return fail('input.malformed', 'a roughing pocket has no finishing pass', {
        issues: roughingKeys.map((k) => ({
          path: ['strategy', k],
          rule: 'notForRoughing',
          message: "not for a roughing pass: set its owner's roughing wall in the design",
        })),
        where,
      })
    if (args.strategy !== undefined) {
      const s = applyStrategyArgs(kind, op.strategy, args.strategy, units)
      if (s.isErr()) return Err(s.unwrapErr().withContext(where))
      op.strategy = s.unwrap()
      const e = evaluateOperation(plan, op)
      const sctx = {
        ops: e.ops,
        allOps: plan.part.operations,
        stock: plan.stock,
        units,
        tool: e.tool,
        preset: e.preset,
      }
      issues.push(
        ...strategyIssues(kind, op.strategy, resolveStrategy(kind, op.strategy, sctx), sctx),
      )
      // a blind pocket has no breakthrough (only a pattern's through pocket breaks through, P4):
      // refused rather than stored and ignored (DF83's rule); clearing it (null) stays allowed
      if (
        kind === 'pocket' &&
        typeof args.strategy.breakthrough === 'string' &&
        !e.ops.some((o) => o.kind === 'pocket' && o.through === true)
      )
        issues.push({
          path: ['strategy', 'breakthrough'],
          rule: 'throughOnly',
          message: 'a blind pocket has no breakthrough: only a through pocket breaks through',
        })
    }
    if (args.zRef === null) delete op.zRef
    else if (args.zRef !== undefined) {
      // docs/modes/z-reference.md#agent-api-compact: an unknown surface id is refused here, the
      // rest (eligibility, spot) is reported by the plan.zRef findings
      const { surface, at } = args.zRef
      if (surface !== undefined && !knownSurfaceId(plan, surface))
        issues.push({
          path: ['zRef', 'surface'],
          rule: 'unknownSurface',
          message: "no such surface: the setup's stock face (stock.top …) or <operation id>.floor",
        })
      let spot: [number, number] | undefined
      if (at !== undefined) {
        const xy = at.map((src, k) =>
          Quantity.parse(src, fieldContext('length', units)).mapErr((e) =>
            e.prefixIssues('zRef', 'at', k),
          ),
        )
        const both = collect(xy)
        if (both.isErr()) return Err(both.unwrapErr().withContext(where))
        const [x, y] = both.unwrap().map((q) => q.canonical)
        spot = [x!, y!]
      }
      if (surface === undefined && spot === undefined) delete op.zRef
      else
        op.zRef = {
          ...(surface === undefined ? {} : { surface }),
          ...(spot === undefined ? {} : { at: spot }),
        }
    }
    if (issues.length > 0) return invalid(issues, where)
    if (args.locks !== undefined) {
      const locks = args.locks
      for (const f of FEED_FIELDS) if (locks[f] === false) unlock(op, f)
      for (const f of FEED_FIELDS) {
        if (locks[f] !== true || op.locked?.includes(f) === true) continue
        // the lock state of the operation as it is now (earlier locks of this call included)
        const feeds = evaluateOperation(plan, op).feeds
        if (feeds.isNone()) return lockUnavailable(f, 'noTool', 'no tool is assigned', where)
        const r = feeds.unwrap()
        const state = r.locks[f]
        if (state.state === 'unavailable')
          return lockUnavailable(f, state.rule, state.reason, where)
        if (state.state === 'hidden') {
          if (r.auto === 'off')
            return lockUnavailable(f, 'autoOff', 'locks exist only in auto mode', where)
          if (r.auto !== 'on') return lockUnavailable(f, 'noData', r.auto.unavailable, where)
          return lockUnavailable(f, 'notLockable', 'nothing else depends on this field', where)
        }
        if (op.overrides[f] === undefined) {
          const value = r.fields[f].unwrap().value
          const q = Quantity.parse(pinnedSource(f, value, units), contexts[f])
          if (q.isErr()) return Err(q.unwrapErr().withContext(where))
          op.overrides[f] = q.unwrap().toDTO() as never // kind fixed by parseContexts
        }
        op.auto = true // the default auto mode becomes a choice
        op.locked = [...(op.locked ?? []), f]
      }
    }
    const modeIssues = feedModeIssues(op, kind)
    if (modeIssues.length > 0) return invalid(modeIssues, where)
    const { setup, index: i } = index.unwrap()
    const target = draft.plans[args.planId]!.setups[setup]!.operations
    if (!deepEqual(target[i], op)) target[i] = op
    return Ok({})
  },
})

const operationMove = defineCommand({
  kind: 'document',
  name: 'plan.operation.move',
  summary:
    'Move a plan operation (or, with count, a block such as a tool run) in the machining order, also into another setup of the same direction; it must stay after the operations whose surfaces it starts from.',
  title: () => 'Move plan operation',
  machine: false,
  args: z.object({
    ...PlanOpArg,
    toIndex: z.number().int().min(0).describe('New 0-based position in the target setup'),
    toSetupId: PlanRecordIdSchema.optional().describe('Same direction; default its own setup'),
    count: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Move this many consecutive operations from it as a block (a tool run); default 1'),
  }),
  result: Empty,
  run(draft, args) {
    const where = 'plan.operation.move'
    const loaded = loadedFor(draft, args.planId, where)
    if (loaded.isErr()) return loaded
    const plan = loaded.unwrap()
    const from = findPlanOperation(plan, args.planOperationId, where)
    if (from.isErr()) return from
    const { setup: si, index } = from.unwrap()
    const source = plan.setups[si]!
    const ti =
      args.toSetupId === undefined ? si : plan.setups.findIndex((x) => x.id === args.toSetupId)
    const target = plan.setups[ti]
    if (target === undefined) return unknownSetup(args.toSetupId ?? '', 'toSetupId', where)
    if (setupDirection(target) !== setupDirection(source))
      return directionMismatch(setupDirection(source), setupDirection(target), 'toSetupId', where)
    // a block of `count` (DF66: a tool run); `toIndex` is its first position after the move
    const count = args.count ?? 1
    if (index + count > source.operations.length) return pastSetupEnd(source, index, where)
    const max = ti === si ? target.operations.length - count : target.operations.length
    if (args.toIndex > max) return pastEnd(max, where)
    if (ti === si && index === args.toIndex) return Ok({})
    const setups = plan.setups.map((x) => ({ ...x, operations: [...x.operations] }))
    const moved = setups[si]!.operations.splice(index, count)
    setups[ti]!.operations.splice(args.toIndex, 0, ...moved)
    // DF135: already-cut operations keep their place, and nothing moves before one in its setup
    const cut = cutIds(plan.dto)
    const cutMoved = moved.find((o) => cut.has(o.id))
    if (cutMoved !== undefined) return cutLocked(plan.dto, cutMoved, where)
    const passed = setups[ti]!.operations.slice(args.toIndex + count).find((o) => cut.has(o.id))
    if (passed !== undefined) return cutLocked(plan.dto, passed, where)
    const written = writeSetups(draft, plan, setups, 'toIndex', where)
    return written.isErr() ? written : Ok({})
  },
})

const toolAssign = defineCommand({
  kind: 'document',
  name: 'plan.tool.assign',
  summary:
    "Assign a library tool to a plan operation (the plan takes or reuses a copy); resets the preset to the default. Marks it toolSource 'plan': rebuilds keep it.",
  title: () => 'Assign tool',
  machine: false,
  args: z.object({ ...PlanOpArg, toolLibraryItemId: ItemIdSchema }),
  result: Empty,
  run(draft, args, ctx) {
    const where = 'plan.tool.assign'
    const loaded = loadedFor(draft, args.planId, where)
    if (loaded.isErr()) return loaded
    const index = findPlanOperation(loaded.unwrap(), args.planOperationId, where)
    if (index.isErr()) return index
    if (cutIds(loaded.unwrap().dto).has(args.planOperationId))
      return cutLocked(loaded.unwrap().dto, index.unwrap().op, where)
    const item = libraryItem(ctx, 'tool', args.toolLibraryItemId, 'toolLibraryItemId', where)
    if (item.isErr()) return item
    const plan = plainCopy(loaded.unwrap().dto)
    const r = assignTool(plan, args.planOperationId, item.unwrap(), {
      ids: ctx.ids,
      now: nowIso(ctx),
    })
    if (r.isErr()) return Err(r.unwrapErr().withContext(where))
    // a deliberate plan decision: wins over the design tool field (plan-v0.2.md § Tool resolution)
    const ref = findPlanOperation(plan, args.planOperationId, where)
    if (ref.isOk()) {
      const op = plan.setups[ref.unwrap().setup]!.operations[ref.unwrap().index]!
      op.toolSource = 'plan'
      delete op.designToolChanged
    }
    writePlan(draft, plan)
    return Ok({})
  },
})

// ── draft follow (apply hook) ─────────────────────────────────────────────────────────────

/**
 * `plan.draftFollow`, the second apply hook (docs/architecture/apply.md#apply-hooks): on the
 * Apply draft, rebuilds every `draft` plan whose part has pending design changes (or that is
 * itself pending as not following its part) and whose snapshot differs from the part; then
 * re-imports the copies of pending library items in every `draft` plan (decision 5). Plans are
 * downstream of the design: a plan that cannot follow is left as it was and reported
 * (`blocked`), never an Apply failure (replaces v0.1's `plan.draftAutoRebuild` document hook).
 */
export const planDraftFollow: ApplyHook = {
  name: 'plan.draftFollow',
  apply(draft, pending, ctx) {
    const where = 'plan.draftFollow'
    const parts = new Set<string>()
    const plans = new Set<string>()
    const items = new Set<string>()
    for (const c of pending) {
      if (c.kind === 'design' && c.partId !== undefined) parts.add(c.partId)
      else if (c.kind === 'plan' && c.field === 'design' && c.planId !== undefined)
        plans.add(c.planId)
      else if (c.kind === 'library' && c.libraryItemId !== undefined) items.add(c.libraryItemId)
    }
    const lookup = ctx.services.library?.lookup
    const out: PlanApply[] = []
    for (const id of Object.keys(draft.plans)) {
      const current = draft.plans[id] as PlanDTO
      if (current.status !== 'draft') continue
      let plan = plainCopy(current)
      let status: PlanApply['status'] | undefined
      const reasons: string[] = []
      const follows = parts.has(plan.design.partId) || plans.has(plan.id)
      if (follows && designChanged(plan, draft as ProjectDoc)) {
        const rebuilt = rebuild(draft, plan, ctx, where)
        if (rebuilt.isOk()) {
          plan = rebuilt.unwrap()
          status = 'rebuilt'
        } else reasons.push(`rebuildBlocked: ${rebuilt.unwrapErr().message}`)
      }
      if (items.size > 0 && lookup !== undefined)
        for (const c of planStale(plan, draft as ProjectDoc, lookup, ctx.services.region2d)
          .libraryCopies) {
          if (c.status !== 'libraryChanged' || !items.has(c.libraryItemId)) continue
          const r =
            c.blocked === null
              ? refreshCopy(plan, c.snapshotId, draft.unitSystem, ctx, where)
              : fail('model.invariant', c.blocked, { where })
          if (r.isErr()) reasons.push(`libraryBlocked: ${r.unwrapErr().message}`)
          else if (r.unwrap()) status ??= 'followed'
        }
      if (status !== undefined) writePlan(draft, plan)
      if (reasons.length > 0)
        out.push({ planId: id, status: 'blocked', reason: reasons.join('; ') })
      else if (status !== undefined) out.push({ planId: id, status })
    }
    return Ok({ plans: out })
  },
}

// ── queries ───────────────────────────────────────────────────────────────────────────────

const planList = defineQuery({
  name: 'plan.list',
  summary: 'List the plans of the project with status; archived ones only with includeArchived.',
  args: z.object({ includeArchived: z.boolean().optional() }),
  result: z.object({
    plans: z.array(
      z.object({
        id: PlanIdSchema,
        name: z.string(),
        status: PlanStatusSchema,
        partId: PartIdSchema,
      }),
    ),
  }),
  run(doc, args) {
    return Ok({
      plans: Object.values(doc.plans)
        .filter((p) => args.includeArchived === true || p.status !== 'archived')
        .map((p) => ({ id: p.id, name: p.name, status: p.status, partId: p.design.partId })),
    })
  },
})

const planGet = defineQuery({
  name: 'plan.get',
  summary: 'Get a plan record: status, design snapshot, library copies and setup.',
  args: z.object(PlanArg),
  result: z.object({
    plan: PlanDtoSchema,
    effectiveClearance: z
      .array(
        z.object({
          setupId: z.string(),
          clearanceHeight: z.number().describe('mm above Z0'),
          reason: z.enum(['set', 'default', 'workholding']),
          item: z.string().optional().describe('workholding: the highest item (top + margin)'),
          margin: z.number().optional().describe('mm'),
        }),
      )
      .describe(
        "The setups' programmed clearance heights; setups[].clearanceHeight is the setting",
      ),
  }),
  run(doc, args) {
    const where = 'plan.get'
    return findPlanDTO(doc, args.planId, where).map((plan) => ({
      plan,
      effectiveClearance: effectiveClearances(plan, doc.unitSystem),
    }))
  },
})

/**
 * The clearance height each setup's program uses (DF90): the stored setting, or raised by the
 * workholding (workholding.md#links-and-safe-heights); none for a plan that does not load.
 */
function effectiveClearances(plan: PlanDTO, units: UnitSystem) {
  const loaded = loadPlanDTO(plan, units, 'plan.get')
  if (loaded.isErr()) return []
  const stock = loaded.unwrap().stock
  return plan.setups.map((setup) => {
    const h = setupWorkholding(setup, stock)
    const from = h.items.find((i) => i.id === h.clearanceFrom)
    return {
      setupId: setup.id,
      clearanceHeight: h.clearance,
      ...(from !== undefined
        ? { reason: 'workholding' as const, item: from.name, margin: h.margin }
        : { reason: h.clearanceSet ? ('set' as const) : ('default' as const) }),
    }
  })
}

/**
 * DF139: a recommended preset's value lowered to the plan machine; absent when not adapted.
 * Doc: docs/architecture/feeds-speeds.md#recommended-presets-on-the-plan-machine-hardening-df139
 */
const AdaptedDTO = z
  .object({
    from: z.number().describe('The stored preset value (same unit)'),
    reason: z.enum(['spindleRange', 'maxFeedRate', 'maxFeedRateZ', 'power']),
  })
  .optional()
  .describe('Recommended preset adapted down to the plan machine')

const adaptedOf = (v: ResolvedFeed) =>
  v.adapted === undefined ? {} : { adapted: { ...v.adapted } }

const FeedValue = z
  .object({
    value: z.number(),
    unit: z.string(),
    source: z.enum(['override', 'preset', 'calculator', 'strategy']),
    adapted: AdaptedDTO,
    locked: z.boolean().describe('Locked: the other recommendations follow this value'),
    recommended: z
      .object({ value: z.number(), unit: z.string() })
      .nullable()
      .describe('Auto mode: what the field would be without its entered value'),
    lock: z
      .discriminatedUnion('state', [
        z.object({ state: z.literal('hidden') }),
        z.object({ state: z.literal('available') }),
        z.object({
          state: z.literal('unavailable'),
          rule: z
            .string()
            .describe('invalid, spindleRange, feedLimit, toolLength, stepoverAboveTool, power'),
          reason: z.string(),
        }),
      ])
      .describe('hidden outside auto mode and on fields nothing depends on'),
  })
  .nullable()

const AutoDTO = z.union([
  z.enum(['on', 'off']),
  z.object({ unavailable: z.string().describe('Why: no calculator data for the tool and stock') }),
])

const lockDTO = (l: LockState) =>
  l.state === 'unavailable'
    ? { state: l.state, rule: l.rule, reason: l.reason }
    : { state: l.state }

/** DF132 H3: what decides a minimum stickout (docs/modes/tool-holder.md#minimum-stickout-gains-the-clamp-term). */
const StickoutReasonDTO = z.object({
  kind: z.enum(['cut', 'workholding']),
  planOperationId: z.string(),
  clamps: z
    .enum(['checked', 'pending', 'none'])
    .describe('pending: toolpaths not current, clamps not yet checked; none: no holder or items'),
  itemId: z.string().optional(),
  itemName: z.string().optional(),
  part: z.enum(['nut', 'body']).optional(),
  x: z.number().optional().describe('mm, WCS'),
  y: z.number().optional().describe('mm, WCS'),
  z: z.number().optional().describe('mm, WCS: the tip at that move'),
})

const operationList = defineQuery({
  name: 'plan.operation.list',
  summary:
    'List the plan operations in machining order with tool, preset, resolved feeds and speeds (with source per field) and strategy.',
  args: z.object(PlanArg),
  result: z.object({
    operations: z.array(
      z.object({
        id: PlanRecordIdSchema,
        kind: z.enum(['facing', 'pocket', 'drilling', 'profile', 'chamfer', 'line']),
        designOperationIds: z.array(OperationIdSchema),
        tool: z
          .object({ snapshotId: z.string(), libraryItemId: z.string(), name: z.string() })
          .nullable(),
        presetName: z
          .string()
          .nullable()
          .describe('The preset in use (default or chosen); null in auto mode'),
        auto: AutoDTO.describe(
          'Auto mode (calculator): on, off (a preset is used) or unavailable (no data) with the reason',
        ),
        stickout: z.number().nullable().describe('mm'),
        stickoutNeeded: z
          .number()
          .nullable()
          .describe('mm: max(deepest cut, clamp under the holder) + 5 mm; null without a tool'),
        stickoutReason: StickoutReasonDTO.nullable().describe(
          'What decides stickoutNeeded; null without a tool',
        ),
        feeds: z.object(
          Object.fromEntries(FEED_FIELDS.map((f) => [f, FeedValue])) as Record<
            FeedField,
            typeof FeedValue
          >,
        ),
        chipLoad: z.number().nullable().describe('feed ÷ (rpm × flutes), mm; derived'),
        strategy: z
          .record(z.string(), z.union([z.number(), z.string()]))
          .describe('Resolved strategy parameters (mm, °)'),
        throughDepth: z
          .number()
          .nullable()
          .describe(
            'mm; a through profile or pocket: the material it cuts through below the stock face (less what an earlier setup cleared under it from the opposite face). Cut depth = throughDepth + strategy.breakthrough; to cut to depth D set breakthrough = D − throughDepth. Null otherwise',
          ),
      }),
    ),
  }),
  run(doc, args, ctx) {
    const loaded = loadPlan(doc, args.planId, 'plan.operation.list')
    if (loaded.isErr()) return loaded
    const plan = loaded.unwrap()
    const port = ctx.services.region2d
    // DF132 H3: the clamp term over the current toolpaths (tool-holder.md#minimum-stickout-gains-the-clamp-term)
    const cache = ctx.services.toolpaths
    // H6: a tool's own holder counts as the machine's does
    const holderChecked = planHasHolder(plan)
    const inputs =
      holderChecked && cache !== undefined
        ? planOperationInputs(doc, args.planId, undefined, port).mapOr<
            PlanOperationInput[] | undefined
          >(undefined, (v) => v)
        : undefined
    const stickouts = holderChecked
      ? planStickouts(plan, inputs, (i) => cache?.get(i.inputHash), port)
      : new Map()
    return Ok({
      operations: plan.operations.map((op) => {
        const e = evaluateOperation(plan, op, undefined, undefined, port)
        const so = stickouts.get(op.id)
        const snap = plan.dto.snapshots.find((s) => s.id === op.tool)
        const feeds = Object.fromEntries(
          FEED_FIELDS.map((f) => [
            f,
            e.feeds.mapOr(null, (r) =>
              r.fields[f].mapOr(null, (v) => ({
                value: v.value,
                unit: v.unit,
                source: v.source,
                ...adaptedOf(v),
                locked: r.locked.includes(f),
                recommended: r.recommended[f].mapOr(null, (value) => ({ value, unit: v.unit })),
                lock: lockDTO(r.locks[f]),
              })),
            ),
          ]),
        ) as Record<FeedField, z.output<typeof FeedValue>>
        const auto = e.feeds.mapOr<z.output<typeof AutoDTO>>(e.autoRequested ? 'on' : 'off', (r) =>
          typeof r.auto === 'string' ? r.auto : { unavailable: r.auto.unavailable },
        )
        const { kind: _, ...strategy } = e.strategy
        return {
          id: op.id,
          kind: e.kind,
          designOperationIds: [...op.designOperationIds],
          tool:
            snap === undefined || e.tool.isNone()
              ? null
              : {
                  snapshotId: snap.id,
                  // tool copies always come from the library
                  libraryItemId: snap.libraryItemId ?? '',
                  name: e.tool.unwrap().name,
                },
          presetName: e.preset.mapOr(null, (p) => p.name),
          auto,
          stickout: e.stickout.unwrapOr(null as unknown as number),
          stickoutNeeded:
            so?.clamps === 'checked' && e.stickoutNeeded.isSome()
              ? so.needed
              : e.stickoutNeeded.unwrapOr(null as unknown as number),
          stickoutReason: e.stickoutNeeded.isNone()
            ? null
            : so?.clamps === 'checked'
              ? { ...so.reason, clamps: 'checked' as const }
              : {
                  kind: 'cut' as const,
                  planOperationId: op.id,
                  clamps: so === undefined ? ('none' as const) : ('pending' as const),
                },
          feeds,
          chipLoad: e.feeds.andThen((f) => f.chipLoad).unwrapOr(null as unknown as number),
          strategy: strategy as Record<string, number | string>,
          throughDepth: planThroughDepth(plan, e.ops, port),
        }
      }),
    })
  },
})

const Num = z.number()
const FeedExplained = z
  .object({
    value: Num,
    unit: z.string(),
    source: z.enum(['override', 'preset', 'calculator', 'strategy']),
    adapted: AdaptedDTO,
    derivation: z.array(StepSchema).nullable().describe('calculator source only'),
  })
  .nullable()
const operationFeedsGet = defineQuery({
  name: 'plan.operation.feeds.get',
  summary:
    "Explain a plan operation's feeds and speeds: calculator inputs, each field's source and formulas, and surface speed, chip thinning, power and spindle load.",
  args: z.object(PlanOpArg),
  result: z.object({
    auto: AutoDTO,
    inputs: z
      .object({
        materialClass: z.string(),
        toolMaterial: z.string().nullable(),
        diameter: Num.describe('mm'),
        fluteCount: Num,
        cornerRadius: Num.describe('Effective corner radius, mm'),
        engagement: z.object({
          kind: z.enum(['slot', 'stepover', 'helix', 'drill', 'chamfer', 'taper']),
          ae: Num.optional().describe('Stepover, mm'),
          ap: Num.optional().describe('Helix pitch, mm'),
          depth: Num.optional().describe(
            'Chamfer depth below the tip, or the taper Line depth, mm',
          ),
        }),
        rigidity: z.string().describe('Machine rigidity (default without a machine)'),
        spindlePower: Num.nullable().describe('W; null: power check skipped'),
      })
      .nullable()
      .describe('null without a tool'),
    fields: z.object(
      Object.fromEntries(FEED_FIELDS.map((f) => [f, FeedExplained])) as Record<
        FeedField,
        typeof FeedExplained
      >,
    ),
    used: z
      .object({
        dCalc: Num.describe('mm'),
        vc: Num.describe('Surface speed, m/min'),
        fz: Num.describe('Chip load after chip thinning, mm (drills: mm/rev)'),
        chipThinning: Num,
        Q: Num.nullable().describe('mm³/min'),
        Pc: Num.nullable().describe('kW'),
        spindleLoad: Num.nullable().describe('%'),
      })
      .nullable()
      .describe('At the values used; null without calculator data'),
    finish: z
      .object({
        allowance: Num.describe('Finishing allowance (radial engagement), mm'),
        feedRate: Num.describe('Finishing feed, mm/min'),
        chipThinning: Num,
        fz: Num.describe('Finishing chip after chip thinning, mm'),
        clamped: z.boolean().describe('Held at the machine feed limit'),
      })
      .nullable()
      .describe('Finishing pass (DF74); null without a finishing pass or calculator data'),
  }),
  run(doc, args) {
    const where = 'plan.operation.feeds.get'
    const loaded = loadPlan(doc, args.planId, where)
    if (loaded.isErr()) return loaded
    const plan = loaded.unwrap()
    const index = findPlanOperation(plan, args.planOperationId, where)
    if (index.isErr()) return index
    const e = evaluateOperation(plan, index.unwrap().op)
    const auto = e.feeds.mapOr<z.output<typeof AutoDTO>>(e.autoRequested ? 'on' : 'off', (r) =>
      typeof r.auto === 'string' ? r.auto : { unavailable: r.auto.unavailable },
    )
    const machine = plan.machine.map(machineLimits)
    const inputs = e.tool.isNone()
      ? null
      : (() => {
          const t = e.tool.unwrap()
          const g = e.feeds.unwrap().engagement
          return {
            materialClass: plan.stock.material.class,
            toolMaterial: t.toolMaterial.mapOr<string | null>(null, (m) => m),
            diameter: t.diameter.canonical,
            fluteCount: t.fluteCount.canonical,
            cornerRadius: t.effectiveCornerRadius.toNumber(),
            engagement:
              g.kind === 'stepover'
                ? { kind: g.kind, ae: g.ae }
                : g.kind === 'helix'
                  ? { kind: g.kind, ap: g.ap }
                  : g.kind === 'chamfer' || g.kind === 'taper'
                    ? { kind: g.kind, depth: g.depth }
                    : { kind: g.kind },
            rigidity: machine.mapOr<string>(DEFAULT_RIGIDITY, (m) => m.rigidity),
            spindlePower: machine.andThen((m) => m.power).unwrapOr(null as unknown as number),
          }
        })()
    const fields = Object.fromEntries(
      FEED_FIELDS.map((f) => [
        f,
        e.feeds.mapOr(null, (r) =>
          r.fields[f].mapOr(null, (v) => ({
            value: v.value,
            unit: v.unit,
            source: v.source,
            ...adaptedOf(v),
            derivation: v.derivation === undefined ? null : v.derivation.map(stepToDTO),
          })),
        ),
      ]),
    ) as Record<FeedField, z.output<typeof FeedExplained>>
    const used = e.feeds
      .andThen((r) => r.used)
      .mapOr(null, (d) => ({
        dCalc: d.dCalc,
        vc: d.vc,
        fz: d.fz,
        chipThinning: d.chipThinning,
        Q: d.Q.unwrapOr(null as unknown as number),
        Pc: d.Pc.unwrapOr(null as unknown as number),
        spindleLoad: d.spindleLoad.unwrapOr(null as unknown as number),
      }))
    const finish = e.feeds
      .andThen((r) => r.finish)
      .mapOr(null, (f) => ({
        allowance: f.allowance,
        feedRate: f.feedRate,
        chipThinning: f.chipThinning,
        fz: f.fz,
        clamped: f.clamped,
      }))
    return Ok({ auto, inputs, fields, used, finish })
  },
})

const staleList = defineQuery({
  name: 'plan.stale.list',
  summary:
    'List what is stale in a plan: operations changed or removed in the design or edited in the plan, and library copies whose item changed or was removed.',
  args: z.object(PlanArg),
  result: z.object({
    pendingApply: z
      .boolean()
      .describe('Its inputs have changes not applied yet: this plan updates on Apply'),
    partRemoved: z.boolean(),
    partChanged: z
      .array(z.string())
      .describe('Part-level fields that differ from the design, e.g. generalTolerance'),
    rebuildBlocked: z.string().nullable().describe('A draft that could not follow the design: why'),
    rebuildBlockedFields: z
      .array(z.string())
      .describe("The design part's fields that block the rebuild, e.g. operations.pocket1.depth"),
    operations: z.array(
      z.object({
        operationId: OperationIdSchema,
        changedInDesign: z.boolean(),
        removedFromDesign: z.boolean(),
        disabledInDesign: z
          .boolean()
          .describe('Switched off in Design (DF106): a rebuild leaves it out until enabled there'),
        editedInPlan: z.boolean(),
        designToolChanged: z
          .boolean()
          .describe("The design's tool field changed; a plan-assigned tool was kept"),
      }),
    ),
    libraryCopies: z.array(
      z.object({
        snapshotId: z.string(),
        kind: z.enum(['stock', 'tool', 'machine']),
        libraryItemId: z.string(),
        status: z.enum(['libraryChanged', 'libraryRemoved', 'libraryUnreadable']),
        blocked: z
          .string()
          .nullable()
          .describe("Why re-importing this copy can't be applied (it stays a notice)"),
        blockedFields: z
          .array(z.string())
          .describe(
            "The part's fields that don't fit the new stock, e.g. operations.pocket1.depth",
          ),
      }),
    ),
  }),
  run(doc, args, ctx) {
    return findPlanDTO(doc, args.planId, 'plan.stale.list').map((plan) => {
      const s = planStale(plan, doc, ctx.services.library?.lookup, ctx.services.region2d)
      return {
        pendingApply: planPendingApply(plan, ctx.apply?.pending() ?? []),
        partRemoved: s.partRemoved,
        partChanged: [...s.partChanged],
        rebuildBlocked: s.rebuildBlocked,
        rebuildBlockedFields: [...s.rebuildBlockedFields],
        operations: [...s.operations],
        libraryCopies: s.libraryCopies.map((c) => ({ ...c, blockedFields: [...c.blockedFields] })),
      }
    })
  },
})

const toolSuggest = defineQuery({
  name: 'plan.tool.suggest',
  summary:
    "Rank the library tools that pass a plan operation's checks (design tool match, material preset, already used, largest diameter), with reasons.",
  args: z.object(PlanOpArg),
  result: z.object({
    tools: z.array(
      z.object({
        toolLibraryItemId: z.string(),
        name: z.string(),
        diameter: z.number().describe('mm'),
        designTool: z.boolean().describe("The library tool of the design's specific tool"),
        matchesDesign: z.boolean().describe("Type and diameter (and RE) of the design's tool"),
        hasPreset: z.boolean(),
        usedInPlan: z.boolean(),
        reasons: z.array(z.string()),
      }),
    ),
  }),
  run(doc, args, ctx) {
    const where = 'plan.tool.suggest'
    const loaded = loadPlan(doc, args.planId, where)
    if (loaded.isErr()) return loaded
    const index = findPlanOperation(loaded.unwrap(), args.planOperationId, where)
    if (index.isErr()) return index
    const op = index.unwrap().op
    return Ok({
      tools: suggestTools(
        loaded.unwrap(),
        op,
        libraryTools(ctx.services),
        ctx.services.region2d,
      ).map((t) => ({
        ...t,
        reasons: [...t.reasons],
      })),
    })
  },
})

/** A blocked finding's failing part fields for agents (`params.fields`, comma-separated paths). */
const fieldsParam = (fields: readonly string[]): Record<string, string> =>
  fields.length === 0 ? {} : { fields: fields.join(',') }

const ZRefCandidateSchema = z.object({
  surface: z.string(),
  label: z.string(),
  level: z.number().describe('Setup-frame Z of the surface, mm (≤ 0)'),
  at: z.tuple([z.number(), z.number()]).describe('Touch-off spot X, Y in the setup WCS, mm'),
  area: z.number().describe('Flat patch area, mm²'),
  small: z.boolean().describe('Room for the tool but not the touch plate'),
  top: z.boolean().describe("The setup's up face"),
})
const ZRefPoint = z.tuple([z.number(), z.number()])
const ZRefPolygonSchema = z.object({
  outer: z.array(ZRefPoint),
  holes: z.array(z.array(ZRefPoint)),
})
const ZRefRunSchema = z.object({
  setupId: z.string(),
  planOperationId: z.string().describe("The tool run's first operation (stores a choice)"),
  toolNumber: z.number().int(),
  zRef: ZRefCandidateSchema.extend({
    chosen: z.boolean(),
    rule: z.enum(['top', 'facing', 'largest', 'chosen']),
  }).nullable(),
  candidates: z.array(ZRefCandidateSchema),
  outline: z
    .object({
      patch: z.array(ZRefPolygonSchema).describe('The flat patch, setup WCS mm'),
      spotArea: z
        .array(ZRefPolygonSchema)
        .describe('Where the spot may lie: the patch eroded by the clearance radius'),
      clearance: z.number().describe('Room around the spot for the tool or plate, mm'),
      grid: z.number().describe('Spot grid, mm'),
    })
    .nullable()
    .describe("The reference's outline for the viewport (left out of agents' results)"),
})

const candidateDTO = (c: ZRefCandidate): z.output<typeof ZRefCandidateSchema> => ({
  surface: c.surface,
  label: c.label,
  level: c.level,
  at: [c.at[0], c.at[1]],
  area: c.area,
  small: c.small,
  top: c.top,
})

const polygonsDTO = (ps: ZRefOutline['patch']) =>
  ps.map((p) => ({
    outer: p.outer.map((q): [number, number] => [q[0], q[1]]),
    holes: p.holes.map((h) => h.map((q): [number, number] => [q[0], q[1]])),
  }))

const outlineDTO = (o: ZRefOutline) => ({
  patch: polygonsDTO(o.patch),
  spotArea: polygonsDTO(o.spotArea),
  clearance: o.clearance,
  grid: o.grid,
})

const SetupLinksSchema = z.object({
  setupId: z.string(),
  links: z
    .object({
      count: z.number().int().describe('Links between operations of one tool run, no pause'),
      low: z.number().int().describe('Lowered below the clearance height'),
      atClearance: z.number().int(),
      seconds: z.number().nullable().describe('Their rapid time (s); null without a machine'),
      savedSeconds: z.number().nullable().describe('Saved against the clearance height (s)'),
      lowered: z
        .array(
          z.object({
            index: z.number().int(),
            trim: z.number().int(),
            tail: z.array(z.tuple([z.number(), z.number(), z.number()])),
            head: z.array(z.tuple([z.number(), z.number(), z.number()])),
            savedSeconds: z.number(),
          }),
        )
        .describe('Lowered links as rapids for the plan and run scenes (not in plan_get)'),
    })
    .nullable(),
})

const warningList = defineQuery({
  name: 'plan.warning.list',
  summary:
    'List the checks of a plan: tool, feeds and order errors (they block toolpaths), machine and calculator warnings.',
  args: z.object(PlanArg),
  result: z.object({
    warnings: z.array(PlanWarningSchema),
    pendingApply: z
      .boolean()
      .describe('Its inputs have changes not applied yet: the checks are outdated until Apply'),
    zRefs: z
      .array(ZRefRunSchema)
      .describe('Z reference and touch-off spot per tool run (DF69); empty without geometry'),
    links: z
      .array(SetupLinksSchema)
      .describe('Links between operations per setup (DF64); null until its toolpaths are current'),
    alignment: z
      .array(SetupAlignmentSchema)
      .describe('Work zero and alignment points of each setup that has either (alignment phase 1)'),
    alignmentSources: z
      .array(
        z.object({
          setupId: z.string(),
          sources: z.array(
            z.object({
              source: AlignmentSourceDtoSchema,
              name: z.string(),
              kind: z.enum(['point', 'hole', 'edge']),
              at: z.tuple([z.number(), z.number()]).describe('X, Y in the setup frame (mm)'),
            }),
          ),
        }),
      )
      .describe('Sources each setup may use for a point (the inspector menu; not in plan_get)'),
  }),
  run(doc, args, ctx) {
    const where = 'plan.warning.list'
    const dto = findPlanDTO(doc, args.planId, where)
    if (dto.isErr()) return dto
    const loaded = loadPlanDTO(dto.unwrap(), doc.unitSystem, where)
    const findings: PlanWarning[] = loaded.isOk()
      ? [
          ...planFindings(loaded.unwrap(), undefined, ctx.services.region2d),
          ...(ctx.services.region2d === undefined
            ? []
            : shapeFindings(loaded.unwrap(), ctx.services.region2d)),
          ...designToolFindings(loaded.unwrap(), libraryTools(ctx.services), ctx.services.region2d),
          ...zRefFindings(loaded.unwrap(), ctx.services.region2d),
          ...alignmentFindings(loaded.unwrap(), ctx.services.region2d),
          ...planWorkholdingFindings(doc, loaded.unwrap(), ctx.services),
        ]
      : [
          {
            code: 'plan.broken',
            severity: 'error',
            message: `the plan record does not load: ${loaded.unwrapErr().message}`,
            rule: 'load',
            params: {},
          },
        ]
    dropShadowedShortStickout(findings)
    // DF135: an already-cut operation keeps its errors (they block its removal) and its cut
    // findings only (docs/modes/cut-state.md#what-a-cut-operation-means-in-its-plan)
    if (loaded.isOk()) {
      const cut = cutIds(loaded.unwrap().dto)
      for (let i = findings.length - 1; i >= 0; i--) {
        const f = findings[i]!
        if (
          f.planOperationId !== undefined &&
          cut.has(f.planOperationId) &&
          f.severity !== 'error' &&
          !f.code.startsWith('plan.cut')
        )
          findings.splice(i, 1)
      }
    }
    const stale = planStale(dto.unwrap(), doc, ctx.services.library?.lookup, ctx.services.region2d)
    for (const c of stale.libraryCopies)
      if (c.blocked !== null)
        findings.push({
          code: 'plan.libraryBlocked',
          severity: 'warning',
          message: c.blocked,
          field: `snapshots.${c.snapshotId}`,
          rule: 'partFits',
          params: {
            snapshotId: c.snapshotId,
            libraryItemId: c.libraryItemId,
            ...fieldsParam(c.blockedFields),
          },
        })
    if (stale.rebuildBlocked !== null)
      findings.push({
        code: 'plan.rebuildBlocked',
        severity: 'warning',
        message: stale.rebuildBlocked,
        rule: 'partFits',
        params: fieldsParam(stale.rebuildBlockedFields),
      })
    const runs = loaded.isOk() ? planZReferences(loaded.unwrap(), ctx.services.region2d) : []
    // DF64: the links of every setup whose toolpaths are current, and their findings
    const links: z.output<typeof SetupLinksSchema>[] = []
    if (loaded.isOk()) {
      const plan = loaded.unwrap()
      const cache = ctx.services.toolpaths
      const inputs =
        cache === undefined
          ? undefined
          : planOperationInputs(doc, args.planId, undefined, ctx.services.region2d).mapOr<
              PlanOperationInput[] | undefined
            >(undefined, (v) => v)
      const timed = plan.machine.isSome()
      for (const s of plan.setups) {
        findings.push(...clampFindings(s, plan.stock))
        const own =
          inputs === undefined || cache === undefined
            ? undefined
            : currentSetupLinks(inputs, cache, s, plan.stock, plan.machine)
        if (own !== undefined && setupRetraction(s) === 'minimum')
          findings.push(...linksFindings(s.id, own, timed))
        links.push({ setupId: s.id, links: own === undefined ? null : linksSummaryDTO(own, timed) })
      }
    }
    return Ok({
      warnings: namedPlanMessages(dto.unwrap(), findings).map((w) => ({
        ...w,
        params: { ...w.params },
      })),
      pendingApply: planPendingApply(dto.unwrap(), ctx.apply?.pending() ?? []),
      zRefs: runs
        .filter((r) => r.run >= 0)
        .map((r) => ({
          setupId: r.setupId,
          planOperationId: r.planOperationId,
          toolNumber: r.toolNumber,
          zRef:
            r.zRef === undefined
              ? null
              : { ...candidateDTO(r.zRef), chosen: r.zRef.chosen, rule: r.zRef.rule },
          candidates: r.candidates.map(candidateDTO),
          outline: r.outline === undefined ? null : outlineDTO(r.outline),
        })),
      links,
      alignment: loaded.isOk() ? alignmentView(loaded.unwrap(), ctx.services.region2d) : [],
      alignmentSources: loaded.isOk()
        ? loaded.unwrap().setups.map((s) => ({
            setupId: s.id,
            sources: alignmentSources(loaded.unwrap(), s, ctx.services.region2d).map((o) => ({
              source: o.source,
              name: o.name,
              kind: o.kind,
              at: [
                Math.round(o.frame[0] * 1000) / 1000 || 0,
                Math.round(o.frame[1] * 1000) / 1000 || 0,
              ] as [number, number],
            })),
          }))
        : [],
    })
  },
})

/**
 * The workholding findings of a plan (docs/modes/workholding.md#collision-check): the move check
 * runs on each setup whose toolpaths are all current in the cache.
 */
function planWorkholdingFindings(
  doc: ProjectDoc,
  plan: LoadedPlan,
  services: Services,
): PlanWarning[] {
  const inputs = planOperationInputs(doc, plan.dto.id, undefined, services.region2d)
  const cache = services.toolpaths
  return workholdingFindings(
    plan,
    // DF135: already-cut operations are not in the program
    inputs.isOk() ? inputs.unwrap().filter((i) => i.cut !== true) : undefined,
    (i) => cache?.get(i.inputHash),
    services.region2d,
  )
}

export const PLAN_COMMANDS: readonly AnyCommand[] = [
  planCreate,
  planDuplicate,
  planUpdate,
  planRemove,
  planStatusSet,
  planRebuild,
  libraryItemUpdate,
  designOperationUpdate,
  designOperationRevert,
  machineSet,
  setupUpdate,
  setupSplit,
  setupMerge,
  setupMove,
  planAlignmentSet,
  planAidSet,
  operationUpdate,
  operationMove,
  toolAssign,
  workholdingSet,
]

export const PLAN_QUERIES: readonly QueryDef[] = [
  planList,
  planGet,
  operationList,
  operationFeedsGet,
  staleList,
  toolSuggest,
  warningList,
]
