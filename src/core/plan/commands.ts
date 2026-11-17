/**
 * Plan commands and queries (v0.1, without toolpaths) and the draft auto-rebuild hook.
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
import type { Issue } from '../../shared/errors/app-error'
import { collect, Err, fail, Ok, type AppResult } from '../../shared/result'
import type { CommandContext, Services } from '../commands/context'
import {
  defineCommand,
  defineQuery,
  type AnyCommand,
  type DocumentHook,
  type QueryDef,
} from '../commands/define'
import { OPERATION_UPDATE_ARGS, updateOperation, writeOperationList } from '../design/commands'
import { fieldContext } from '../design/operation'
import { OperationIdSchema, PartIdSchema } from '../design/part.dto'
import { checkReferences } from '../design/surfaces'
import { checkOperations } from '../design/validate'
import { ItemIdSchema, NAME_MAX, type LibraryItemKind } from '../library/item'
import type { LibraryItem } from '../library/library-item'
import { Tool } from '../library/tool'
import { deepEqual, refreshSnapshot, Snapshot, takeSnapshot } from '../library/snapshot'
import type { ProjectDoc, UnitSystem } from '../project/document'
import { Quantity } from '../quantity/quantity'
import type { ParseContext } from '../quantity/parse'
import { assignTool, createPlan, duplicatePlan, rebuildPlan, type BuildContext } from './build'
import { PlanWarningSchema, type PlanWarning } from './checks'
import { evaluateOperation, planFindings } from './evaluate'
import { orderFindings } from './order'
import { findPlanDTO, findPlanOperation, loadPlan, loadPlanDTO, type LoadedPlan } from './plan'
import {
  FEED_FIELDS,
  lengthDTO,
  PlanDtoSchema,
  PlanIdSchema,
  PlanRecordIdSchema,
  PlanStatusSchema,
  type FeedField,
  type PlanDTO,
  type PlanOperationDTO,
} from './plan.dto'
import { designChanged, hasPlanEdits, planStale } from './snapshot'
import { checkAllowed, nextStatus } from './status'
import { applyStrategyArgs, StrategyArgSchema, strategyIssues, resolveStrategy } from './strategy'
import { suggestTools } from './suggest'

// ── helpers ───────────────────────────────────────────────────────────────────────────────

const Src = z.string().min(1).max(256).describe('Quantity as entered, e.g. "2 mm" or "1/16\\""')
const PlanArg = { planId: PlanIdSchema }
const Empty = z.object({})
const nowIso = (ctx: CommandContext) => new Date(ctx.clock.now()).toISOString()

function libraryTools(services: Services): LibraryItem[] {
  return services.library === undefined
    ? []
    : services.library.list('tool').items.filter((i) => i.values instanceof Tool)
}

function buildContext(ctx: CommandContext, units: UnitSystem): BuildContext {
  return { ids: ctx.ids, now: nowIso(ctx), units, tools: libraryTools(ctx.services) }
}

/** A library item by id (synchronous read, docs/architecture/commands.md#command-definition). */
function libraryItem(
  ctx: CommandContext,
  kind: LibraryItemKind,
  id: string,
  path: string,
  where: string,
): AppResult<LibraryItem> {
  const library = ctx.services.library
  if (library === undefined)
    return fail('internal.unexpected', 'no library service configured', { where })
  const found = library.lookup(kind, id)
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
  return fail('model.invariant', `${issues.length} invalid value(s)`, { issues, where })
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

/** Rebuild from the current design (shared by `plan.rebuild`, `→ draft` and the hook). */
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

// ── plan lifecycle ────────────────────────────────────────────────────────────────────────

const planCreate = defineCommand({
  kind: 'document',
  name: 'plan.create',
  summary:
    'Create a draft plan of a part: design snapshot, one setup, every operation with a suggested tool.',
  title: () => 'Create plan',
  machine: false,
  args: z.object({
    partId: PartIdSchema,
    name: z.string().min(1).max(NAME_MAX).optional().describe('Default "Plan <n>"'),
    machineLibraryItemId: ItemIdSchema.optional().describe('Library machine to take a copy of'),
  }),
  result: z.object({ planId: PlanIdSchema, setupId: PlanRecordIdSchema }),
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
    return Ok({ planId: plan.unwrap().id, setupId: plan.unwrap().setups[0]!.id })
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
  title: () => 'Rename plan',
  machine: false,
  args: z.object({ ...PlanArg, name: z.string().min(1).max(NAME_MAX) }),
  result: Empty,
  run(draft, args) {
    const plan = planFor(draft, args.planId, 'plan.update')
    if (plan.isErr()) return plan
    draft.plans[args.planId]!.name = args.name
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
    confirm: z.literal(true).describe('Must be true: the user confirmed the deletion'),
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
  summary: "Re-import one of the plan's library copies (stock, machine or tool) from the library.",
  title: () => 'Update plan copy from library',
  machine: false,
  args: z.object({
    ...PlanArg,
    snapshotId: z.string().min(1).describe("Id of the copy in the plan's snapshots"),
    followOnly: z
      .literal(true)
      .optional()
      .describe('Automatic follow of a draft plan: a no-op unless the plan is still a draft'),
  }),
  result: z.object({ updated: z.boolean().describe('False when nothing changed') }),
  run(draft, args, ctx) {
    const where = 'plan.libraryItem.update'
    if (args.followOnly === true) {
      // re-checked inside the command: the status may have changed since the follow read it
      const current = findPlanDTO(draft as ProjectDoc, args.planId, where)
      if (current.isErr()) return current
      if (current.unwrap().status !== 'draft') return Ok({ updated: false })
    }
    const found = planFor(draft, args.planId, where)
    if (found.isErr()) return found
    const plan = plainCopy(found.unwrap())
    const index = plan.snapshots.findIndex((s) => s.id === args.snapshotId)
    const dto = plan.snapshots[index]
    if (dto === undefined)
      return fail('input.malformed', `plan ${args.planId} has no copy ${args.snapshotId}`, {
        issues: [{ path: ['snapshotId'], rule: 'unknownSnapshot', message: 'no such copy' }],
        where,
      })
    const item = libraryItem(ctx, dto.kind, dto.libraryItemId, 'snapshotId', where)
    if (item.isErr()) return item
    const refreshed = Snapshot.fromDTO(dto).andThen((s) =>
      refreshSnapshot(s, item.unwrap(), nowIso(ctx)),
    )
    if (refreshed.isErr()) return Err(refreshed.unwrapErr().withContext(where))
    if (deepEqual(refreshed.unwrap().values.toDTO(), dto.values)) return Ok({ updated: false })
    plan.snapshots[index] = refreshed.unwrap().toDTO()
    if (dto.kind === 'stock') {
      // the plan's part must stay valid with the new stock
      const loaded = loadPlanDTO(plan, draft.unitSystem, where)
      if (loaded.isErr()) return loaded
      const { part, stock } = loaded.unwrap()
      const ok = checkReferences(part.operations, stock).andThen(() =>
        checkOperations(part.operations, stock),
      )
      if (ok.isErr()) return Err(ok.unwrapErr().withContext(where))
    }
    writePlan(draft, plan)
    return Ok({ updated: true })
  },
})

const designOperationUpdate = defineCommand({
  kind: 'document',
  name: 'plan.design.operation.update',
  summary:
    "Edit an operation of the plan's design snapshot for this plan only (settledDesign); same parameters as design.<kind>.update.",
  title: () => 'Edit operation in plan',
  machine: false,
  args: z.object({ ...PlanArg, operationId: OperationIdSchema, ...OPERATION_UPDATE_ARGS }),
  result: Empty,
  run(draft, rawArgs) {
    const where = 'plan.design.operation.update'
    const { planId, operationId, ...params } = rawArgs as {
      planId: string
      operationId: string
    } & Record<string, unknown>
    const loaded = loadedFor(draft, planId, where)
    if (loaded.isErr()) return loaded
    const l = loaded.unwrap()
    const ops = updateOperation(
      { dto: l.dto.design.part, part: l.part, stock: l.stock, units: l.units },
      operationId,
      params,
      where,
    )
    if (ops.isErr()) return ops
    writeOperationList(draft.plans[planId]!.design.part.operations, ops.unwrap())
    return Ok({})
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
    const snap = takeSnapshot(item.unwrap(), ctx.ids.next('snapshot'), nowIso(ctx))
    if (snap.isErr()) return Err(snap.unwrapErr().withContext(where))
    plan.snapshots = [...plan.snapshots.filter((s) => s.id !== plan.machine), snap.unwrap().toDTO()]
    plan.machine = snap.unwrap().id
    writePlan(draft, plan)
    return Ok({})
  },
})

const setupUpdate = defineCommand({
  kind: 'document',
  name: 'plan.setup.update',
  summary: 'Change the safe heights of a setup (clearance above the stock top, retract above on).',
  title: () => 'Update setup',
  machine: false,
  args: z.object({
    ...PlanArg,
    setupId: PlanRecordIdSchema,
    clearanceHeight: Src.optional().describe('Up from the stock top; > retractHeight'),
    retractHeight: Src.optional().describe("Up from the operation's on surface; > 0"),
  }),
  result: Empty,
  run(draft, args) {
    const where = 'plan.setup.update'
    const found = planFor(draft, args.planId, where)
    if (found.isErr()) return found
    const setup = found.unwrap().setups.find((s) => s.id === args.setupId)
    if (setup === undefined)
      return fail('input.malformed', `setup ${args.setupId} does not exist`, {
        issues: [{ path: ['setupId'], rule: 'unknownSetup', message: 'no such setup' }],
        where,
      })
    const ctxL = fieldContext('length', draft.unitSystem)
    const parse = (key: 'clearanceHeight' | 'retractHeight') => {
      const src = args[key]
      return src === undefined
        ? Quantity.fromDTO(setup[key])
        : Quantity.parse(src, ctxL).mapErr((e) => e.prefixIssues(key))
    }
    const both = collect([parse('clearanceHeight'), parse('retractHeight')])
    if (both.isErr()) return Err(both.unwrapErr().withContext(where))
    const [clearance, retract] = both.unwrap() as [Quantity, Quantity]
    const issues: Issue[] = []
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
    if (args.clearanceHeight !== undefined) target.clearanceHeight = lengthDTO(clearance)
    if (args.retractHeight !== undefined) target.retractHeight = lengthDTO(retract)
    return Ok({})
  },
})

const PlanOpArg = { ...PlanArg, planOperationId: PlanRecordIdSchema }

const operationUpdate = defineCommand({
  kind: 'document',
  name: 'plan.operation.update',
  summary:
    'Change preset, stickout, feeds-and-speeds overrides or strategy parameters of a plan operation.',
  title: () => 'Update plan operation',
  machine: false,
  args: z.object({
    ...PlanOpArg,
    presetName: z.string().min(1).nullable().optional().describe('Tool preset; null = default'),
    stickout: Src.nullable().optional().describe("null = the tool's stickout, else flute length"),
    overrides: z
      .object(
        Object.fromEntries(FEED_FIELDS.map((f) => [f, Src.nullable().optional()])) as Record<
          FeedField,
          z.ZodOptional<z.ZodNullable<typeof Src>>
        >,
      )
      .optional()
      .describe('Feeds-and-speeds overrides as entered; null removes one'),
    strategy: StrategyArgSchema.optional(),
  }),
  result: Empty,
  run(draft, args) {
    const where = 'plan.operation.update'
    const loaded = loadedFor(draft, args.planId, where)
    if (loaded.isErr()) return loaded
    const plan = loaded.unwrap()
    const index = findPlanOperation(plan, args.planOperationId, where)
    if (index.isErr()) return index
    const units = draft.unitSystem
    const op: PlanOperationDTO = plainCopy(plan.setup.operations[index.unwrap()]!)
    const kind = evaluateOperation(plan, op).kind
    const tool = op.tool === undefined ? undefined : plan.tools.get(op.tool)
    const issues: Issue[] = []
    const parsed: AppResult<unknown>[] = []
    if (args.presetName === null) delete op.presetName
    else if (args.presetName !== undefined) {
      if (tool === undefined || !tool.presets.some((p) => p.name === args.presetName))
        return fail('input.malformed', `the tool has no preset "${args.presetName}"`, {
          issues: [{ path: ['presetName'], rule: 'unknownPreset', message: 'no such preset' }],
          where,
        })
      op.presetName = args.presetName
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
        continue
      }
      if (kind === 'drilling' && (field === 'stepdown' || field === 'stepover')) {
        issues.push({
          path: ['overrides', field],
          rule: 'notForKind',
          message: 'drilling has no stepdown/stepover (see strategy)',
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
    }
    if (issues.length > 0) return invalid(issues, where)
    const target = draft.plans[args.planId]!.setups[0]!.operations
    if (!deepEqual(target[index.unwrap()], op)) target[index.unwrap()] = op
    return Ok({})
  },
})

const operationMove = defineCommand({
  kind: 'document',
  name: 'plan.operation.move',
  summary:
    'Move a plan operation in the machining order; it must stay after the operations whose surfaces it starts from.',
  title: () => 'Move plan operation',
  machine: false,
  args: z.object({
    ...PlanOpArg,
    toIndex: z.number().int().min(0).describe('New 0-based position'),
  }),
  result: Empty,
  run(draft, args) {
    const where = 'plan.operation.move'
    const loaded = loadedFor(draft, args.planId, where)
    if (loaded.isErr()) return loaded
    const plan = loaded.unwrap()
    const from = findPlanOperation(plan, args.planOperationId, where)
    if (from.isErr()) return from
    const list = plan.setup.operations
    if (args.toIndex >= list.length)
      return fail('input.malformed', 'toIndex is past the end of the list', {
        issues: [
          {
            path: ['toIndex'],
            rule: 'range',
            message: `must be at most ${list.length - 1}`,
            params: { max: list.length - 1 },
          },
        ],
        where,
      })
    if (from.unwrap() === args.toIndex) return Ok({})
    const next = [...list]
    const [moved] = next.splice(from.unwrap(), 1)
    next.splice(args.toIndex, 0, moved!)
    const key = (w: { planOperationId?: string; params: Record<string, unknown> }) =>
      `${w.planOperationId}>${String(w.params['dependsOn'])}`
    const violations = (ops: readonly PlanOperationDTO[]) =>
      new Set(
        orderFindings(ops, plan.part)
          .filter((w) => w.code === 'plan.order')
          .map(key),
      )
    const before = violations(list)
    const added = orderFindings(next, plan.part).filter(
      (w) => w.code === 'plan.order' && !before.has(key(w)),
    )
    if (added.length > 0)
      return fail('plan.order', added.map((w) => w.message).join('; '), {
        issues: added.map((w) => ({
          path: ['toIndex'],
          rule: w.rule,
          message: w.message,
          params: w.params,
        })),
        where,
      })
    const target = draft.plans[args.planId]!.setups[0]!.operations
    const [dto] = target.splice(from.unwrap(), 1)
    target.splice(args.toIndex, 0, dto!)
    return Ok({})
  },
})

const toolAssign = defineCommand({
  kind: 'document',
  name: 'plan.tool.assign',
  summary:
    'Assign a library tool to a plan operation (the plan takes or reuses a copy); resets the preset to the default.',
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
    const item = libraryItem(ctx, 'tool', args.toolLibraryItemId, 'toolLibraryItemId', where)
    if (item.isErr()) return item
    const plan = plainCopy(loaded.unwrap().dto)
    const r = assignTool(plan, args.planOperationId, item.unwrap(), {
      ids: ctx.ids,
      now: nowIso(ctx),
    })
    if (r.isErr()) return Err(r.unwrapErr().withContext(where))
    writePlan(draft, plan)
    return Ok({})
  },
})

// ── draft auto-rebuild ────────────────────────────────────────────────────────────────────

/**
 * After every design command, rebuilds each `draft` plan whose snapshot differs from the current
 * part, on the same draft: the design change and the rebuilds are one undo step
 * (docs/modes/plan-v0.1.md#commands-and-queries-v01; mechanism:
 * docs/architecture/commands.md#document-hooks). Design commands themselves are unchanged.
 */
export const draftPlanAutoRebuild: DocumentHook = {
  name: 'plan.draftAutoRebuild',
  after(draft, command, ctx) {
    if (!command.name.startsWith('design.')) return Ok(undefined)
    const args = command.args as { partId?: unknown }
    const partId = typeof args.partId === 'string' ? args.partId : undefined
    for (const id of Object.keys(draft.plans)) {
      const plan = draft.plans[id]!
      if (plan.status !== 'draft') continue
      if (partId !== undefined && plan.design.partId !== partId) continue
      if (!designChanged(plan as PlanDTO, draft as ProjectDoc)) continue
      // A plan is downstream of the design: a draft that cannot follow (its stock copy no longer
      // fits, or a broken record) is left as it was and reported by plan.stale.list and
      // plan.warning.list; the design command never fails because of it.
      const rebuilt = rebuild(draft, plainCopy(plan as PlanDTO), ctx, 'plan.draftAutoRebuild')
      if (rebuilt.isOk()) writePlan(draft, rebuilt.unwrap())
    }
    return Ok(undefined)
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
  result: z.object({ plan: PlanDtoSchema }),
  run(doc, args) {
    return findPlanDTO(doc, args.planId, 'plan.get').map((plan) => ({ plan }))
  },
})

const FeedValue = z
  .object({
    value: z.number(),
    unit: z.string(),
    source: z.enum(['override', 'preset', 'calculator', 'strategy']),
  })
  .nullable()

const operationList = defineQuery({
  name: 'plan.operation.list',
  summary:
    'List the plan operations in machining order with tool, preset, resolved feeds and speeds (with source per field) and strategy.',
  args: z.object(PlanArg),
  result: z.object({
    operations: z.array(
      z.object({
        id: PlanRecordIdSchema,
        kind: z.enum(['facing', 'pocket', 'drilling', 'profile']),
        designOperationIds: z.array(OperationIdSchema),
        tool: z
          .object({ snapshotId: z.string(), libraryItemId: z.string(), name: z.string() })
          .nullable(),
        presetName: z.string().nullable().describe('The preset in use (default or chosen)'),
        stickout: z.number().nullable().describe('mm'),
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
      }),
    ),
  }),
  run(doc, args) {
    const loaded = loadPlan(doc, args.planId, 'plan.operation.list')
    if (loaded.isErr()) return loaded
    const plan = loaded.unwrap()
    return Ok({
      operations: plan.setup.operations.map((op) => {
        const e = evaluateOperation(plan, op)
        const snap = plan.dto.snapshots.find((s) => s.id === op.tool)
        const feeds = Object.fromEntries(
          FEED_FIELDS.map((f) => [
            f,
            e.feeds
              .andThen((r) => r.fields[f])
              .mapOr(null, (v) => ({ value: v.value, unit: v.unit, source: v.source })),
          ]),
        ) as Record<FeedField, z.output<typeof FeedValue>>
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
                  libraryItemId: snap.libraryItemId,
                  name: e.tool.unwrap().name,
                },
          presetName: e.preset.mapOr(null, (p) => p.name),
          stickout: e.stickout.unwrapOr(null as unknown as number),
          feeds,
          chipLoad: e.feeds.andThen((f) => f.chipLoad).unwrapOr(null as unknown as number),
          strategy: strategy as Record<string, number | string>,
        }
      }),
    })
  },
})

const staleList = defineQuery({
  name: 'plan.stale.list',
  summary:
    'List what is stale in a plan: operations changed or removed in the design or edited in the plan, and library copies whose item changed or was removed.',
  args: z.object(PlanArg),
  result: z.object({
    partRemoved: z.boolean(),
    partChanged: z
      .array(z.string())
      .describe('Part-level fields that differ from the design, e.g. generalTolerance'),
    rebuildBlocked: z.string().nullable().describe('A draft that could not follow the design: why'),
    operations: z.array(
      z.object({
        operationId: OperationIdSchema,
        changedInDesign: z.boolean(),
        removedFromDesign: z.boolean(),
        editedInPlan: z.boolean(),
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
      }),
    ),
  }),
  run(doc, args, ctx) {
    return findPlanDTO(doc, args.planId, 'plan.stale.list').map((plan) => {
      const s = planStale(plan, doc, ctx.services.library?.lookup)
      return {
        partRemoved: s.partRemoved,
        partChanged: [...s.partChanged],
        rebuildBlocked: s.rebuildBlocked,
        operations: [...s.operations],
        libraryCopies: [...s.libraryCopies],
      }
    })
  },
})

const toolSuggest = defineQuery({
  name: 'plan.tool.suggest',
  summary:
    'Rank the library tools that pass the checks of a plan operation (preset for the material, already used, largest diameter), with reasons.',
  args: z.object(PlanOpArg),
  result: z.object({
    tools: z.array(
      z.object({
        toolLibraryItemId: z.string(),
        name: z.string(),
        diameter: z.number().describe('mm'),
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
    const op = loaded.unwrap().setup.operations[index.unwrap()]!
    return Ok({
      tools: suggestTools(loaded.unwrap(), op, libraryTools(ctx.services)).map((t) => ({
        ...t,
        reasons: [...t.reasons],
      })),
    })
  },
})

const warningList = defineQuery({
  name: 'plan.warning.list',
  summary:
    'List the checks of a plan: tool, feeds and order errors (they block toolpaths), machine and calculator warnings.',
  args: z.object(PlanArg),
  result: z.object({ warnings: z.array(PlanWarningSchema) }),
  run(doc, args, ctx) {
    const where = 'plan.warning.list'
    const dto = findPlanDTO(doc, args.planId, where)
    if (dto.isErr()) return dto
    const loaded = loadPlanDTO(dto.unwrap(), doc.unitSystem, where)
    const findings: PlanWarning[] = loaded.isOk()
      ? planFindings(loaded.unwrap())
      : [
          {
            code: 'plan.broken',
            severity: 'error',
            message: `the plan record does not load: ${loaded.unwrapErr().message}`,
            rule: 'load',
            params: {},
          },
        ]
    const stale = planStale(dto.unwrap(), doc, ctx.services.library?.lookup)
    for (const c of stale.libraryCopies)
      if (c.blocked !== null)
        findings.push({
          code: 'plan.libraryBlocked',
          severity: 'warning',
          message: c.blocked,
          field: `snapshots.${c.snapshotId}`,
          rule: 'partFits',
          params: { snapshotId: c.snapshotId, libraryItemId: c.libraryItemId },
        })
    if (stale.rebuildBlocked !== null)
      findings.push({
        code: 'plan.rebuildBlocked',
        severity: 'warning',
        message: stale.rebuildBlocked,
        rule: 'partFits',
        params: {},
      })
    return Ok({ warnings: findings.map((w) => ({ ...w, params: { ...w.params } })) })
  },
})

export const PLAN_COMMANDS: readonly AnyCommand[] = [
  planCreate,
  planDuplicate,
  planUpdate,
  planRemove,
  planStatusSet,
  planRebuild,
  libraryItemUpdate,
  designOperationUpdate,
  machineSet,
  setupUpdate,
  operationUpdate,
  operationMove,
  toolAssign,
]

export const PLAN_QUERIES: readonly QueryDef[] = [
  planList,
  planGet,
  operationList,
  staleList,
  toolSuggest,
  warningList,
]
