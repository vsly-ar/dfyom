/**
 * Workholding items of a plan setup (WH-A): the stored shape (quantities), the kinds with their
 * built-in defaults, the numeric form every check uses (mm in the setup frame), invariants and the
 * one-line summary the inspector and the program header show.
 * Doc: docs/modes/workholding.md#model, docs/modes/workholding.md#frame
 *
 * Pure and headless. Positions are in the setup frame (the setup's WCS): X = u, Y = v, Z0 on the
 * up-facing stock face; the stock occupies [0, L] × [0, W] × [−T, 0].
 */
import { z } from 'zod'
import type { Issue } from '../../../shared/errors/app-error'
import { fieldContext } from '../../design/operation'
import { NAME_MAX, quantityDto } from '../../library/item'
import {
  BASE_TYPES,
  SURFACE_TYPES,
  WORKHOLDING_TYPES,
  type WorkholdingType,
} from '../../library/workholding.dto'
import { Quantity } from '../../quantity/quantity'
import type { UnitSystem } from '../../project/document'
import type { QuantityDTO } from '../../quantity/quantity.dto'

/** As plan.dto.ts' `LengthDTO` (not imported: plan.dto.ts imports this module). */
type LengthDTO = QuantityDTO & { kind: 'length' }

/** The setup item kinds are the library's device types (workholding-library.md § Item model). */
export const WORKHOLDING_KINDS = WORKHOLDING_TYPES
export type WorkholdingKind = WorkholdingType

/** Stock edges seen from above on the machine: left, right, front, back. */
export const EDGES = ['uMin', 'uMax', 'vMin', 'vMax'] as const
export type Edge = (typeof EDGES)[number]
export const EDGE_WORD: Readonly<Record<Edge, string>> = {
  uMin: 'left',
  uMax: 'right',
  vMin: 'front',
  vMax: 'back',
}

export const VISE_AXES = ['u', 'v'] as const
export { BASE_TYPES, SURFACE_TYPES }

const Len = quantityDto('length')
const Angle = quantityDto('angle')
const Common = {
  id: z.string().regex(/^wh[0-9]{1,6}$/),
  name: z.string().min(1).max(NAME_MAX),
  /**
   * The plan's library copy (snapshot, kind `workholding`) of the device this item was placed
   * from; absent = an own item. The item still stores the device's values, kept equal to the
   * copy by every write (workholding-library.md § Implementation (WL2)).
   */
  copyId: z.string().min(1).max(120).optional(),
}

export const WorkholdingItemDtoSchema = z.discriminatedUnion('kind', [
  z.object({
    ...Common,
    kind: z.literal('toeClamp'),
    edge: z.enum(EDGES),
    at: Len,
    width: Len,
    grip: Len,
    reach: Len,
    top: Len,
  }),
  z.object({
    ...Common,
    kind: z.literal('vise'),
    axis: z.enum(VISE_AXES),
    protrusion: Len,
    jawLength: Len,
    jawThickness: Len,
    soft: z.boolean(),
  }),
  z.object({
    ...Common,
    kind: z.literal('screw'),
    center: z.tuple([Len, Len]),
    headDiameter: Len,
    top: Len,
  }),
  z.object({
    ...Common,
    kind: z.literal('block'),
    center: z.tuple([Len, Len]),
    length: Len,
    width: Len,
    rotation: Angle,
    bottom: Len.optional(),
    top: Len,
  }),
  z.object({
    ...Common,
    kind: z.literal('base'),
    type: z.enum(BASE_TYPES),
    sacrificial: z.boolean(),
  }),
  z.object({ ...Common, kind: z.literal('surface'), type: z.enum(SURFACE_TYPES) }),
])
export type WorkholdingItemDTO = z.output<typeof WorkholdingItemDtoSchema>

/** One item in mm (and degrees), as every check reads it. */
export type ResolvedItem =
  | {
      readonly id: string
      readonly name: string
      readonly kind: 'toeClamp'
      readonly edge: Edge
      readonly at: number
      readonly width: number
      readonly grip: number
      readonly reach: number
      readonly top: number
    }
  | {
      readonly id: string
      readonly name: string
      readonly kind: 'vise'
      readonly axis: 'u' | 'v'
      readonly protrusion: number
      readonly jawLength: number
      readonly jawThickness: number
      readonly soft: boolean
    }
  | {
      readonly id: string
      readonly name: string
      readonly kind: 'screw'
      readonly center: readonly [number, number]
      readonly headDiameter: number
      readonly top: number
    }
  | {
      readonly id: string
      readonly name: string
      readonly kind: 'block'
      readonly center: readonly [number, number]
      readonly length: number
      readonly width: number
      readonly rotation: number
      readonly bottom?: number
      readonly top: number
    }
  | {
      readonly id: string
      readonly name: string
      readonly kind: 'base'
      readonly type: 'spoilboard' | 'fixturePlate'
      readonly sacrificial: boolean
    }
  | {
      readonly id: string
      readonly name: string
      readonly kind: 'surface'
      readonly type: 'tape' | 'vacuum' | 'glue'
    }

const mm = (q: LengthDTO | z.output<typeof Angle>): number =>
  Quantity.fromDTO(q).mapOr(0, (v) => v.canonical)

/** The numeric form of a stored item (a broken quantity reads as 0, which the invariants catch). */
export function resolveItem(dto: WorkholdingItemDTO): ResolvedItem {
  const base = { id: dto.id, name: dto.name }
  switch (dto.kind) {
    case 'toeClamp':
      return {
        ...base,
        kind: 'toeClamp',
        edge: dto.edge,
        at: mm(dto.at),
        width: mm(dto.width),
        grip: mm(dto.grip),
        reach: mm(dto.reach),
        top: mm(dto.top),
      }
    case 'vise':
      return {
        ...base,
        kind: 'vise',
        axis: dto.axis,
        protrusion: mm(dto.protrusion),
        jawLength: mm(dto.jawLength),
        jawThickness: mm(dto.jawThickness),
        soft: dto.soft,
      }
    case 'screw':
      return {
        ...base,
        kind: 'screw',
        center: [mm(dto.center[0]), mm(dto.center[1])],
        headDiameter: mm(dto.headDiameter),
        top: mm(dto.top),
      }
    case 'block':
      return {
        ...base,
        kind: 'block',
        center: [mm(dto.center[0]), mm(dto.center[1])],
        length: mm(dto.length),
        width: mm(dto.width),
        rotation: mm(dto.rotation),
        ...(dto.bottom === undefined ? {} : { bottom: mm(dto.bottom) }),
        top: mm(dto.top),
      }
    case 'base':
      return { ...base, kind: 'base', type: dto.type, sacrificial: dto.sacrificial }
    case 'surface':
      return { ...base, kind: 'surface', type: dto.type }
  }
}

// ── defaults ─────────────────────────────────────────────────────────────────────────────────

/** Built-in defaults (workholding.md § Model) as entered, per unit system. */
export const ITEM_DEFAULTS = {
  width: { mm: '30 mm', inch: '1.25"' },
  grip: { mm: '10 mm', inch: '0.375"' },
  reach: { mm: '50 mm', inch: '2"' },
  top: { mm: '25 mm', inch: '1"' },
  protrusion: { mm: '5 mm', inch: '0.2"' },
  jawLength: { mm: '150 mm', inch: '6"' },
  jawThickness: { mm: '20 mm', inch: '0.75"' },
  headDiameter: { mm: '8 mm', inch: '5/16"' },
  screwTop: { mm: '0', inch: '0' },
  rotation: '0 deg',
  margin: { mm: '2 mm', inch: '0.08"' },
} as const

/** The default margin around every obstacle (mm or inch source). */
export function defaultMargin(units: UnitSystem): LengthDTO {
  return Quantity.parse(ITEM_DEFAULTS.margin[units], fieldContext('length', units))
    .unwrap()
    .toDTO() as LengthDTO
}

export const KIND_NAMES: Readonly<Record<WorkholdingKind, string>> = {
  toeClamp: 'Toe clamp',
  vise: 'Vise',
  screw: 'Screw',
  block: 'Block',
  base: 'Spoilboard',
  surface: 'Tape',
}

/** "Toe clamp 2": the kind's word and the lowest number not used by an item of that kind. */
export function defaultItemName(
  kind: WorkholdingKind,
  taken: readonly string[],
  extra?: string,
): string {
  const word =
    kind === 'base' && extra === 'fixturePlate'
      ? 'Fixture plate'
      : kind === 'surface' && extra === 'vacuum'
        ? 'Vacuum'
        : kind === 'surface' && extra === 'glue'
          ? 'Glue'
          : KIND_NAMES[kind]
  // one of a kind per setup: no number
  if (kind === 'vise' || kind === 'base' || kind === 'surface') return word
  const names = new Set(taken)
  let n = 1
  while (names.has(`${word} ${n}`)) n++
  return `${word} ${n}`
}

/** The next free item id of a plan (`wh1`, `wh2`, … unique across its setups). */
export function nextItemId(used: Iterable<string>): string {
  let max = 0
  for (const id of used) {
    const n = /^wh([0-9]+)$/.exec(id)
    if (n !== null) max = Math.max(max, Number(n[1]))
  }
  return `wh${max + 1}`
}

// ── invariants ───────────────────────────────────────────────────────────────────────────────

/** The stock as it sits in the setup: extents along X, Y and Z (mm). */
export interface SetupStock {
  readonly length: number
  readonly width: number
  readonly thickness: number
}

/** Length along an edge: `uMin`/`uMax` run along Y, `vMin`/`vMax` along X. */
export const edgeLength = (edge: Edge, s: SetupStock): number =>
  edge === 'uMin' || edge === 'uMax' ? s.width : s.length
/** The stock extent across an edge. */
export const acrossEdge = (edge: Edge, s: SetupStock): number =>
  edge === 'uMin' || edge === 'uMax' ? s.length : s.width

/**
 * Model invariants of a setup's items (`model.invariant`, paths `workholding.<n>.<param>`): sizes
 * > 0, a toe clamp's `at` on its edge and `grip` below the stock extent across it, `top` above
 * `bottom`, at most one vise, one base and one surface.
 */
export function itemIssues(items: readonly ResolvedItem[], stock: SetupStock): Issue[] {
  const out: Issue[] = []
  const at = (n: number, param: string) => ['workholding', n, param]
  const positive = (n: number, param: string, v: number) => {
    if (!(v > 0)) out.push({ path: at(n, param), rule: 'positive', message: 'must be > 0' })
  }
  const nonNegative = (n: number, param: string, v: number) => {
    if (!(v >= 0)) out.push({ path: at(n, param), rule: 'nonNegative', message: 'must be ≥ 0' })
  }
  const once = new Map<string, number>()
  items.forEach((item, n) => {
    if (item.kind === 'vise' || item.kind === 'base' || item.kind === 'surface') {
      const seen = once.get(item.kind) ?? 0
      once.set(item.kind, seen + 1)
      if (seen > 0)
        out.push({
          path: at(n, 'kind'),
          rule: 'onePerSetup',
          message: `at most one ${KIND_NAMES[item.kind].toLowerCase()} per setup`,
        })
    }
    switch (item.kind) {
      case 'toeClamp': {
        positive(n, 'width', item.width)
        positive(n, 'grip', item.grip)
        nonNegative(n, 'reach', item.reach)
        positive(n, 'top', item.top)
        const len = edgeLength(item.edge, stock)
        if (!(item.at >= 0 && item.at <= len))
          out.push({
            path: at(n, 'at'),
            rule: 'onEdge',
            message: `must be within the edge (0 to ${round(len)} mm)`,
            params: { max: len },
          })
        const across = acrossEdge(item.edge, stock)
        if (item.grip >= across)
          out.push({
            path: at(n, 'grip'),
            rule: 'belowStock',
            message: `must be less than the stock across the edge (${round(across)} mm)`,
            params: { max: across },
          })
        break
      }
      case 'vise':
        nonNegative(n, 'protrusion', item.protrusion)
        positive(n, 'jawLength', item.jawLength)
        positive(n, 'jawThickness', item.jawThickness)
        if (item.protrusion >= stock.thickness)
          out.push({
            path: at(n, 'protrusion'),
            rule: 'belowStock',
            message: `must be less than the stock thickness (${round(stock.thickness)} mm)`,
          })
        break
      case 'screw':
        positive(n, 'headDiameter', item.headDiameter)
        nonNegative(n, 'top', item.top)
        break
      case 'block':
        positive(n, 'length', item.length)
        positive(n, 'width', item.width)
        if (!(item.top > (item.bottom ?? -stock.thickness)))
          out.push({ path: at(n, 'top'), rule: 'aboveBottom', message: 'must be above bottom' })
        break
      case 'base':
      case 'surface':
        break
    }
  })
  return out
}

const round = (v: number) => Math.round(v * 1000) / 1000

// ── text ─────────────────────────────────────────────────────────────────────────────────────

/** A length for the summary and header: in the program's / project's unit, trimmed. */
export function lengthText(mmValue: number, units: 'mm' | 'in'): string {
  const v = units === 'in' ? mmValue / 25.4 : mmValue
  const d = units === 'in' ? 3 : 1
  const s = (Math.round(v * 10 ** d) / 10 ** d).toFixed(d)
  return s.replace(/\.?0+$/, '') || '0'
}

/**
 * One line per item, as the inspector lists it and the program header writes it:
 * "front X125 grip 10 top Z12" (toe clamp: the edge, its position as a machine coordinate).
 * Positions are the setup-frame values (as the items are entered) less `zero`: the inspector
 * and `plan.workholding.set` pass none (setup frame, beside the fields), the program header
 * the setup's work zero, so its lines are in the WCS like every other coordinate of the
 * program (DF81, docs/modes/alignment.md S12).
 */
export function itemSummary(
  item: ResolvedItem,
  units: 'mm' | 'in',
  zero: readonly [number, number] = [0, 0],
): string {
  const l = (v: number) => lengthText(v, units)
  const [zx, zy] = zero
  switch (item.kind) {
    case 'toeClamp': {
      const alongY = item.edge === 'uMin' || item.edge === 'uMax'
      const at = item.at - (alongY ? zy : zx)
      return `${EDGE_WORD[item.edge]} ${alongY ? 'Y' : 'X'}${l(at)} grip ${l(item.grip)} top Z${l(item.top)}`
    }
    case 'vise':
      return `${item.soft ? 'soft jaws' : 'jaws'} along ${item.axis === 'u' ? 'X' : 'Y'}, stock ${l(item.protrusion)} above them`
    case 'screw':
      return `X${l(item.center[0] - zx)} Y${l(item.center[1] - zy)} head ${l(item.headDiameter)} top Z${l(item.top)}`
    case 'block':
      return `X${l(item.center[0] - zx)} Y${l(item.center[1] - zy)} ${l(item.length)} x ${l(item.width)} top Z${l(item.top)}`
    case 'base':
      return item.type === 'spoilboard' ? 'spoilboard (sacrificial)' : 'fixture plate'
    case 'surface':
      return item.type === 'tape' ? 'double-sided tape' : item.type
  }
}

/**
 * The setup holds the stock's bottom face (a `surface` item: tape, vacuum or glue; W5): pieces cut
 * free stay held, so the loose-piece findings of that setup are left out.
 * Doc: docs/modes/workholding.md#held-pieces-and-screws-in-the-part-w5
 */
export const holdsOnSurface = (setup: {
  readonly workholding?: readonly { readonly kind: WorkholdingKind }[] | undefined
}): boolean => (setup.workholding ?? []).some((i) => i.kind === 'surface')
