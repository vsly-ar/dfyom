/**
 * `plan.workholding.set`: the declarative workholding command of a setup (WH-A). One union-style
 * tool keeps the agent API small; reading is through `plan.get` (the setup records).
 * Doc: docs/modes/workholding.md#commands-and-queries
 */
import { z } from 'zod'
import { issueSummary, type Issue } from '../../../shared/errors/app-error'
import { fail, Ok } from '../../../shared/result'
import { defineCommand } from '../../commands/define'
import { fieldContext } from '../../design/operation'
import { NAME_MAX } from '../../library/item'
import type { ProjectDoc, UnitSystem } from '../../project/document'
import { Quantity } from '../../quantity/quantity'
import { PlanWarningSchema } from '../checks'
import { findPlanDTO, loadPlanDTO } from '../plan'
import {
  lengthDTO,
  PlanIdSchema,
  PlanRecordIdSchema,
  type PlanDTO,
  type SetupDTO,
} from '../plan.dto'
import { unknownSetup } from '../setups'
import { checkAllowed } from '../status'
import { staticWorkholdingFindings } from './findings'
import {
  BASE_TYPES,
  defaultItemName,
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
import { footprintBounds } from './obstacles'
import { setupStock, setupWorkholding } from './setup'

const Src = z.string().min(1).max(256)

/** One item as the command takes it: the kind and its parameters (others are refused). */
export const WorkholdingItemArgSchema = z.object({
  id: z.string().min(1).max(32).optional(),
  name: z.string().min(1).max(NAME_MAX).optional(),
  kind: z.enum(WORKHOLDING_KINDS),
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
})
export type WorkholdingItemArg = z.output<typeof WorkholdingItemArgSchema>

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
  'The whole list (replaces it), setup frame (X0 Y0 front-left of the up face, Z0 on it). toeClamp: edge (uMin left, uMax right, vMin front, vMax back), at (centre along the edge, default middle), width 30, grip 10 (onto the stock), reach 50 (beyond the edge), top 25 (above Z0). vise: axis u|v (jaws close along it), protrusion 5 (stock above the jaws), jawLength 150, jawThickness 20, soft. screw: center [x, y], headDiameter 8, top 0. block: center, length, width, rotation 0, bottom (default the table), top. base: type spoilboard|fixturePlate. surface: type tape|vacuum|glue. An item with id keeps it (omitted parameters stay).'

/** The parsed item, or issues at `items.<n>.<param>`. */
function parseItem(
  arg: WorkholdingItemArg,
  n: number,
  previous: WorkholdingItemDTO | undefined,
  id: string,
  taken: string[],
  units: UnitSystem,
  stock: { length: number; width: number },
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

/** Every item id of the plan (ids are unique per plan). */
const planItemIds = (plan: PlanDTO) =>
  plan.setups.flatMap((s) => (s.workholding ?? []).map((i) => i.id))

/** A length in project units for results: "27 mm", "1.063 in". */
function projectLength(v: number, units: UnitSystem): string {
  return units === 'mm' ? `${lengthText(v, 'mm')} mm` : `${lengthText(v, 'in')} in`
}

const Vec2 = z.tuple([z.number(), z.number()])

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
    margin: Src.optional().describe('Kept around every item; default 2 mm'),
  }),
  result: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        kind: z.enum(WORKHOLDING_KINDS),
        summary: z.string(),
        bounds: z.tuple([Vec2, Vec2]).nullable().describe('Of its prisms, mm, setup frame'),
        top: z.number().nullable().describe('Highest point above Z0, mm'),
      }),
    ),
    clearanceHeight: z.string().describe("The setup program's clearance height"),
    findings: z.array(PlanWarningSchema).describe("This setup's workholding findings"),
  }),
  run(draft, args) {
    const where = 'plan.workholding.set'
    const found = findPlanDTO(draft as ProjectDoc, args.planId, where)
    if (found.isErr()) return found
    const allowed = checkAllowed(args.planId, found.unwrap().status, where)
    if (allowed.isErr()) return allowed
    const planDto = found.unwrap()
    const setup = planDto.setups.find((s) => s.id === args.setupId)
    if (setup === undefined) return unknownSetup(args.setupId, 'setupId', where)
    if (args.items !== undefined && args.copyFrom !== undefined)
      return fail('input.malformed', 'items and copyFrom are exclusive', {
        issues: [
          { path: ['copyFrom'], rule: 'exclusive', message: 'give items or copyFrom, not both' },
        ],
        where,
      })
    const loaded = loadPlanDTO(planDto, draft.unitSystem, where)
    if (loaded.isErr()) return loaded
    const units = draft.unitSystem
    const size = setupStock(loaded.unwrap().stock, setup)
    const issues: Issue[] = []
    let items: WorkholdingItemDTO[] | undefined
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
      for (const [n, arg] of args.items.entries()) {
        if (arg.id !== undefined && !mine.has(arg.id)) {
          issues.push({
            path: ['items', n, 'id'],
            rule: 'unknownItem',
            message: 'no such item in this setup; leave id out for a new one',
          })
          continue
        }
        if (arg.id !== undefined && items.some((i) => i.id === arg.id)) {
          issues.push({ path: ['items', n, 'id'], rule: 'duplicate', message: 'listed twice' })
          continue
        }
        const id = arg.id ?? fresh()
        const r = parseItem(
          arg,
          n,
          arg.id === undefined ? undefined : mine.get(arg.id),
          id,
          taken,
          units,
          size,
        )
        issues.push(...r.issues)
        if (r.item !== undefined) {
          taken.push(r.item.name)
          items.push(plainCopy(r.item))
        }
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
    }
    if (margin !== undefined) target.workholdingMargin = margin
    // the result is read from a plain copy (the draft's proxies do not outlive the command)
    const after = plainCopy(target as SetupDTO)
    const plan = loaded.unwrap()
    const h = setupWorkholding(after, plan.stock)
    const updated = { ...plan, setups: plan.setups.map((s) => (s.id === after.id ? after : s)) }
    return Ok({
      items: h.items.map((i) => {
        const prisms = h.prisms.filter((p) => p.itemId === i.id)
        const boxes = prisms.map((p) => footprintBounds(p.footprint))
        return {
          id: i.id,
          name: i.name,
          kind: i.kind,
          summary: itemSummary(i, units === 'mm' ? 'mm' : 'in'),
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
      findings: staticWorkholdingFindings(updated, after.id).map((f) => ({
        ...f,
        params: { ...f.params },
      })),
    })
  },
})

const plainCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
