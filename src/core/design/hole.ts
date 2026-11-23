/**
 * The hole feature kind (v0.4 F3, F4): one round hole with an optional counterbore or countersink
 * at its mouth, sizes from the built-in fastener table, expanded to a drilling (simple), a
 * circular pocket plus a drilling on its floor (counterbore), or a drilling plus a chamfer on its
 * mouth (countersink).
 * Doc: docs/modes/design-v0.4.md#hole-feature, docs/modes/design-v0.4.md#implementation-f3,
 * docs/modes/design-v0.4.md#implementation-f4
 *
 * Only types come from feature.ts, which registers this kind as built in (so every reader of a
 * part knows it); the commands are in hole-commands.ts.
 */
import { z } from 'zod'
import type { Issue, IssuePath } from '../../shared/errors/app-error'
import { parseWith } from '../../shared/parse'
import { collect, fail, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import { chamferTerraces, type DfmWarning } from '../geometry/model'
import { quantityDto, quantityFromDTO } from '../library/item'
import type { UnitSystem } from '../project/document'
import { Quantity } from '../quantity/quantity'
import { Rational } from '../quantity/rational'
import { Tolerance } from '../quantity/tolerance'
import { FASTENER_FITS, FASTENER_TABLE, type FastenerFit, type FastenerRow } from './fastener/data'
import type { ExpandedOperation, ExpansionContext, FeatureBase, FeatureKindSpec } from './feature'
import { FeatureDtoSchema, type FeatureDTO } from './feature.dto'
import { CENTRE_ANCHOR, DEFAULTS, fieldContext, type Point } from './operation'
import { DRILL_BOTTOMS, type DrillBottomKind } from './part.dto'

/** How a countersink is cut (F7): a chamfer mill, or terraces by the hole's end mill. */
export const CS_METHODS = ['chamfer', 'stepped'] as const
export type CsMethod = (typeof CS_METHODS)[number]

/** Hole types, one `HoleHead` variant each. */
export const HOLE_TYPES = ['simple', 'counterbore', 'countersink'] as const
export type HoleType = (typeof HOLE_TYPES)[number]

export const HOLE_PURPOSES = ['clearance', 'tapDrill'] as const
export type HolePurpose = (typeof HOLE_PURPOSES)[number]

/** Table keys (`M3`), for the argument and record schemas. */
export const FASTENER_SIZES = FASTENER_TABLE.map((r) => r.size) as [string, ...string[]]

/** What sits at the hole's mouth, by `type`; each variant carries only its own sizes. */
export type HoleHead =
  | { readonly type: 'simple' }
  | { readonly type: 'counterbore'; readonly cbDiameter: Quantity; readonly cbDepth: Quantity }
  | {
      readonly type: 'countersink'
      readonly csDiameter: Quantity
      readonly csAngle: Quantity
      /**
       * Some = `csMethod: stepped` (F7, D41): terraces of at most this height by the hole's own
       * end mill; None = `chamfer` (a chamfer mill, the default).
       */
      readonly csStepdown: Option<Quantity>
    }

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
const HALF = Rational.create(1n, 2n).unwrap()

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
  /** Countersunk head dk + 2 × `headSink`. */
  readonly csDiameter: Quantity
  /** The countersunk head's angle (90° ISO). */
  readonly csAngle: Quantity
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
  const dk = tableLength(row.countersunkHead.diameter, units)
  const sink2 = headSink.exact.add(headSink.exact)
  return collect([
    tableLength(d, units),
    tableLength(row.counterbore.diameter, units),
    k.andThen((k) => derivedLength(k.exact.add(headSink.exact), units)),
    dk.andThen((dk) => derivedLength(dk.exact.add(sink2), units)),
    Quantity.parse(`${row.countersunkHead.angle}°`, fieldContext('angle', units)),
  ]).map(([diameter, cbDiameter, cbDepth, csDiameter, csAngle]) => ({
    diameter: diameter!,
    cbDiameter: cbDiameter!,
    cbDepth: cbDepth!,
    csDiameter: csDiameter!,
    csAngle: csAngle!,
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
  csDiameter: length().optional(),
  csAngle: quantityDto('angle').optional(),
  /** F7: stored only when `stepped`, with `csStepdown`. */
  csMethod: z.enum(CS_METHODS).optional(),
  csStepdown: length().optional(),
})

function holeFromDTO(raw: FeatureDTO): AppResult<Hole> {
  const parsed = parseWith(HoleDtoSchema, raw, 'holeFromDTO')
  if (parsed.isErr()) return parsed
  const d = parsed.unwrap()
  type Dto = z.output<ReturnType<typeof length>> | z.output<ReturnType<typeof quantityDto>>
  const q = (dto: Dto, ...path: (string | number)[]) => quantityFromDTO(dto, ...path)
  const missing = (path: string) =>
    fail('input.malformed', `hole ${d.id}: ${path} is missing`, {
      issues: [{ path: [path], rule: 'required', message: `is required for a ${d.type}` }],
      where: 'holeFromDTO',
    })
  /** A head size: required by its own type, ignored otherwise. */
  const head = (type: HoleType, dto: Dto | undefined, path: string) =>
    d.type !== type ? Ok(undefined) : dto === undefined ? missing(path) : q(dto, path)
  const opt = (dto: Dto | undefined, path: string) =>
    dto === undefined ? Ok(undefined) : q(dto, path)
  return collect<Quantity | undefined>([
    q(d.center[0], 'center', 0),
    q(d.center[1], 'center', 1),
    q(d.diameter, 'diameter'),
    opt(d.depth, 'depth'),
    q(d.headSink, 'headSink'),
    head('counterbore', d.cbDiameter, 'cbDiameter'),
    head('counterbore', d.cbDepth, 'cbDepth'),
    head('countersink', d.csDiameter, 'csDiameter'),
    head('countersink', d.csAngle, 'csAngle'),
    d.type === 'countersink' && d.csMethod === 'stepped'
      ? head('countersink', d.csStepdown, 'csStepdown')
      : Ok(undefined),
  ]).map(([u, v, diameter, depth, headSink, cbDiameter, cbDepth, csDiameter, csAngle, step]) => ({
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
    head:
      d.type === 'counterbore'
        ? { type: 'counterbore', cbDiameter: cbDiameter!, cbDepth: cbDepth! }
        : d.type === 'countersink'
          ? {
              type: 'countersink',
              csDiameter: csDiameter!,
              csAngle: csAngle!,
              csStepdown: step === undefined ? None : Some(step),
            }
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
    ...(h.head.type === 'countersink'
      ? {
          csDiameter: h.head.csDiameter.toDTO(),
          csAngle: h.head.csAngle.toDTO(),
          ...(h.head.csStepdown.isSome()
            ? { csMethod: 'stepped', csStepdown: h.head.csStepdown.unwrap().toDTO() }
            : {}),
        }
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
  if (h.head.type === 'countersink') {
    // the angle's range and the stepdown's minimum are the owned chamfer's rules (validate.ts),
    // reported at csAngle / csStepdown by fieldOf
    const { csDiameter, csAngle } = h.head
    const wider = csDiameter.exact.compare(h.diameter.exact) > 0
    check(wider, 'csDiameter', 'greaterThanDiameter', 'must be greater than the hole diameter', {
      min: h.diameter.canonical,
      actual: csDiameter.canonical,
    })
    if (wider && depth !== undefined) {
      const tan = Math.tan(((csAngle.canonical / 2) * Math.PI) / 180)
      const cone = (csDiameter.canonical - h.diameter.canonical) / 2 / tan
      check(
        !(tan > 0) || cone < depth.canonical,
        'csDiameter',
        'countersinkTooDeep',
        `the countersink cone (${round3(cone)} mm deep) must end above the hole bottom (depth ${depth.canonical} mm)`,
        {
          coneDepth: round3(cone),
          depth: depth.canonical,
          max: Math.floor((h.diameter.canonical + 2 * depth.canonical * tan) * 1000 + 1e-6) / 1000,
          actual: csDiameter.canonical,
        },
      )
    }
  }
  return issues
}

const round3 = (x: number) => Math.round(x * 1000) / 1000

// ── expansion ──────────────────────────────────────────────────────────────────────────────

/**
 * simple → `drill`; counterbore → `counterbore` (circular pocket) then `drill` on its floor,
 * blind depth `depth − cbDepth`; countersink → `drill` then `countersink`, a chamfer on the
 * drilling's mouth (design-v0.4.md § Expansion). A drill point gets the drilling's
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
  if (h.head.type === 'countersink') {
    // the chamfer stores its width (D45): (csDiameter − diameter) / 2, exact, with half
    // csDiameter's tolerance (B5: the mill sets the outer circle from the nominal edge)
    const cs = h.head.csDiameter
    const width = halfTolerance(cs.tolerance).andThen((tolerance) =>
      derivedLength(cs.exact.sub(h.diameter.exact).mul(HALF), ctx.units, tolerance),
    )
    if (width.isErr()) return width
    return Ok([
      drill(h.on, h.depth),
      {
        role: 'countersink',
        operation: {
          kind: 'chamfer',
          on: h.on,
          edgeOf: ctx.ownedId('drill'),
          width: width.unwrap(),
          angle: h.head.csAngle,
          stepdown: h.head.csStepdown,
        },
      },
    ])
  }
  const { cbDiameter, cbDepth } = h.head
  const below: AppResult<Option<Quantity>> = h.depth.isNone()
    ? Ok(None)
    : belowTolerance(h.depth.unwrap().tolerance, cbDepth.tolerance)
        .andThen((tolerance) =>
          derivedLength(h.depth.unwrap().exact.sub(cbDepth.exact), ctx.units, tolerance),
        )
        .map(Some)
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

/** `csDiameter`'s explicit tolerance halved, for the countersink width (design-v0.4.md § B5). */
function halfTolerance(t: Option<Tolerance>): AppResult<Option<Tolerance>> {
  if (t.isNone()) return Ok(None)
  const { notation, upper, lower } = t.unwrap()
  return Tolerance.create({ notation, upper: upper.mul(HALF), lower: lower.mul(HALF) }).map(Some)
}

/**
 * The tolerance of the drill below a blind counterbore (design-v0.4.md § Tolerances of derived
 * sizes, B5: absolute bottom): the deviations that make the floor's band plus the segment's equal
 * the hole depth's; a zero band at their midpoint when `cbDepth`'s band is the wider. An
 * untoleranced hole depth stays untoleranced.
 */
function belowTolerance(
  depth: Option<Tolerance>,
  cbDepth: Option<Tolerance>,
): AppResult<Option<Tolerance>> {
  if (depth.isNone()) return Ok(None)
  const d = depth.unwrap()
  if (cbDepth.isNone()) return Ok(depth)
  const cb = cbDepth.unwrap()
  let upper = d.upper.sub(cb.upper)
  let lower = d.lower.sub(cb.lower)
  if (upper.compare(lower) < 0) upper = lower = upper.add(lower).mul(HALF)
  return Tolerance.create({ notation: 'deviations', upper, lower }).map(Some)
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
  countersink: { width: 'csDiameter', angle: 'csAngle', stepdown: 'csStepdown', on: 'on' },
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
  const heads: [string, Quantity][] =
    head.type === 'counterbore'
      ? [
          ['cbDiameter', head.cbDiameter],
          ['cbDepth', head.cbDepth],
        ]
      : head.type === 'countersink'
        ? [
            ['csDiameter', head.csDiameter],
            ['csAngle', head.csAngle],
            ...(head.csStepdown.isSome()
              ? [['csStepdown', head.csStepdown.unwrap()] as [string, Quantity]]
              : []),
          ]
        : []
  return collect<Quantity | undefined>([
    at(h.center[0], 'center.0'),
    at(h.center[1], 'center.1'),
    at(h.diameter, 'diameter'),
    h.depth.isSome() ? at(h.depth.unwrap(), 'depth') : Ok(undefined),
    at(h.headSink, 'headSink'),
    ...heads.map(([path, q]) => at(q, path)),
  ]).map(([u, v, diameter, depth, headSink, a, b, c]) => ({
    ...h,
    center: [u!, v!],
    diameter: diameter!,
    depth: depth === undefined ? None : Some(depth),
    headSink: headSink!,
    head:
      head.type === 'counterbore'
        ? { type: 'counterbore', cbDiameter: a!, cbDepth: b! }
        : head.type === 'countersink'
          ? {
              type: 'countersink',
              csDiameter: a!,
              csAngle: b!,
              csStepdown: c === undefined ? None : Some(c),
            }
          : head,
  }))
}

/** The hole's notes: `dfm.countersinkStepped`, then `dfm.holeCustomSize`. */
function holeWarnings(h: Hole, ownedId: (role: string) => string): DfmWarning[] {
  return [...steppedNote(h, ownedId), ...customSizeNotes(h, ownedId)]
}

/** `dfm.countersinkStepped` (info, F7): the cone is cut as terraces, up to one past it. */
function steppedNote(h: Hole, ownedId: (role: string) => string): DfmWarning[] {
  if (h.head.type !== 'countersink' || h.head.csStepdown.isNone()) return []
  const t = chamferTerraces(
    {
      edgeDiameter: h.diameter.canonical,
      diameter: h.head.csDiameter.canonical,
      angle: h.head.csAngle.canonical,
    },
    h.head.csStepdown.unwrap().canonical,
  )
  if (t === undefined) return []
  return [
    {
      code: 'dfm.countersinkStepped',
      severity: 'info',
      message: `stepped countersink: ${t.count} terraces of ${round3(t.height)} mm by the hole's end mill; the cone is cut past by up to one terrace, hidden under the screw head`,
      operation: ownedId('countersink'),
      parameter: 'csMethod',
      params: { stepdown: round3(t.height), terraces: t.count, feature: h.id },
    },
  ]
}

/**
 * `dfm.holeCustomSize` (info): a size that differs from the table row the hole names, on the
 * owned operation that carries it. Params `{ field, table, value }` (mm; csAngle in degrees) plus
 * `fastener`.
 */
function customSizeNotes(h: Hole, ownedId: (role: string) => string): DfmWarning[] {
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
  if (h.head.type === 'countersink')
    sizes.push(
      ['csDiameter', 'countersink', h.head.csDiameter, t.csDiameter],
      ['csAngle', 'countersink', h.head.csAngle, t.csAngle],
    )
  return sizes
    .filter(([, , value, want]) => !value.exact.equals(want.exact))
    .map(([field, role, value, want]) => {
      const unit = value.kind === 'angle' ? '°' : ' mm'
      return {
        code: 'dfm.holeCustomSize',
        severity: 'info',
        message: `${field} ${value.canonical}${unit} differs from the ${size} table value ${want.canonical}${unit} (custom)`,
        operation: ownedId(role),
        parameter: field,
        params: {
          field,
          table: want.canonical,
          value: value.canonical,
          fastener: size,
          feature: h.id,
        },
      } satisfies DfmWarning
    })
}

export const holeSpec: FeatureKindSpec<Hole> = {
  kind: 'hole',
  idPrefix: 'hole',
  label: 'Bolt hole',
  fromDTO: holeFromDTO,
  toDTO: holeToDTO,
  invariants: holeInvariants,
  expand: expandHole,
  reevaluate: reevaluateHole,
  fieldOf: holeFieldOf,
  warnings: holeWarnings,
  // the refill of design.hole.add/update (hole-commands.ts): a new fastener, purpose, fit, head
  // type or headSink rewrites the table sizes in the same command
  pendingFolds: {
    drivers: ['fastener', 'purpose', 'fit', 'headSink', 'type'],
    derived: ['diameter', 'cbDiameter', 'cbDepth', 'csDiameter', 'csAngle'],
  },
}
