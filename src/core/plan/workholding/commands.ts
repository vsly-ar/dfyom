/**
 * `plan.workholding.set`: the declarative workholding command of a setup (WH-A). One union-style
 * tool keeps the agent API small; reading is through `plan.get` (the setup records).
 * Doc: docs/modes/workholding.md#commands-and-queries
 */
import { z } from 'zod'
import { issueSummary, type Issue } from '../../../shared/errors/app-error'
import { Err, fail, Ok, type AppResult } from '../../../shared/result'
import { defineCommand } from '../../commands/define'
import { fieldContext } from '../../design/operation'
import { ItemIdSchema, NAME_MAX } from '../../library/item'
import type { ProjectDoc, UnitSystem } from '../../project/document'
import { Quantity } from '../../quantity/quantity'
import { PlanWarningSchema, tooShortText, usableStickout, type PlanWarning } from '../checks'
import type { Services } from '../../commands/context'
import { findPlanDTO, loadPlanDTO, type LoadedPlan } from '../plan'
import {
  lengthDTO,
  PlanIdSchema,
  PlanRecordIdSchema,
  type PlanDTO,
  type SetupDTO,
} from '../plan.dto'
import { unknownSetup } from '../setups'
import { checkAllowed } from '../status'
import { baseOf } from '../../design/frozen-memo'
import { planOperationInputs, type PlanOperationInput } from '../inputs'
import type { Toolpath } from '../../toolpath/model'
import { planOpLabel } from '../labels'
import { checkedWorkholdingFindings, checkOperations } from './findings'
import {
  BASE_TYPES,
  defaultItemName,
  EDGE_WORD,
  EDGES,
  edgeLength,
  ITEM_DEFAULTS,
  itemIssues,
  itemSummary,
  lengthText,
  nextItemId,
  resolveItem,
  SURFACE_TYPES,
  VISE_AXES,
  WORKHOLDING_KINDS,
  type WorkholdingItemDTO,
  type WorkholdingKind,
} from './items'
import { footprintBounds, obstacles } from './obstacles'
import { setupStock, setupWorkholding } from './setup'
import { arrangeToeClamps, stickoutForRoom, type EdgeRoom } from './arrange'
import { wasteTest } from './held'
import { setupZero } from '../alignment'
import { nextSnapshotId } from '../build'
import type { LibraryItem } from '../../library/library-item'
import { deepEqual, type ItemLookup } from '../../library/snapshot'
import type { Workholding } from '../../library/workholding'
import {
  defaultWorkholding,
  isBuiltinWorkholding,
  withBuiltinWorkholding,
} from '../../library/workholding-builtins'
import {
  detaches,
  deviceCopy,
  deviceFallbacks,
  deviceGrip,
  deviceLabel,
  itemDevice,
  placeDevice,
  pruneWorkholdingCopies,
} from './devices'

const Src = z.string().min(1).max(256)

/** One item as the command takes it: the kind and its parameters (others are refused). */
export const WorkholdingItemArgSchema = z.object({
  id: z.string().min(1).max(32).optional(),
  name: z.string().min(1).max(NAME_MAX).optional(),
  // DF138 F3: optional with an id (the item keeps its kind); a new item needs it
  kind: z.enum(WORKHOLDING_KINDS).optional(),
  edge: z.enum(EDGES).optional(),
  at: Src.optional(),
  width: Src.optional(),
  grip: Src.optional(),
  reach: Src.optional(),
  top: Src.optional(),
  axis: z.enum(VISE_AXES).optional(),
  protrusion: Src.optional(),
  jawLength: Src.optional(),
  jawThickness: Src.optional(),
  soft: z.boolean().optional(),
  center: z.tuple([Src, Src]).optional(),
  headDiameter: Src.optional(),
  length: Src.optional(),
  rotation: Src.optional(),
  bottom: Src.optional(),
  type: z.enum([...BASE_TYPES, ...SURFACE_TYPES]).optional(),
  sacrificial: z.boolean().optional(),
  libraryItemId: ItemIdSchema.optional(),
})
/** An item arg with its kind known (given, or the existing item's). */
export type WorkholdingItemArg = z.output<typeof WorkholdingItemArgSchema> & {
  readonly kind: WorkholdingKind
}

/** The parameters each kind takes besides id, name and kind. */
const PARAMS: Readonly<Record<WorkholdingKind, readonly string[]>> = {
  toeClamp: ['edge', 'at', 'width', 'grip', 'reach', 'top'],
  vise: ['axis', 'protrusion', 'jawLength', 'jawThickness', 'soft'],
  screw: ['center', 'headDiameter', 'top'],
  block: ['center', 'length', 'width', 'rotation', 'bottom', 'top'],
  base: ['type', 'sacrificial'],
  surface: ['type'],
}
const ALL_PARAMS = [...new Set(Object.values(PARAMS).flat())]

const ITEMS_HELP =
  'The whole list (replaces it), setup frame (X0 Y0 front-left of the up face, Z0 on it). toeClamp: edge (uMin left, uMax right, vMin front, vMax back), at (centre along the edge, default middle), width 30, grip 10 (onto the stock), reach 50 (beyond the edge), top 25 (above Z0). vise: axis u|v (jaws close along it), protrusion 5 (stock above the jaws), jawLength 150, jawThickness 20, soft. screw: center [x, y], headDiameter 8, top 0. block: center, length, width, rotation 0, bottom (default the table), top. base: type spoilboard|fixturePlate. surface: type tape|vacuum|glue, holds pieces cut free. An item with id keeps it (kind and omitted parameters stay). libraryItemId: place that library device (its sizes; a differing size detaches).'

/** The parsed item, or issues at `items.<n>.<param>`. */
function parseItem(
  arg: WorkholdingItemArg,
  n: number,
  previous: WorkholdingItemDTO | undefined,
  id: string,
  taken: string[],
  units: UnitSystem,
  stock: { length: number; width: number },
  /** Values of the device the item is placed from (`deviceFallbacks`), before the defaults. */
  device: Readonly<Record<string, ReturnType<typeof lengthDTO>>> = {},
): { item?: WorkholdingItemDTO; issues: Issue[] } {
  const issues: Issue[] = []
  const at = (param: string) => ['items', n, param]
  const own = PARAMS[arg.kind]
  for (const p of ALL_PARAMS)
    if ((arg as Record<string, unknown>)[p] !== undefined && !own.includes(p))
      issues.push({
        path: at(p),
        rule: 'notForKind',
        message: `a ${arg.kind} takes ${own.join(', ')}`,
      })
  const prev = previous?.kind === arg.kind ? (previous as Record<string, unknown>) : undefined
  const ctxL = fieldContext('length', units)
  type L = ReturnType<typeof lengthDTO>
  const len = (param: string, fallback: string | undefined): L | undefined => {
    const src = (arg as Record<string, unknown>)[param] as string | undefined
    if (src === undefined) {
      if (prev?.[param] !== undefined) return prev[param] as L
      if (device[param] !== undefined) return device[param]
      if (fallback === undefined) {
        issues.push({ path: at(param), rule: 'required', message: `a ${arg.kind} needs ${param}` })
        return undefined
      }
      return lengthDTO(Quantity.parse(fallback, ctxL).unwrap())
    }
    const q = Quantity.parse(src, ctxL)
    if (q.isErr()) {
      issues.push(...q.unwrapErr().prefixIssues('items', n, param).issues)
      return undefined
    }
    return lengthDTO(q.unwrap())
  }
  const name =
    arg.name ??
    (previous?.kind === arg.kind ? previous.name : defaultItemName(arg.kind, taken, arg.type))
  const base = { id, name }
  const d = ITEM_DEFAULTS
  let item: WorkholdingItemDTO | undefined
  switch (arg.kind) {
    case 'toeClamp': {
      const edge = arg.edge ?? (prev?.['edge'] as string | undefined)
      if (edge === undefined) {
        issues.push({ path: at('edge'), rule: 'required', message: 'a toeClamp needs edge' })
        break
      }
      const e = edge as (typeof EDGES)[number]
      const middle = `${edgeLength(e, { ...stock, thickness: 0 }) / 2} mm`
      // a clamp moved to another edge without a position goes to that edge's middle
      const moved = prev !== undefined && prev['edge'] !== e && arg.at === undefined
      const v = {
        at: moved ? lengthDTO(Quantity.parse(middle, ctxL).unwrap()) : len('at', middle),
        width: len('width', d.width[units]),
        grip: len('grip', d.grip[units]),
        reach: len('reach', d.reach[units]),
        top: len('top', d.top[units]),
      }
      const ok = all(v)
      if (ok !== undefined) item = { ...base, kind: 'toeClamp', edge: e, ...ok }
      break
    }
    case 'vise': {
      const v = {
        protrusion: len('protrusion', d.protrusion[units]),
        jawLength: len('jawLength', d.jawLength[units]),
        jawThickness: len('jawThickness', d.jawThickness[units]),
      }
      const ok = all(v)
      if (ok !== undefined)
        item = {
          ...base,
          kind: 'vise',
          axis: arg.axis ?? (prev?.['axis'] as 'u' | 'v' | undefined) ?? 'u',
          ...ok,
          soft: arg.soft ?? (prev?.['soft'] as boolean | undefined) ?? false,
        }
      break
    }
    case 'screw': {
      const c = centre(arg, prev, n, issues, ctxL)
      const v = {
        headDiameter: len('headDiameter', d.headDiameter[units]),
        top: len('top', d.screwTop[units]),
      }
      const ok = all(v)
      if (c !== undefined && ok !== undefined) item = { ...base, kind: 'screw', center: c, ...ok }
      break
    }
    case 'block': {
      const c = centre(arg, prev, n, issues, ctxL)
      const v = {
        length: len('length', undefined),
        width: len('width', undefined),
        top: len('top', undefined),
      }
      let rotation = prev?.['rotation'] as ReturnType<Quantity['toDTO']> | undefined
      const src = arg.rotation ?? (rotation === undefined ? ITEM_DEFAULTS.rotation : undefined)
      if (src !== undefined) {
        const q = Quantity.parse(src, fieldContext('angle', units))
        if (q.isErr()) issues.push(...q.unwrapErr().prefixIssues('items', n, 'rotation').issues)
        else rotation = q.unwrap().toDTO()
      }
      const bottom =
        arg.bottom !== undefined ? len('bottom', undefined) : (prev?.['bottom'] as L | undefined)
      const ok = all(v)
      if (c !== undefined && rotation !== undefined && ok !== undefined)
        item = {
          ...base,
          kind: 'block',
          center: c,
          ...ok,
          rotation: rotation as Extract<WorkholdingItemDTO, { kind: 'block' }>['rotation'],
          ...(bottom === undefined ? {} : { bottom }),
        }
      break
    }
    case 'base': {
      const type = arg.type ?? (prev?.['type'] as string | undefined) ?? 'spoilboard'
      if (type !== 'spoilboard' && type !== 'fixturePlate') {
        issues.push({ path: at('type'), rule: 'enum', message: 'spoilboard or fixturePlate' })
        break
      }
      item = {
        ...base,
        kind: 'base',
        type,
        sacrificial:
          arg.sacrificial ??
          (arg.type === undefined ? (prev?.['sacrificial'] as boolean | undefined) : undefined) ??
          type === 'spoilboard',
      }
      break
    }
    case 'surface': {
      const type = arg.type ?? (prev?.['type'] as string | undefined) ?? 'tape'
      if (type !== 'tape' && type !== 'vacuum' && type !== 'glue') {
        issues.push({ path: at('type'), rule: 'enum', message: 'tape, vacuum or glue' })
        break
      }
      item = { ...base, kind: 'surface', type }
      break
    }
  }
  return issues.length > 0 || item === undefined ? { issues } : { item, issues }
}

function centre(
  arg: WorkholdingItemArg,
  prev: Record<string, unknown> | undefined,
  n: number,
  issues: Issue[],
  ctxL: ReturnType<typeof fieldContext>,
): [ReturnType<typeof lengthDTO>, ReturnType<typeof lengthDTO>] | undefined {
  if (arg.center === undefined) {
    const p = prev?.['center'] as
      [ReturnType<typeof lengthDTO>, ReturnType<typeof lengthDTO>] | undefined
    if (p === undefined)
      issues.push({
        path: ['items', n, 'center'],
        rule: 'required',
        message: `a ${arg.kind} needs center`,
      })
    return p
  }
  const out: ReturnType<typeof lengthDTO>[] = []
  arg.center.forEach((src, k) => {
    const q = Quantity.parse(src, ctxL)
    if (q.isErr()) issues.push(...q.unwrapErr().prefixIssues('items', n, 'center', k).issues)
    else out.push(lengthDTO(q.unwrap()))
  })
  return out.length === 2 ? [out[0]!, out[1]!] : undefined
}

/** The values when none is missing. */
function all<T extends Record<string, unknown>>(
  v: T,
): { [K in keyof T]: NonNullable<T[K]> } | undefined {
  return Object.values(v).every((x) => x !== undefined)
    ? (v as { [K in keyof T]: NonNullable<T[K]> })
    : undefined
}

/** The device an item is placed from: a new library one, or the copy it already follows. */
type ItemSource =
  | { readonly device: Workholding; readonly item: LibraryItem; readonly copyId?: undefined }
  | { readonly device: Workholding; readonly copyId: string }

/**
 * Where item `n`'s device values come from: `libraryItemId` (a library device or a built-in, of
 * the item's kind), else the copy the item already follows (same kind); undefined for an own
 * item, null after an issue.
 */
function itemSource(
  arg: WorkholdingItemArg,
  n: number,
  prev: WorkholdingItemDTO | undefined,
  snapshots: PlanDTO['snapshots'],
  lookup: ItemLookup,
  issues: Issue[],
): ItemSource | undefined | null {
  if (arg.libraryItemId === undefined) {
    const d = prev?.kind === arg.kind ? itemDevice(snapshots, prev) : undefined
    return d === undefined ? undefined : { device: d.device, copyId: d.copy.id }
  }
  const found = lookup('workholding', arg.libraryItemId)
  const path = ['items', n, 'libraryItemId']
  if (found.state !== 'found' || found.item.values.kind !== 'workholding') {
    issues.push({
      path,
      rule: found.state === 'unreadable' ? 'unreadableItem' : 'unknownItem',
      message: 'no such library workholding device (library_workholding_list)',
    })
    return null
  }
  const device = found.item.values
  if (device.type !== arg.kind) {
    issues.push({ path, rule: 'kindMismatch', message: `${device.name} is a ${device.type}` })
    return null
  }
  return { device, item: found.item }
}

/**
 * The toe clamp `auto` places (Q135): `autoItemId`, else the default toe clamp (a user item
 * marked default, else the built-in).
 */
function autoDevice(
  id: string | undefined,
  lookup: ItemLookup,
  services: Services,
  units: UnitSystem,
  where: string,
): AppResult<LibraryItem> {
  if (id === undefined) {
    const user = services.library?.list('workholding').items ?? []
    const def = defaultWorkholding(user, 'toeClamp', units)
    if (def.isSome()) return Ok(def.unwrap())
    return fail('internal.unexpected', 'no default toe clamp', { where })
  }
  const found = lookup('workholding', id)
  const values = found.state === 'found' ? found.item.values : undefined
  if (found.state !== 'found' || values?.kind !== 'workholding' || values.type !== 'toeClamp')
    return fail('input.malformed', `${id} is not a library toe clamp`, {
      issues: [
        {
          path: ['autoItemId'],
          rule: found.state === 'found' ? 'kindMismatch' : 'unknownItem',
          message: 'a toe clamp of the library (library_workholding_list type toeClamp)',
        },
      ],
      where,
    })
  return Ok(found.item)
}

/** Every item id of the plan (ids are unique per plan). */
const planItemIds = (plan: PlanDTO) =>
  plan.setups.flatMap((s) => (s.workholding ?? []).map((i) => i.id))

/** A length in project units for results: "27 mm", "1.063 in". */
function projectLength(v: number, units: UnitSystem): string {
  return units === 'mm' ? `${lengthText(v, 'mm')} mm` : `${lengthText(v, 'in')} in`
}

const Vec2 = z.tuple([z.number(), z.number()])

/** Automatic arrangements (W6); one for now. */
const AUTO_KINDS = ['toeClamps'] as const

export const workholdingSet = defineCommand({
  kind: 'document',
  name: 'plan.workholding.set',
  summary:
    "Set a setup's workholding (clamps, vise, screws, blocks, base, tape): obstacles that toolpaths keep out of, the clearance height follows and every move is checked against before export.",
  title: () => 'Set workholding',
  machine: false,
  args: z.object({
    planId: PlanIdSchema,
    setupId: PlanRecordIdSchema,
    items: z.array(WorkholdingItemArgSchema).max(64).optional().describe(ITEMS_HELP),
    copyFrom: PlanRecordIdSchema.optional().describe("Instead of items: copy another setup's"),
    auto: z
      .enum(AUTO_KINDS)
      .optional()
      .describe(
        'Instead of items: 4 toe clamps in the waste clear of the generated toolpaths (other items stay)',
      ),
    autoItemId: ItemIdSchema.optional().describe('The toe clamp auto places; default: the default'),
    margin: Src.optional().describe('Kept around every item; default 2 mm'),
  }),
  result: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        kind: z.enum(WORKHOLDING_KINDS),
        libraryItemId: z
          .string()
          .optional()
          .describe('The library device it was placed from (its copy is copyId in plan_get)'),
        summary: z.string(),
        bounds: z.tuple([Vec2, Vec2]).nullable().describe('Of its prisms, mm, setup frame'),
        top: z.number().nullable().describe('Highest point above Z0, mm'),
      }),
    ),
    clearanceHeight: z.string().describe("The setup program's clearance height"),
    findings: z
      .array(PlanWarningSchema)
      .describe("This setup's workholding findings, moves of current toolpaths checked as export"),
    movesUnchecked: z
      .array(z.string())
      .describe(
        'Operations whose toolpaths must regenerate first: plan_toolpath_generate, then plan_warning_list',
      ),
  }),
  run(draft, args, ctx) {
    const where = 'plan.workholding.set'
    const found = findPlanDTO(draft as ProjectDoc, args.planId, where)
    if (found.isErr()) return found
    const allowed = checkAllowed(args.planId, found.unwrap().status, where)
    if (allowed.isErr()) return allowed
    const planDto = found.unwrap()
    const setup = planDto.setups.find((s) => s.id === args.setupId)
    if (setup === undefined) return unknownSetup(args.setupId, 'setupId', where)
    const given = (['items', 'copyFrom', 'auto'] as const).filter((k) => args[k] !== undefined)
    if (given.length > 1)
      return fail('input.malformed', `${given.join(' and ')} are exclusive`, {
        issues: [
          {
            path: [given[1]!],
            rule: 'exclusive',
            message: 'give one of items, copyFrom and auto',
          },
        ],
        where,
      })
    const loaded = loadPlanDTO(planDto, draft.unitSystem, where)
    if (loaded.isErr()) return loaded
    const units = draft.unitSystem
    const size = setupStock(loaded.unwrap().stock, setup)
    const issues: Issue[] = []
    let items: WorkholdingItemDTO[] | undefined
    // the plan's library copies; a placement from the library may add one (pruned below)
    const snapshots = plainCopy(planDto.snapshots)
    const lookup = withBuiltinWorkholding(ctx.services.library?.lookup, units)
    const now = new Date(ctx.clock.now()).toISOString()
    const newCopyId = () => nextSnapshotId({ ...planDto, snapshots }, ctx.ids)
    if (args.autoItemId !== undefined && args.auto === undefined)
      issues.push({ path: ['autoItemId'], rule: 'needsAuto', message: 'only with auto' })
    const used = planItemIds(planDto)
    const fresh = () => {
      const id = nextItemId(used)
      used.push(id)
      return id
    }
    if (args.copyFrom !== undefined) {
      const from = planDto.setups.find((s) => s.id === args.copyFrom)
      if (from === undefined) return unknownSetup(args.copyFrom, 'copyFrom', where)
      items = (from.workholding ?? []).map((i) => ({ ...plainCopy(i), id: fresh() }))
    } else if (args.items !== undefined) {
      const mine = new Map((setup.workholding ?? []).map((i) => [i.id, i]))
      const taken: string[] = []
      items = []
      for (const [n, given] of args.items.entries()) {
        if (given.id !== undefined && !mine.has(given.id)) {
          issues.push({
            path: ['items', n, 'id'],
            rule: 'unknownItem',
            message: 'no such item in this setup; leave id out for a new one',
          })
          continue
        }
        // DF138 F3: an item with an id keeps its kind when the call leaves it out
        const kind = given.kind ?? (given.id === undefined ? undefined : mine.get(given.id)?.kind)
        if (kind === undefined) {
          issues.push({
            path: ['items', n, 'kind'],
            rule: 'required',
            message: `a new item needs kind (${WORKHOLDING_KINDS.join(', ')})`,
          })
          continue
        }
        const arg: WorkholdingItemArg = { ...given, kind }
        if (arg.id !== undefined && items.some((i) => i.id === arg.id)) {
          issues.push({ path: ['items', n, 'id'], rule: 'duplicate', message: 'listed twice' })
          continue
        }
        const id = arg.id ?? fresh()
        const prev = arg.id === undefined ? undefined : mine.get(arg.id)
        const from = itemSource(arg, n, prev, planDto.snapshots, lookup, issues)
        if (from === null) continue
        const r = parseItem(
          arg,
          n,
          prev,
          id,
          taken,
          units,
          size,
          from === undefined ? {} : deviceFallbacks(from.device, units),
        )
        issues.push(...r.issues)
        if (r.item === undefined) continue
        taken.push(r.item.name)
        const edited = plainCopy(r.item)
        const placed =
          from === undefined ? undefined : placeDevice(edited, from.device, size, units)
        // Q138: a device value given and different detaches the item: an own item, one undo step
        if (from === undefined || placed === undefined || detaches(arg, edited, placed)) {
          items.push(edited)
          continue
        }
        let copyId = from.copyId
        if ('item' in from) {
          const copy = deviceCopy(snapshots, from.item, newCopyId, now)
          if (copy.isErr()) return Err(copy.unwrapErr().withContext(where))
          copyId = copy.unwrap().id
        }
        items.push({ ...placed, copyId })
      }
    }
    let margin: ReturnType<typeof lengthDTO> | undefined
    if (args.margin !== undefined) {
      const q = Quantity.parse(args.margin, fieldContext('length', units))
      if (q.isErr()) issues.push(...q.unwrapErr().prefixIssues('margin').issues)
      else if (!(q.unwrap().canonical >= 0))
        issues.push({ path: ['margin'], rule: 'nonNegative', message: 'must be ≥ 0' })
      else margin = lengthDTO(q.unwrap())
    }
    if (issues.length > 0) return fail('input.malformed', issueSummary(issues), { issues, where })
    if (args.auto !== undefined) {
      const clamp = autoDevice(args.autoItemId, lookup, ctx.services, units, where)
      if (clamp.isErr()) return clamp
      const copy = deviceCopy(snapshots, clamp.unwrap(), newCopyId, now)
      if (copy.isErr()) return Err(copy.unwrapErr().withContext(where))
      const auto = autoItems(baseOf(draft as ProjectDoc), loaded.unwrap(), setup, {
        units,
        services: ctx.services,
        fresh,
        device: { item: clamp.unwrap(), copyId: copy.unwrap().id },
        ...(margin === undefined
          ? {}
          : { margin: Quantity.fromDTO(margin).mapOr(0, (q) => q.canonical) }),
      })
      if (auto.isErr()) return auto
      items = auto.unwrap()
    }
    if (items !== undefined) {
      const invariant = itemIssues(items.map(resolveItem), size).map((i) => ({
        ...i,
        path: i.path[0] === 'workholding' ? ['items', ...i.path.slice(1)] : i.path,
      }))
      if (invariant.length > 0)
        return fail('model.invariant', issueSummary(invariant), { issues: invariant, where })
    }
    const target = draft.plans[args.planId]!.setups.find((s) => s.id === args.setupId)!
    if (items !== undefined) {
      if (items.length === 0) delete target.workholding
      else target.workholding = items
      const p = draft.plans[args.planId]!
      const kept = pruneWorkholdingCopies({ snapshots, setups: plainCopy(p.setups) as SetupDTO[] })
      if (!deepEqual(kept, plainCopy(p.snapshots))) p.snapshots = kept
    }
    if (margin !== undefined) target.workholdingMargin = margin
    // the result is read from a plain copy (the draft's proxies do not outlive the command)
    const after = plainCopy(target as SetupDTO)
    const plan = loaded.unwrap()
    const h = setupWorkholding(after, plan.stock)
    const copies = plainCopy(draft.plans[args.planId]!.snapshots) as PlanDTO['snapshots']
    const updated = {
      ...plan,
      dto: { ...plan.dto, snapshots: copies },
      setups: plan.setups.map((s) => (s.id === after.id ? after : s)),
    }
    return Ok({
      items: h.items.map((i) => {
        const prisms = h.prisms.filter((p) => p.itemId === i.id)
        const boxes = prisms.map((p) => footprintBounds(p.footprint))
        const stored = after.workholding?.find((w) => w.id === i.id) ?? {}
        const libraryItemId = itemDevice(copies, stored)?.copy.libraryItemId
        const device = deviceLabel(copies, stored)
        const summary = itemSummary(i, units === 'mm' ? 'mm' : 'in')
        return {
          id: i.id,
          name: i.name,
          kind: i.kind,
          ...(libraryItemId === undefined ? {} : { libraryItemId }),
          summary: device === undefined ? summary : `${summary} · ${device}`,
          bounds:
            boxes.length === 0
              ? null
              : ([
                  [Math.min(...boxes.map((b) => b[0][0])), Math.min(...boxes.map((b) => b[0][1]))],
                  [Math.max(...boxes.map((b) => b[1][0])), Math.max(...boxes.map((b) => b[1][1]))],
                ] as [[number, number], [number, number]]),
          top: prisms.length === 0 ? null : Math.max(...prisms.map((p) => p.zMax)),
        }
      }),
      clearanceHeight: projectLength(h.clearance, units),
      // DF90: the export's move check on the toolpaths still current (a profile or drilling does
      // not depend on the items; a facing or pocket keeps out of them and regenerates)
      ...setFindings(baseOf(draft as ProjectDoc), updated, after, ctx.services),
    })
  },
})

const plainCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** The set result's findings of `setup` and the operations whose moves wait for toolpaths. */
function setFindings(
  doc: ProjectDoc,
  plan: Parameters<typeof checkedWorkholdingFindings>[0],
  setup: SetupDTO,
  services: Services,
): { findings: PlanWarning[]; movesUnchecked: string[] } {
  const inputs = planOperationInputs(doc, plan.dto.id, undefined, services.region2d)
  const cache = services.toolpaths
  const r = checkedWorkholdingFindings(
    plan,
    inputs.isOk() ? inputs.unwrap() : undefined,
    (i) => cache?.get(i.inputHash),
    services.region2d,
    setup.id,
    true,
    (i) => cache?.last(i.planId, i.planOperationId)?.toolpath,
  )
  return {
    findings: r.findings.map((f) => ({ ...f, params: { ...f.params } })),
    movesUnchecked: r.unchecked.map((i) =>
      planOpLabel(plan.dto.design.part, {
        designOperationIds: i.operations.map((o) => o.id),
      }),
    ),
  }
}

/** "front 0 (centres X20–60)" for the refusal message. */
function roomText(r: EdgeRoom, units: UnitSystem): string {
  const axis = r.edge === 'uMin' || r.edge === 'uMax' ? 'Y' : 'X'
  const v = (x: number) => lengthText(x, units === 'mm' ? 'mm' : 'in')
  const free =
    r.free.length === 0
      ? 'no room'
      : `centres ${r.free.map(([a, b]) => (a === b ? `${axis}${v(a)}` : `${axis}${v(a)}–${v(b)}`)).join(', ')}`
  return `${EDGE_WORD[r.edge]} ${r.fits} (${free})`
}

type Length = ReturnType<typeof lengthDTO>

/**
 * W6 `auto: 'toeClamps'`: the setup's items with its toe clamps replaced by four placed in the
 * waste clear of its toolpaths (the current ones, else each operation's last). Refused with
 * `plan.workholding`: a vise holds the setup (`vise`), an operation was never generated
 * (`noToolpaths`), or no pair of opposite edges takes two clamps each (`noRoom`, every edge's
 * room in the message).
 * Doc: docs/modes/workholding.md#automatic-arrangement-w6
 */
function autoItems(
  doc: ProjectDoc,
  plan: LoadedPlan,
  setup: SetupDTO,
  o: {
    units: UnitSystem
    services: Services
    fresh: () => string
    margin?: number
    /** The toe clamp placed (`autoDevice`) and its copy in the plan. */
    device: { item: LibraryItem; copyId: string }
  },
): AppResult<WorkholdingItemDTO[]> {
  const where = 'plan.workholding.set'
  const { units, services } = o
  const kept = (setup.workholding ?? []).filter((i) => i.kind !== 'toeClamp')
  if (kept.some((i) => i.kind === 'vise'))
    return fail(
      'plan.workholding',
      `${setup.name} is held by a vise: remove it first to arrange toe clamps`,
      { issues: [{ path: ['auto'], rule: 'vise', message: 'the setup has a vise' }], where },
    )
  const port = services.region2d
  const inputs = planOperationInputs(doc, plan.dto.id, undefined, port)
  if (inputs.isErr()) return inputs
  const cache = services.toolpaths
  const pairs: { input: PlanOperationInput; toolpath: Toolpath }[] = []
  const missing: string[] = []
  for (const input of inputs.unwrap()) {
    if (input.setup.id !== setup.id) continue
    const toolpath =
      cache?.get(input.inputHash) ?? cache?.last(input.planId, input.planOperationId)?.toolpath
    if (toolpath !== undefined) pairs.push({ input, toolpath })
    else
      missing.push(
        planOpLabel(plan.dto.design.part, {
          designOperationIds: input.operations.map((x) => x.id),
        }),
      )
  }
  if (missing.length > 0)
    return fail(
      'plan.workholding',
      `Generate the toolpaths of ${setup.name} first (plan_toolpath_generate): the clamps go where no toolpath passes; not generated: ${missing.join(', ')}`,
      { issues: [{ path: ['auto'], rule: 'noToolpaths', message: missing.join(', ') }], where },
    )
  const h = setupWorkholding(setup, plan.stock)
  const margin = o.margin ?? h.margin
  const ctxL = fieldContext('length', units)
  const parse = (src: string): Length | undefined =>
    Quantity.parse(src, ctxL).mapOr(undefined, (q: Quantity) => lengthDTO(q))
  const device = o.device.item.values as Workholding
  // the device's sizes, grip the middle of its range (W6-C's fixed size is the built-in's)
  const sample = placeDevice(
    {
      id: 'wh0',
      name: device.name,
      kind: 'toeClamp',
      edge: 'vMin',
      at: parse('0')!,
      grip: deviceGrip(device, units),
      width: parse(ITEM_DEFAULTS.width[units])!,
      reach: parse(ITEM_DEFAULTS.reach[units])!,
      top: parse(ITEM_DEFAULTS.top[units])!,
    },
    device,
    h.stock,
    units,
  )
  if (sample?.kind !== 'toeClamp')
    return fail('internal.unexpected', `${device.name} does not place as a toe clamp`, { where })
  const dto = { width: sample.width, grip: sample.grip, reach: sample.reach, top: sample.top }
  // a device of the user's library is named in the refusal; a built-in is "toe clamps"
  const what = isBuiltinWorkholding(o.device.item.id) ? 'toe clamps' : device.name
  const mm = (l: Length) => Quantity.fromDTO(l).mapOr(0, (q) => q.canonical)
  const clamp = { width: mm(dto.width), grip: mm(dto.grip), reach: mm(dto.reach), top: mm(dto.top) }
  const waste = wasteTest(plan, setup, port, margin)
  // with waste on this face the grip stays in it, where a facing goes round the clamps (WH-D)
  const cutting = waste === undefined ? pairs : pairs.filter((p) => p.input.kind !== 'facing')
  const arrangeInput = {
    stock: h.stock,
    operations: checkOperations(cutting, setupZero(plan, setup, port)),
    clearanceZ: h.clearance,
    margin,
    clamp,
    others: obstacles(kept.map(resolveItem), h.stock),
    ...(waste === undefined ? {} : { inWaste: waste }),
    step: units === 'mm' ? 1 : 25.4 / 16,
  }
  const found = arrangeToeClamps(arrangeInput)
  // DF138 F1: blocked only by the collet nut or spindle body: say which stickouts make room
  const room = 'clamps' in found ? undefined : stickoutForRoom(arrangeInput)
  // the exact check clears that placement at the planned stickouts already: take it
  const arrangement =
    room !== undefined && room.stickouts.size === 0 ? { clamps: room.clamps } : found
  if (room !== undefined && room.stickouts.size > 0) {
    const stickouts = [...room.stickouts].map(([id, need]) => {
      const pair = cutting.find((p) => p.input.planOperationId === id)
      const label = planOpLabel(plan.dto.design.part, {
        designOperationIds: pair?.input.operations.map((x) => x.id) ?? [],
      })
      const usable = pair === undefined ? undefined : usableStickout(pair.input.tool)
      const text =
        units === 'mm'
          ? `${Math.ceil(need * 10 - 1e-6) / 10} mm`
          : `${Math.ceil((need / 25.4) * 100 - 1e-6) / 100}"`
      return { id, label, need, usable, text }
    })
    const short = stickouts.filter((s) => s.usable !== undefined && s.need > s.usable.max + 1e-6)
    const needs = stickouts.map((s) => `${s.label} chucked at least ${s.text} out`).join(', ')
    const fix =
      short.length > 0
        ? `${short.map((s) => `${s.label}: ${tooShortText(s.usable!)}`).join('; ')}: use a longer tool, place the clamps by hand (items) or hold the stock with a vise, screws or tape`
        : 'set the stickout (plan_operation_update) and arrange again, or place them by hand (items)'
    return fail(
      'plan.workholding',
      `Four ${what} do not fit in ${setup.name} clear of the collet nut and spindle body at the planned stickouts; they fit with ${needs}: ${fix}`,
      {
        issues: stickouts.map((s) => ({
          path: ['auto'],
          rule: 'holderRoom',
          message: `${s.label} needs ${s.text}`,
          params: {
            planOperationId: s.id,
            neededStickout: s.need,
            ...(s.usable === undefined ? {} : { maxStickout: s.usable.max }),
          },
        })),
        where,
      },
    )
  }
  if (!('clamps' in arrangement))
    return fail(
      'plan.workholding',
      `Four ${what} do not fit in ${setup.name} clear of the toolpaths${waste === undefined ? '' : ' and in the waste'} (two on each of two opposite edges; clamps per edge: ${arrangement.edges.map((r) => roomText(r, units)).join('; ')}): place them by hand (items), or hold the stock with a vise, screws or tape`,
      {
        issues: arrangement.edges.map((r) => ({
          path: ['auto'],
          rule: 'noRoom',
          message: roomText(r, units),
        })),
        where,
      },
    )
  const taken = kept.map((i) => i.name)
  const at = (v: number): Length | undefined =>
    parse(
      units === 'mm'
        ? `${Math.round(v * 1000) / 1000} mm`
        : `${Math.round((v / 25.4) * 10000) / 10000}"`,
    )
  const clamps: WorkholdingItemDTO[] = []
  for (const c of arrangement.clamps) {
    const name = defaultItemName('toeClamp', taken)
    taken.push(name)
    const a = at(c.at)
    if (a === undefined) continue
    clamps.push({
      id: o.fresh(),
      name,
      copyId: o.device.copyId,
      kind: 'toeClamp',
      edge: c.edge,
      at: a,
      ...dto,
    })
  }
  return Ok([...kept.map((i) => plainCopy(i)), ...clamps])
}
