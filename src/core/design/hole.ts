/**
 * The hole feature kind (v0.4 F3): one round hole with an optional counterbore at its mouth,
 * sizes from the built-in fastener table, expanded to a drilling (simple) or a circular pocket
 * plus a drilling on its floor (counterbore). Countersink (F4) adds a `head` variant.
 * Doc: docs/modes/design-v0.4.md#hole-feature, docs/modes/design-v0.4.md#implementation-f3
 *
 * Only types come from feature.ts, which registers this kind as built in (so every reader of a
 * part knows it); the commands are in hole-commands.ts.
 */
import { z } from 'zod'
import type { Issue, IssuePath } from '../../shared/errors/app-error'
import { parseWith } from '../../shared/parse'
import { collect, fail, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import type { DfmWarning } from '../geometry/model'
import { quantityDto, quantityFromDTO } from '../library/item'
import type { UnitSystem } from '../project/document'
import { Quantity } from '../quantity/quantity'
import { Rational } from '../quantity/rational'
import { FASTENER_FITS, FASTENER_TABLE, type FastenerFit, type FastenerRow } from './fastener/data'
import type { ExpandedOperation, ExpansionContext, FeatureBase, FeatureKindSpec } from './feature'
import { FeatureDtoSchema, type FeatureDTO } from './feature.dto'
import { CENTRE_ANCHOR, DEFAULTS, fieldContext, type Point } from './operation'
import { DRILL_BOTTOMS, type DrillBottomKind } from './part.dto'

/** Hole types built so far; F4 adds `countersink` (a third `HoleHead` variant). */
export const HOLE_TYPES = ['simple', 'counterbore'] as const
export type HoleType = (typeof HOLE_TYPES)[number]

export const HOLE_PURPOSES = ['clearance', 'tapDrill'] as const
export type HolePurpose = (typeof HOLE_PURPOSES)[number]

/** Table keys (`M3`), for the argument and record schemas. */
export const FASTENER_SIZES = FASTENER_TABLE.map((r) => r.size) as [string, ...string[]]

/** What sits at the hole's mouth, by `type`; each variant carries only its own sizes. */
export type HoleHead =
  | { readonly type: 'simple' }
  | { readonly type: 'counterbore'; readonly cbDiameter: Quantity; readonly cbDepth: Quantity }

export interface Hole extends FeatureBase {
  readonly kind: 'hole'
  /** `[u, v]` of the hole axis in the face frame (anchor: the centre). */
  readonly center: Point
  /** Table key; None = custom. It refills the sizes when chosen, never afterwards on its own. */
  readonly fastener: Option<string>
  readonly purpose: HolePurpose
  readonly fit: FastenerFit
  readonly diameter: Quantity
  readonly bottom: DrillBottomKind
  /** From the face, to full diameter; None for `through`. */
  readonly depth: Option<Quantity>
  /** How far the head sits below the face; only used when defaults are filled. */
  readonly headSink: Quantity
  readonly head: HoleHead
}

// ── table values ───────────────────────────────────────────────────────────────────────────

export const fastenerRow = (size: string): FastenerRow | undefined =>
  FASTENER_TABLE.find((r) => r.size === size)

const MM_PER_INCH = Rational.create(254n, 10n).unwrap()

/** Display source of a derived length (exact value kept): mm or inch, at most 4 / 5 decimals. */
function lengthSource(exactMm: Rational, units: UnitSystem): string {
  const inch = units === 'inch'
  const v = inch ? exactMm.div(MM_PER_INCH).unwrap() : exactMm
  const max = inch ? 5 : 4
  const text = v.toFixed(v.decimalDigits(max).unwrapOr(max))
  return inch ? `${text}"` : `${text} mm`
}

/** A length computed from others (exact), shown in the project's units. */
export function derivedLength(
  exactMm: Rational,
  units: UnitSystem,
  tolerance: Quantity['tolerance'] = None,
): AppResult<Quantity> {
  return Quantity.create({
    kind: 'length',
    source: lengthSource(exactMm, units),
    defaultUnit: fieldContext('length', units).defaultUnit,
    exact: exactMm,
    tolerance,
  })
}

const tableLength = (mm: number, units: UnitSystem): AppResult<Quantity> =>
  Quantity.parse(`${mm} mm`, fieldContext('length', units))

/** The sizes the table gives a hole (design-v0.4.md § Fastener table). */
export interface HoleTableSizes {
  readonly diameter: Quantity
  readonly cbDiameter: Quantity
  /** k + `headSink`. */
  readonly cbDepth: Quantity
}

export function holeTableSizes(
  row: FastenerRow,
  purpose: HolePurpose,
  fit: FastenerFit,
  headSink: Quantity,
  units: UnitSystem,
): AppResult<HoleTableSizes> {
  const d = purpose === 'tapDrill' ? row.tapDrill : row.clearance[fit]
  const k = tableLength(row.socketHead.height, units)
  return collect([
    tableLength(d, units),
    tableLength(row.counterbore.diameter, units),
    k.andThen((k) => derivedLength(k.exact.add(headSink.exact), units)),
  ]).map(([diameter, cbDiameter, cbDepth]) => ({
    diameter: diameter!,
    cbDiameter: cbDiameter!,
    cbDepth: cbDepth!,
  }))
}

// ── record ─────────────────────────────────────────────────────────────────────────────────

const length = () => quantityDto('length')

/** The stored hole (`part.features[]`): flat, as the parameters are named. */
const HoleDtoSchema = FeatureDtoSchema.extend({
  kind: z.literal('hole'),
  type: z.enum(HOLE_TYPES),
  fastener: z.enum(FASTENER_SIZES).optional(),
  purpose: z.enum(HOLE_PURPOSES),
  fit: z.enum(FASTENER_FITS),
  center: z.tuple([length(), length()]),
  diameter: length(),
  bottom: z.enum(DRILL_BOTTOMS),
  depth: length().optional(),
  headSink: length(),
  cbDiameter: length().optional(),
  cbDepth: length().optional(),
})

function holeFromDTO(raw: FeatureDTO): AppResult<Hole> {
  const parsed = parseWith(HoleDtoSchema, raw, 'holeFromDTO')
  if (parsed.isErr()) return parsed
  const d = parsed.unwrap()
  const q = (dto: z.output<ReturnType<typeof length>>, ...path: (string | number)[]) =>
    quantityFromDTO(dto, ...path)
  const opt = (dto: z.output<ReturnType<typeof length>> | undefined, path: string) =>
    dto === undefined ? Ok(undefined) : q(dto, path)
  const missing = (path: string) =>
    fail('input.malformed', `hole ${d.id}: ${path} is missing`, {
      issues: [{ path: [path], rule: 'required', message: 'is required for a counterbore' }],
      where: 'holeFromDTO',
    })
  const cb = d.type === 'counterbore'
  return collect<Quantity | undefined>([
    q(d.center[0], 'center', 0),
    q(d.center[1], 'center', 1),
    q(d.diameter, 'diameter'),
    opt(d.depth, 'depth'),
    q(d.headSink, 'headSink'),
    cb && d.cbDiameter === undefined ? missing('cbDiameter') : opt(d.cbDiameter, 'cbDiameter'),
    cb && d.cbDepth === undefined ? missing('cbDepth') : opt(d.cbDepth, 'cbDepth'),
  ]).map(([u, v, diameter, depth, headSink, cbDiameter, cbDepth]) => ({
    kind: 'hole',
    id: d.id,
    name: d.name,
    on: d.on,
    center: [u!, v!],
    fastener: d.fastener === undefined ? None : Some(d.fastener),
    purpose: d.purpose,
    fit: d.fit,
    diameter: diameter!,
    bottom: d.bottom,
    depth: depth === undefined ? None : Some(depth),
    headSink: headSink!,
    head: cb
      ? { type: 'counterbore', cbDiameter: cbDiameter!, cbDepth: cbDepth! }
      : { type: 'simple' },
  }))
}

function holeToDTO(h: Hole): FeatureDTO {
  return {
    id: h.id,
    kind: 'hole',
    name: h.name,
    on: h.on,
    type: h.head.type,
    ...(h.fastener.isSome() ? { fastener: h.fastener.unwrap() } : {}),
    purpose: h.purpose,
    fit: h.fit,
    center: [h.center[0].toDTO(), h.center[1].toDTO()],
    diameter: h.diameter.toDTO(),
    bottom: h.bottom,
    ...(h.depth.isSome() ? { depth: h.depth.unwrap().toDTO() } : {}),
    headSink: h.headSink.toDTO(),
    ...(h.head.type === 'counterbore'
      ? { cbDiameter: h.head.cbDiameter.toDTO(), cbDepth: h.head.cbDepth.toDTO() }
      : {}),
  }
}

// ── invariants ─────────────────────────────────────────────────────────────────────────────

const ZERO = Rational.ZERO

/** The parameter table's rules (design-v0.4.md § Checks and DFM), at the feature's fields. */
function holeInvariants(h: Hole): Issue[] {
  const issues: Issue[] = []
  const check = (ok: boolean, path: string, rule: string, message: string, params?: object) => {
    if (!ok)
      issues.push({
        path: [path],
        rule,
        message,
        ...(params === undefined ? {} : { params: params as Record<string, unknown> }),
      })
  }
  const positive = (q: Quantity, path: string) => {
    const ok = q.exact.compare(ZERO) > 0
    check(ok, path, 'positive', 'must be greater than 0', { actual: q.canonical })
    return ok
  }
  positive(h.diameter, 'diameter')
  check(h.headSink.exact.compare(ZERO) >= 0, 'headSink', 'nonNegative', 'must be 0 or more', {
    actual: h.headSink.canonical,
  })
  check(
    h.purpose === 'clearance' || h.head.type === 'simple',
    'purpose',
    'tapDrillSimple',
    'a tap drill hole has no counterbore or countersink',
  )
  const blind = h.bottom !== 'through'
  check(
    blind === h.depth.isSome(),
    'depth',
    blind ? 'required' : 'notForBottom',
    blind ? `is required for a ${h.bottom} bottom` : 'is not used for a through hole',
  )
  const depth: Quantity | undefined =
    blind && h.depth.isSome() && positive(h.depth.unwrap(), 'depth') ? h.depth.unwrap() : undefined
  if (h.head.type === 'counterbore') {
    const { cbDiameter, cbDepth } = h.head
    check(
      cbDiameter.exact.compare(h.diameter.exact) > 0,
      'cbDiameter',
      'greaterThanDiameter',
      'must be greater than the hole diameter',
      { min: h.diameter.canonical, actual: cbDiameter.canonical },
    )
    if (positive(cbDepth, 'cbDepth') && depth !== undefined)
      check(
        cbDepth.exact.compare(depth.exact) < 0,
        'cbDepth',
        'lessThanDepth',
        'must be less than the hole depth',
        { max: depth.canonical, actual: cbDepth.canonical },
      )
  }
  return issues
}

// ── expansion ──────────────────────────────────────────────────────────────────────────────

/**
 * simple → `drill`; counterbore → `counterbore` (circular pocket) then `drill` on its floor,
 * blind depth `depth − cbDepth` (design-v0.4.md § Expansion). A drill point gets the drilling's
 * default 118°. Larger holes than any drill are still drillings: Plan bores them helically with
 * an end mill (design.md#drilling).
 */
function expandHole(h: Hole, ctx: ExpansionContext): AppResult<readonly ExpandedOperation[]> {
  const pointAngle: AppResult<Option<Quantity>> =
    h.bottom === 'drillPoint'
      ? Quantity.parse(DEFAULTS.pointAngle[ctx.units], fieldContext('angle', ctx.units)).map(Some)
      : Ok(None)
  if (pointAngle.isErr()) return pointAngle
  const drill = (on: string, depth: Option<Quantity>): ExpandedOperation => ({
    role: 'drill',
    operation: {
      kind: 'drilling',
      on,
      center: h.center,
      diameter: h.diameter,
      bottom: h.bottom,
      depth,
      pointAngle: pointAngle.unwrap(),
    },
  })
  if (h.head.type === 'simple') return Ok([drill(h.on, h.depth)])
  const { cbDiameter, cbDepth } = h.head
  const below: AppResult<Option<Quantity>> = h.depth.isNone()
    ? Ok(None)
    : derivedLength(
        h.depth.unwrap().exact.sub(cbDepth.exact),
        ctx.units,
        h.depth.unwrap().tolerance,
      ).map(Some)
  if (below.isErr()) return below
  return Ok([
    {
      role: 'counterbore',
      operation: {
        kind: 'pocket',
        on: h.on,
        shape: { kind: 'circle', center: h.center, anchor: CENTRE_ANCHOR, diameter: cbDiameter },
        depth: cbDepth,
        floorRadius: derivedLength(ZERO, ctx.units).unwrap(),
      },
    },
    drill(`${ctx.ownedId('counterbore')}.floor`, below.unwrap()),
  ])
}

/** Owned operation parameter → hole field (design-v0.4.md#implementation-f3). */
const FIELD_OF: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  drill: { diameter: 'diameter', depth: 'depth', center: 'center', bottom: 'bottom', on: 'on' },
  counterbore: {
    depth: 'cbDepth',
    on: 'on',
    'shape.diameter': 'cbDiameter',
    'shape.center': 'center',
  },
}

function holeFieldOf(role: string, path: IssuePath): IssuePath | undefined {
  const map = FIELD_OF[role]
  if (map === undefined) return undefined
  const two = path.slice(0, 2).join('.')
  if (map[two] !== undefined) return [map[two], ...path.slice(2)]
  const one = String(path[0])
  return map[one] === undefined ? undefined : [map[one], ...path.slice(1)]
}

function reevaluateHole(
  h: Hole,
  at: (q: Quantity, path: string) => AppResult<Quantity>,
): AppResult<Hole> {
  const head = h.head
  const cb = head.type === 'counterbore'
  return collect<Quantity | undefined>([
    at(h.center[0], 'center.0'),
    at(h.center[1], 'center.1'),
    at(h.diameter, 'diameter'),
    h.depth.isSome() ? at(h.depth.unwrap(), 'depth') : Ok(undefined),
    at(h.headSink, 'headSink'),
    cb ? at(head.cbDiameter, 'cbDiameter') : Ok(undefined),
    cb ? at(head.cbDepth, 'cbDepth') : Ok(undefined),
  ]).map(([u, v, diameter, depth, headSink, cbDiameter, cbDepth]) => ({
    ...h,
    center: [u!, v!],
    diameter: diameter!,
    depth: depth === undefined ? None : Some(depth),
    headSink: headSink!,
    head: cb ? { type: 'counterbore', cbDiameter: cbDiameter!, cbDepth: cbDepth! } : head,
  }))
}

/**
 * `dfm.holeCustomSize` (info): a size that differs from the table row the hole names, on the
 * owned operation that carries it. Params `{ field, table, value }` (mm) plus `fastener`.
 */
function holeWarnings(h: Hole, ownedId: (role: string) => string): DfmWarning[] {
  if (h.fastener.isNone()) return []
  const size = h.fastener.unwrap()
  const row = fastenerRow(size)
  if (row === undefined) return []
  // the table values are parsed in mm; the unit system only sets display sources
  const table = holeTableSizes(row, h.purpose, h.fit, h.headSink, 'mm')
  if (table.isErr()) return []
  const t = table.unwrap()
  const sizes: [string, string, Quantity, Quantity][] = [
    ['diameter', 'drill', h.diameter, t.diameter],
  ]
  if (h.head.type === 'counterbore')
    sizes.push(
      ['cbDiameter', 'counterbore', h.head.cbDiameter, t.cbDiameter],
      ['cbDepth', 'counterbore', h.head.cbDepth, t.cbDepth],
    )
  return sizes
    .filter(([, , value, want]) => !value.exact.equals(want.exact))
    .map(([field, role, value, want]) => ({
      code: 'dfm.holeCustomSize',
      severity: 'info',
      message: `${field} ${value.canonical} mm differs from the ${size} table value ${want.canonical} mm (custom)`,
      operation: ownedId(role),
      parameter: field,
      params: {
        field,
        table: want.canonical,
        value: value.canonical,
        fastener: size,
        feature: h.id,
      },
    }))
}

export const holeSpec: FeatureKindSpec<Hole> = {
  kind: 'hole',
  idPrefix: 'hole',
  label: 'Hole',
  fromDTO: holeFromDTO,
  toDTO: holeToDTO,
  invariants: holeInvariants,
  expand: expandHole,
  reevaluate: reevaluateHole,
  fieldOf: holeFieldOf,
  warnings: holeWarnings,
}
