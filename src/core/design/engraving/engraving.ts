/**
 * The engraved pattern feature kind (engraved-patterns.md EP-E, E3): a motif of lines (a preset
 * SVG or the part's named shapes, with their levels) placed once on a face — at a centre and size,
 * or fitted to the boundary less the margin — and cut by one owned Line. The feature owns a
 * read-only shape `<id>_lines` (an engraving record, resolved by engraving/resolve.ts when the
 * Line's geometry is built) and the Line `<id>_line` that grooves it. Boundary and margin are
 * Pattern's (a named closed shape placed by its box centre, else the face). Layout `single` only:
 * lattices, clipping and radial rotation are E4.
 * Doc: docs/modes/engraved-patterns.md#engraved-pattern-feature,
 * docs/modes/engraved-patterns.md#implementation-e3
 *
 * Only types come from feature.ts, which registers this kind as built in; the commands are in
 * engraving/commands.ts.
 */
import { z } from 'zod'
import type { Issue, IssuePath } from '../../../shared/errors/app-error'
import { parseWith } from '../../../shared/parse'
import { collect, fail, None, Ok, Some, type AppResult, type Option } from '../../../shared/result'
import type { Region2dPort } from '../../geometry/2d/port'
import type { DfmWarning } from '../../geometry/model'
import { quantityDto, quantityFromDTO } from '../../library/item'
import type { Stock } from '../../library/stock'
import { Quantity } from '../../quantity/quantity'
import type { QuantityDTO } from '../../quantity/quantity.dto'
import { Rational } from '../../quantity/rational'
import { derivedLength } from '../hole'
import type { ExpandedOperation, ExpansionContext, FeatureBase, FeatureKindSpec } from '../feature'
import { FeatureDtoSchema, type FeatureDTO } from '../feature.dto'
import type { Anchor, LineDepth, Operation, Point } from '../operation'
import { faceRect, type PatternBoundary } from '../pattern/pattern'
import { shapeFromDTO, type NamedShape } from '../shape'
import type { EngravingRecord, ShapeDTO } from '../shape.dto'
import { ENGRAVING_PRESET_IDS, engravingPreset } from './presets'
import {
  ENGRAVING_HEAVY_ELEMENTS,
  ENGRAVING_HEAVY_LENGTH,
  resolveEngraving,
  type ResolvedEngraving,
} from './resolve'

export type EngravingMotif =
  | { readonly kind: 'preset'; readonly preset: string }
  | { readonly kind: 'shapes'; readonly shapeIds: readonly string[] }

/** `whole`: the motif at its size; `boundary`: scaled to fit the boundary less the margin. */
export type EngravingFit = 'whole' | 'boundary'

export interface Engraving extends FeatureBase {
  readonly kind: 'engraving'
  readonly motif: EngravingMotif
  /** Where the motif's frame centre goes (face frame); None = the centre of the area. */
  readonly center: Option<Point>
  /** The motif frame's width; None = its own (a preset's SVG width, the shapes' box). */
  readonly size: Option<Quantity>
  /** About the motif's frame centre. */
  readonly rotation: Quantity
  /** None = the `on` face's rectangle; a named closed shape placed by its box centre (Pattern's). */
  readonly boundary: Option<PatternBoundary>
  /** The uncut border inside the boundary (≥ 0). */
  readonly margin: Quantity
  readonly fit: EngravingFit
  /** The owned Line's depth: constant, start → end, or `{ min, max }` from the levels. */
  readonly depth: LineDepth
}

export const ownedLinesId = (featureId: string): string => `${featureId}_lines`

/** A round preset fits its boundary by default; every other motif keeps its size (E3, EP-F). */
export const defaultFit = (motif: EngravingMotif): EngravingFit =>
  motif.kind === 'preset' && engravingPreset(motif.preset)?.kind === 'round' ? 'boundary' : 'whole'

// ── record ─────────────────────────────────────────────────────────────────────────────────

const length = () => quantityDto('length')
const angle = () => quantityDto('angle')

/** A Line depth as stored (operation.ts `LineDepth`'s record). */
const DepthDtoSchema = z.union([
  length(),
  z.object({ start: length(), end: length() }),
  z.object({ min: length(), max: length() }),
])

/** The stored engraved pattern (`part.features[]`). */
const EngravingDtoSchema = FeatureDtoSchema.extend({
  kind: z.literal('engraving'),
  motif: z.union([
    z.object({ preset: z.string().min(1).max(64) }),
    z.object({ shapeIds: z.array(z.string()).min(1).max(50) }),
  ]),
  center: z.tuple([length(), length()]).optional(),
  size: length().optional(),
  rotation: angle().optional(),
  boundary: z
    .object({ shapeId: z.string(), center: z.tuple([length(), length()]), rotation: angle() })
    .optional(),
  margin: length(),
  fit: z.enum(['whole', 'boundary']).optional(),
  depth: DepthDtoSchema,
})

function engravingFromDTO(raw: FeatureDTO): AppResult<Engraving> {
  const parsed = parseWith(EngravingDtoSchema, raw, 'engravingFromDTO')
  if (parsed.isErr()) return parsed
  const d = parsed.unwrap()
  const q = (dto: QuantityDTO, ...path: (string | number)[]) => quantityFromDTO(dto, ...path)
  const opt = (
    dto: QuantityDTO | undefined,
    ...path: (string | number)[]
  ): AppResult<Quantity | undefined> => (dto === undefined ? Ok(undefined) : q(dto, ...path))
  const pair = (
    p: readonly [QuantityDTO, QuantityDTO] | undefined,
    ...path: string[]
  ): AppResult<Point | undefined> =>
    p === undefined
      ? Ok(undefined)
      : collect([q(p[0], ...path, '0'), q(p[1], ...path, '1')]).map(
          (x): Point => [x[0]!, x[1]!] as const,
        )
  const dd = d.depth
  const depth: AppResult<LineDepth> =
    'start' in dd
      ? collect([q(dd.start, 'depth', 'start'), q(dd.end, 'depth', 'end')]).map(
          ([start, end]): LineDepth => ({ kind: 'ramp', start: start!, end: end! }),
        )
      : 'min' in dd
        ? collect([q(dd.min, 'depth', 'min'), q(dd.max, 'depth', 'max')]).map(
            ([min, max]): LineDepth => ({ kind: 'levels', min: min!, max: max! }),
          )
        : q(dd, 'depth').map((v): LineDepth => ({ kind: 'constant', depth: v }))
  const rotation =
    d.rotation === undefined
      ? Quantity.parse('0', { kind: 'angle', defaultUnit: 'deg' })
      : q(d.rotation, 'rotation')
  const bd = d.boundary
  const boundary: AppResult<Quantity[] | undefined> =
    bd === undefined
      ? Ok(undefined)
      : collect([
          q(bd.center[0], 'boundary', 'center', 0),
          q(bd.center[1], 'boundary', 'center', 1),
          q(bd.rotation, 'boundary', 'rotation'),
        ])
  const center = pair(d.center, 'center')
  const size = opt(d.size, 'size')
  const margin = q(d.margin, 'margin')
  return collect<unknown>([depth, rotation, boundary, center, size, margin]).map(() => {
    const motif: EngravingMotif =
      'preset' in d.motif
        ? { kind: 'preset', preset: d.motif.preset }
        : { kind: 'shapes', shapeIds: [...d.motif.shapeIds] }
    const b = boundary.unwrap()
    const c = center.unwrap()
    const s = size.unwrap()
    return {
      kind: 'engraving' as const,
      id: d.id,
      name: d.name,
      on: d.on,
      motif,
      center: c === undefined ? None : Some(c),
      size: s === undefined ? None : Some(s),
      rotation: rotation.unwrap(),
      boundary:
        b === undefined || bd === undefined
          ? None
          : Some({ shapeId: bd.shapeId, center: [b[0]!, b[1]!] as const, rotation: b[2]! }),
      margin: margin.unwrap(),
      fit: d.fit ?? 'whole',
      depth: depth.unwrap(),
    }
  })
}

function depthToDTO(d: LineDepth): z.input<typeof DepthDtoSchema> {
  return (
    d.kind === 'constant'
      ? d.depth.toDTO()
      : d.kind === 'ramp'
        ? { start: d.start.toDTO(), end: d.end.toDTO() }
        : { min: d.min.toDTO(), max: d.max.toDTO() }
  ) as never
}

function engravingToDTO(e: Engraving): FeatureDTO {
  return {
    id: e.id,
    kind: 'engraving',
    name: e.name,
    on: e.on,
    motif:
      e.motif.kind === 'preset' ? { preset: e.motif.preset } : { shapeIds: [...e.motif.shapeIds] },
    ...(e.center.isSome()
      ? { center: [e.center.unwrap()[0].toDTO(), e.center.unwrap()[1].toDTO()] }
      : {}),
    ...(e.size.isSome() ? { size: e.size.unwrap().toDTO() } : {}),
    ...(e.rotation.canonical === 0 ? {} : { rotation: e.rotation.toDTO() }),
    ...(e.boundary.isSome()
      ? {
          boundary: {
            shapeId: e.boundary.unwrap().shapeId,
            center: [e.boundary.unwrap().center[0].toDTO(), e.boundary.unwrap().center[1].toDTO()],
            rotation: e.boundary.unwrap().rotation.toDTO(),
          },
        }
      : {}),
    margin: e.margin.toDTO(),
    ...(e.fit === 'whole' ? {} : { fit: e.fit }),
    depth: depthToDTO(e.depth),
  }
}

// ── invariants ─────────────────────────────────────────────────────────────────────────────

const ZERO = Rational.ZERO

/**
 * Field rules that need no geometry. The depth's are the owned Line's (validate.ts, mapped to
 * `depth` by `fieldOf`); the motif and boundary shapes are checked with the part's shapes
 * (`engravingShapes`), the motif's lines when they resolve (resolve.ts).
 */
function engravingInvariants(e: Engraving): Issue[] {
  const issues: Issue[] = []
  const check = (ok: boolean, path: (string | number)[], rule: string, message: string) => {
    if (!ok) issues.push({ path, rule, message })
  }
  check(e.margin.exact.compare(ZERO) >= 0, ['margin'], 'nonNegative', 'must be 0 or more')
  if (e.size.isSome())
    check(e.size.unwrap().exact.compare(ZERO) > 0, ['size'], 'positive', 'must be greater than 0')
  if (e.motif.kind === 'preset')
    check(
      engravingPreset(e.motif.preset) !== undefined,
      ['motif', 'preset'],
      'unknownPreset',
      `no such preset; one of ${ENGRAVING_PRESET_IDS.join(', ')}`,
    )
  else
    e.motif.shapeIds.forEach((id, k) =>
      check(
        /^shape[1-9]\d*$/.test(id),
        ['motif', 'shapeIds', k],
        'shapeCycle',
        "an engraving's motif is a named shape of the part, not an owned shape",
      ),
    )
  if (e.boundary.isSome())
    check(
      /^shape[1-9]\d*$/.test(e.boundary.unwrap().shapeId),
      ['boundary', 'shapeId'],
      'shapeCycle',
      "an engraving's boundary is a named shape of the part, not an owned shape",
    )
  return issues
}

// ── expansion ──────────────────────────────────────────────────────────────────────────────

const MIN_ANCHOR: Anchor = Object.freeze({ u: 'min', v: 'min' })

/**
 * One owned Line on the owned shape, placed at [0, 0] (the resolved lines keep face-frame
 * coordinates; a Clones copy moves them by its offset), with the feature's depth and the Line's
 * default blend.
 */
function expandEngraving(
  e: Engraving,
  ctx: ExpansionContext,
): AppResult<readonly ExpandedOperation[]> {
  return derivedLength(ZERO, ctx.units).map((zero): ExpandedOperation[] => [
    {
      role: 'line',
      operation: {
        kind: 'line' as const,
        on: e.on,
        paths: [
          {
            kind: 'named' as const,
            center: [zero, zero] as const,
            anchor: MIN_ANCHOR,
            shapeId: ownedLinesId(e.id),
            rotation: None,
            mirror: false,
          },
        ],
        depth: e.depth,
        blend: None,
      },
    },
  ])
}

/** The engraving's owned shape record: its motif and placement as numbers (shape.dto.ts). */
export function engravingRecord(
  e: Engraving,
  before: readonly Operation[],
  stock: Stock,
): EngravingRecord {
  return {
    motif:
      e.motif.kind === 'preset' ? { preset: e.motif.preset } : { shapeIds: [...e.motif.shapeIds] },
    boundary: faceRect(e.on, before, stock),
    ...(e.boundary.isSome()
      ? {
          area: {
            shapeId: e.boundary.unwrap().shapeId,
            center: [
              e.boundary.unwrap().center[0].canonical,
              e.boundary.unwrap().center[1].canonical,
            ],
            rotation: e.boundary.unwrap().rotation.canonical,
          },
        }
      : {}),
    margin: e.margin.canonical,
    ...(e.center.isSome()
      ? { center: [e.center.unwrap()[0].canonical, e.center.unwrap()[1].canonical] }
      : {}),
    ...(e.size.isSome() ? { size: e.size.unwrap().canonical } : {}),
    rotation: e.rotation.canonical,
    ...(e.fit === 'boundary' ? { fit: 'boundary' as const } : {}),
  }
}

function engravingShapes(e: Engraving, ctx: ExpansionContext): AppResult<readonly ShapeDTO[]> {
  const issue = (path: (string | number)[], rule: string, message: string, shapeId: string) =>
    fail('input.malformed', `shape ${shapeId}: ${message}`, {
      issues: [{ path, rule, message }],
      data: { shapeId },
    })
  const find = (id: string) => ctx.shapes.find((s) => s.id === id && s.owner === undefined)
  const noShape = "no such shape; design_shape_list lists the part's shapes"
  if (e.motif.kind === 'shapes')
    for (const [k, id] of e.motif.shapeIds.entries())
      if (find(id) === undefined)
        return issue(['motif', 'shapeIds', k], 'unknownShape', noShape, id)
  if (e.boundary.isSome()) {
    const id = e.boundary.unwrap().shapeId
    const b = find(id)
    if (b === undefined) return issue(['boundary', 'shapeId'], 'unknownShape', noShape, id)
    if (b.items.some((i) => i.kind === 'path' && i.closed === false))
      return issue(
        ['boundary', 'shapeId'],
        'engravingBoundaryOpen',
        'the boundary must be a closed shape',
        id,
      )
  }
  return Ok([
    {
      id: ownedLinesId(e.id),
      name: `${e.name} · lines`,
      items: [],
      owner: e.id,
      engraving: engravingRecord(e, ctx.before, ctx.stock),
    },
  ])
}

// ── checks ─────────────────────────────────────────────────────────────────────────────────

/** Owned Line parameter → engraving field. */
function engravingFieldOf(role: string, path: IssuePath): IssuePath | undefined {
  if (role !== 'line') return undefined
  const head = String(path[0])
  if (head === 'depth' || head === 'on') return [head, ...path.slice(1)]
  // the owned shape's resolution names the engraving's own fields (resolve.ts)
  if (head === 'shapes') return path.slice(2)
  if (head === 'paths') return ['motif']
  return undefined
}

/**
 * What an engraving's owned shape resolves to (cached), from the part's shape records: the lines
 * and the facts; undefined when it does not resolve. The add/update result, the findings, the
 * inspector's read-out and the viewport.
 */
export function engravingResolved(
  featureId: string,
  shapes: readonly ShapeDTO[],
  port: Region2dPort | undefined,
): ResolvedEngraving | undefined {
  const own = shapes.find((s) => s.id === ownedLinesId(featureId))
  const rec = own?.engraving
  if (rec === undefined) return undefined
  const ids = new Set([
    ...('shapeIds' in rec.motif ? rec.motif.shapeIds : []),
    ...(rec.area === undefined ? [] : [rec.area.shapeId]),
  ])
  const loaded = new Map<string, NamedShape>()
  for (const s of shapes)
    if (ids.has(s.id)) {
      const n = shapeFromDTO(s)
      if (n.isErr()) return undefined
      loaded.set(s.id, n.unwrap())
    }
  const r = resolveEngraving(rec, loaded, port)
  return r.isOk() ? r.unwrap() : undefined
}

/**
 * `dfm.engravingEmpty` (no line inside the boundary less the margin: the margin leaves nothing,
 * or the motif sits wholly outside it) and `dfm.engravingHeavy` (info: more than
 * `ENGRAVING_HEAVY_ELEMENTS` lines and arcs or `ENGRAVING_HEAVY_LENGTH` mm); `operation` = the
 * feature id. The Line's own findings (`dfm.lineTooDeep`, `dfm.lineShallow`) come from the owned
 * Line.
 */
function engravingWarnings(
  e: Engraving,
  _ops: readonly Operation[],
  _stock: Stock,
  _units: unknown,
  shapes: readonly ShapeDTO[],
  geometry: { readonly region2d?: Region2dPort | undefined },
): DfmWarning[] {
  const r = engravingResolved(e.id, shapes, geometry.region2d)
  if (r === undefined) return []
  const { area, bounds, elements, length } = r.facts
  const outside =
    area === undefined ||
    bounds === undefined ||
    bounds.max[0] < area.min[0] ||
    bounds.min[0] > area.max[0] ||
    bounds.max[1] < area.min[1] ||
    bounds.min[1] > area.max[1]
  const out: DfmWarning[] = []
  if (outside)
    out.push({
      code: 'dfm.engravingEmpty',
      severity: 'warning',
      message: `${e.name}: no line lies inside the boundary less the margin; make the margin smaller or move the motif`,
      operation: e.id,
      parameter: 'margin',
      params: { feature: e.id },
    })
  if (elements > ENGRAVING_HEAVY_ELEMENTS || length > ENGRAVING_HEAVY_LENGTH)
    out.push({
      code: 'dfm.engravingHeavy',
      severity: 'info',
      message: `${e.name}: ${elements} lines and arcs (${Math.round(length)} mm): the part updates more slowly`,
      operation: e.id,
      parameter: 'motif',
      params: { feature: e.id, elements, length: Math.round(length) },
    })
  return out
}

function engravingResult(
  e: Engraving,
  shapes: readonly ShapeDTO[],
  port: Region2dPort | undefined,
): Record<string, number> {
  const r = engravingResolved(e.id, shapes, port)
  if (r === undefined) return {}
  return {
    lines: r.facts.lines,
    length: Math.round(r.facts.length * 10) / 10,
    size: Math.round(r.facts.size * 100) / 100,
  }
}

export const engravingSpec: FeatureKindSpec<Engraving> = {
  kind: 'engraving',
  idPrefix: 'engraving',
  label: 'Engraved pattern',
  fromDTO: engravingFromDTO,
  toDTO: engravingToDTO,
  invariants: engravingInvariants,
  expand: expandEngraving,
  ownedShapes: engravingShapes,
  fieldOf: engravingFieldOf,
  spanWarnings: engravingWarnings,
  resultOf: engravingResult,
}
