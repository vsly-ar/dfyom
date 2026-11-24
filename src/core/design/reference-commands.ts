/**
 * Reference-model commands and the list query (`design.reference.*`).
 * Doc: docs/modes/reference-model.md#commands-and-queries
 *
 * All are `document` commands with no deferred work (instant reactions, never pending). Import
 * copies and parses the file in its `prepare` step (docs/architecture/commands.md#prepared-input)
 * and then writes the record like any other document command, so undo removes the record and
 * redo restores it without touching the file again. A reference never changes the part.
 */
import type { Draft } from 'immer'
import { z } from 'zod'
import { collect, Err, fail, None, Ok, type AppResult } from '../../shared/result'
import {
  defineAsyncQuery,
  defineCommand,
  defineQuery,
  type AnyCommand,
  type AnyQueryDef,
} from '../commands/define'
import type { CommandContext } from '../commands/context'
import { quantityFromSource } from '../expression/quantity'
import { NAME_MAX } from '../library/item'
import type { AssetRef } from '../project/assets'
import type { ProjectDoc, UnitSystem } from '../project/document'
import type { QuantityDTO } from '../quantity/quantity.dto'
import { Quantity } from '../quantity/quantity'
import { Rational } from '../quantity/rational'
import { stlParse } from '../workers/tasks'
import { loadPart, type LoadedPart } from './load'
import { fieldContext, type FieldKind } from './operation'
import { PartIdSchema } from './part.dto'
import {
  AnchorSchema,
  exceedsStock,
  FIT_AXES,
  FIT_Z,
  fitPosition,
  fitScale,
  guessUnit,
  placedBox,
  placedExtent,
  ReferenceWarningSchema,
  roundScaleDown,
  suggestFacingDepth,
  type Placement,
  type ReferenceWarning,
  type StockSize,
  UNIT_MM,
} from './reference'
import { ReferenceDtoSchema, type ReferenceDTO } from './reference.dto'
import {
  HOLE_LIMIT,
  HOLE_MAX_DIAMETER_MM,
  HOLE_TOLERANCE,
  holeGroups,
  holeSuggestion,
  type HoleGroup,
} from './mesh-holes'
import { STL_LIMITS, type StlSummary } from './stl'
import {
  FaceArg,
  fitOptions,
  lengthArg,
  referenceHolesOf,
  referenceLevelsOf,
  referenceView,
  resolveFace,
  smallestHoleTool,
  stockResolver,
  storedPlacement as placementOf,
  targetReference,
  fittedSection,
} from './reference-find'
import type { FittedLoop } from './reference-section'
import { DIRECTIONS, STOCK_FACE } from '../geometry/face'
import type { Vec3 } from '../geometry/model'
import { TOOL_MATCH_TOLERANCE } from '../geometry/dfm'

// ── args ──────────────────────────────────────────────────────────────────────────────────

const Src = z.string().min(1).max(256)
const Xyz = z.object({ x: Src.optional(), y: Src.optional(), z: Src.optional() })
const ReferenceIdSchema = z.string()
const RefArg = { partId: PartIdSchema, referenceId: ReferenceIdSchema }
const SourceUnitSchema = z.enum(['mm', 'inch'])
/** POSIX `/…`, Windows `C:\…` or `\\server\…`: the main process has no meaningful cwd. */
export const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/
const FitArg = z.object({
  anchor: AnchorSchema.optional(),
  z: z.enum(FIT_Z).optional(),
  margin: Src.optional().describe('Kept free on each side in X and Y (length)'),
  scaleTo: z
    .array(z.enum(FIT_AXES))
    .min(1)
    .max(3)
    .optional()
    .describe('Scale to the largest size fitting the stock along these axes'),
})

const Warnings = z.array(ReferenceWarningSchema)

const BoxSchema = z.object({
  min: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  max: z.object({ x: z.number(), y: z.number(), z: z.number() }),
})
const FacingDepthSchema = z
  .record(z.string(), z.string())
  .describe(
    'By stock face id: the facing depth that faces down to this reference (project units, rounded down); only faces with a sensible value',
  )
/** What a placement edit leaves (DF60 § Scale and fit): no follow-up `list` needed. */
const PlacedFields = {
  scale: z.string().describe('The scale as written'),
  placed: BoxSchema.describe('Placed bounding box in the part frame, mm'),
  facingDepth: FacingDepthSchema,
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────

function unknownReference(referenceId: string, where: string): AppResult<never> {
  return fail('input.malformed', `reference ${referenceId} does not exist in this part`, {
    issues: [{ path: ['referenceId'], rule: 'unknownReference', message: 'no such reference' }],
    where,
  })
}

function findReference(
  doc: ProjectDoc,
  partId: string,
  referenceId: string,
  where: string,
): AppResult<ReferenceDTO> {
  const ref = Object.hasOwn(doc.references, referenceId) ? doc.references[referenceId] : undefined
  if (ref === undefined || ref.partId !== partId) return unknownReference(referenceId, where)
  return Ok(ref)
}

const stockSize = (l: LoadedPart): StockSize => ({
  length: l.stock.length.canonical,
  width: l.stock.width.canonical,
  thickness: l.stock.thickness.canonical,
})

/** A length in mm written as a source in the project's units (0.0001 mm / 0.00001 in). */
function lengthSource(mm: number, units: UnitSystem): string {
  const trim = (s: string) => {
    const t = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
    return t === '-0' ? '0' : t
  }
  return units === 'mm' ? `${trim(mm.toFixed(4))} mm` : `${trim((mm / 25.4).toFixed(5))}"`
}

const literal = (source: string, kind: FieldKind, units: UnitSystem) =>
  Quantity.parse(source, fieldContext(kind, units)).map((q) => q.toDTO())

function positionDto(
  mm: { x: number; y: number; z: number },
  units: UnitSystem,
  where: string,
): AppResult<ReferenceDTO['position']> {
  const all = collect([
    literal(lengthSource(mm.x, units), 'length', units),
    literal(lengthSource(mm.y, units), 'length', units),
    literal(lengthSource(mm.z, units), 'length', units),
  ])
  if (all.isErr()) return Err(all.unwrapErr().withContext(where))
  const [x, y, z] = all.unwrap()
  return Ok({ x, y, z } as ReferenceDTO['position'])
}

type FitInput = z.output<typeof FitArg>

interface Fitted {
  readonly position: ReferenceDTO['position']
  /** The fitted position (mm). */
  readonly pos: { x: number; y: number; z: number }
  /** The new scale with `scaleTo`, else undefined (the scale stays). */
  readonly scale: ReferenceDTO['scale'] | undefined
  /** The placement after the fit (mm, degrees). */
  readonly placement: Placement
}

/**
 * Fit to stock of a reference with this placement (reference-model.md § Fit to stock): the
 * margin, then the scale to fit (`scaleTo`, rounded down), then the fitted position.
 */
function fitted(
  ref: ReferenceDTO,
  p: Placement,
  l: LoadedPart,
  fit: FitInput,
  where: string,
): AppResult<Fitted> {
  const stock = stockSize(l)
  const refused = (path: string, rule: string, message: string) =>
    fail('model.invariant', `fit.${path}: ${message}`, {
      issues: [{ path: ['fit', path], rule, message }],
      where,
    })
  let margin = 0
  if (fit.margin !== undefined) {
    const m = quantityFromSource(fit.margin, fieldContext('length', l.units), stockResolver(l))
    if (m.isErr()) return Err(m.unwrapErr().prefixIssues('fit', 'margin').withContext(where))
    margin = m.unwrap().canonical
    if (margin < 0) return refused('margin', 'nonNegative', 'must be 0 or more')
  }
  if (2 * margin >= stock.length || 2 * margin >= stock.width)
    return refused('margin', 'marginTooLarge', 'leaves no room on the stock')
  let placement = p
  let scale: ReferenceDTO['scale'] | undefined
  if (fit.scaleTo !== undefined) {
    const unit = placedExtent(ref.asset.bounds, { ...p, scale: 1 })
    const k = fitScale(unit, stock, fit.scaleTo, margin)
    if (!k.ok)
      return k.problem === 'marginTooLarge'
        ? refused('margin', 'marginTooLarge', 'leaves no room on the stock')
        : refused('scaleTo', 'zeroExtent', 'the reference has no size along these axes')
    const factor = roundScaleDown(k.scale)
    const dto = literal(String(factor), 'scalar', l.units)
    if (dto.isErr()) return Err(dto.unwrapErr().withContext(where))
    scale = dto.unwrap() as ReferenceDTO['scale']
    placement = { ...p, scale: factor }
  }
  const pos = fitPosition(
    placedExtent(ref.asset.bounds, placement),
    stock,
    fit.anchor ?? {},
    fit.z ?? 'top',
    margin,
  )
  return positionDto(pos, l.units, where).map((position) => ({
    position,
    pos,
    scale,
    placement: { ...placement, position: pos },
  }))
}

/** The placed box and facing depths of a record (as `design.reference.list` gives them). */
function placedFields(ref: ReferenceDTO, p: Placement, l: LoadedPart) {
  const placed = placedBox(ref.asset.bounds, p)
  const facingDepth: Record<string, string> = {}
  const boxes = [{ referenceId: ref.id, box: placed }]
  for (const d of DIRECTIONS) {
    const s = suggestFacingDepth(d, stockSize(l), boxes, l.units)
    if (s !== undefined) facingDepth[STOCK_FACE[d]] = s.source
  }
  return { scale: ref.scale.source, placed, facingDepth }
}

/** The record as it is in the draft, edited, then checked for `exceedsStock`. */
function edit(
  draft: Draft<ProjectDoc>,
  args: { partId: string; referenceId: string },
  where: string,
  change: (ref: ReferenceDTO, l: LoadedPart) => AppResult<Partial<ReferenceDTO>>,
  more: (ref: ReferenceDTO, p: Placement) => ReferenceWarning[] = () => [],
): AppResult<{ warnings: ReferenceWarning[] } & ReturnType<typeof placedFields>> {
  const doc = draft as ProjectDoc
  const loaded = loadPart(doc, args.partId, where)
  if (loaded.isErr()) return loaded
  const found = findReference(doc, args.partId, args.referenceId, where)
  if (found.isErr()) return found
  const changed = change(found.unwrap(), loaded.unwrap())
  if (changed.isErr()) return changed
  const target = draft.references[args.referenceId]!
  Object.assign(target, changed.unwrap())
  const ref = target as ReferenceDTO
  const l = loaded.unwrap()
  return placementOf(ref, where).map((p) => {
    const w = exceedsStock(ref.id, placedBox(ref.asset.bounds, p), stockSize(l))
    return {
      ...placedFields(ref, p, l),
      warnings: [...(w === undefined ? [] : [w]), ...more(ref, p)],
    }
  })
}

// ── small features after a scale change (DF60 P3) ───────────────────────────────────────────

/** The reference's hole sizes before an edit that may scale it (`reference.featureBelowTool`). */
interface HoleSizes {
  /** mm per source unit × scale of the stored record. */
  readonly factor: number
  /** The smallest library drill or end mill (mm). */
  readonly smallest: number
  /** Distinct bore diameters at `factor` (mm), with the largest count seen from one face. */
  readonly sizes: readonly { readonly diameter: number; readonly count: number }[]
}

/**
 * Reads the holes from the six stock faces when an update may change the scale (`scale`,
 * `fit.scaleTo` or `sourceUnit`) and the library has a drill or end mill; nothing otherwise, or
 * when the mesh cannot be read (the warning is a hint, never a reason to refuse the edit). The
 * worker keeps the holes per face, so later scale edits read none again.
 * Doc: docs/modes/reference-tools.md#4-scale-and-fit
 */
async function holeSizes(
  doc: ProjectDoc,
  args: { partId: string; referenceId: string },
  ctx: CommandContext,
  where: string,
): Promise<HoleSizes | undefined> {
  const smallest = smallestHoleTool(ctx)
  if (smallest === undefined) return undefined
  const loaded = loadPart(doc, args.partId, where)
  const found = findReference(doc, args.partId, args.referenceId, where)
  if (loaded.isErr() || found.isErr()) return undefined
  const ref = found.unwrap()
  const p = placementOf(ref, where)
  if (p.isErr()) return undefined
  const sizes: { diameter: number; count: number }[] = []
  for (const d of DIRECTIONS) {
    const view = referenceView(ref, p.unwrap(), stockSize(loaded.unwrap()), d)
    const r = await referenceHolesOf(
      ctx,
      view,
      { maxDiameter: HOLE_MAX_DIAMETER_MM, limit: HOLE_LIMIT },
      where,
    )
    if (r.isErr()) return undefined
    for (const g of holeGroups(r.unwrap().holes).groups) {
      const same = sizes.find((x) => Math.abs(x.diameter - g.size.diameter) <= HOLE_TOLERANCE)
      if (same === undefined) sizes.push({ diameter: g.size.diameter, count: g.count })
      else same.count = Math.max(same.count, g.count)
    }
  }
  return { factor: UNIT_MM[p.unwrap().sourceUnit] * p.unwrap().scale, smallest, sizes }
}

/** `reference.featureBelowTool` (info) per hole size the new placement puts below the smallest tool. */
function featureBelowTool(
  before: HoleSizes | undefined,
  ref: ReferenceDTO,
  p: Placement,
): ReferenceWarning[] {
  if (before === undefined) return []
  const ratio = (UNIT_MM[p.sourceUnit] * p.scale) / before.factor
  const out: ReferenceWarning[] = []
  for (const s of before.sizes) {
    const d = s.diameter * ratio
    if (d >= before.smallest - TOOL_MATCH_TOLERANCE) continue
    const dia = r3(d)
    out.push({
      code: 'reference.featureBelowTool',
      severity: 'info',
      message: `At scale ${ref.scale.source} ${s.count === 1 ? 'a hole' : `${s.count} holes`} of Ø ${dia} mm ${s.count === 1 ? 'is' : 'are'} smaller than the smallest drill or end mill in the library (Ø ${r3(before.smallest)} mm)`,
      referenceId: ref.id,
      params: {
        diameter: dia,
        count: s.count,
        smallest: r3(before.smallest),
        scale: ref.scale.source,
      },
    })
  }
  return out
}

function baseName(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? ''
  const name = file.replace(/\.[^.]*$/, '').slice(0, NAME_MAX)
  return name.trim().length > 0 ? name : 'Reference'
}

// ── commands ──────────────────────────────────────────────────────────────────────────────

interface Imported {
  readonly asset: AssetRef
  readonly mesh: StlSummary
}

const referenceImport = defineCommand({
  kind: 'document',
  name: 'design.reference.import',
  summary: "Import an STL as a part's reference model, fitted to the stock (default centre + top).",
  title: () => 'Import reference',
  machine: false,
  args: z.object({
    partId: PartIdSchema,
    path: z.string().max(4096).describe('Absolute local path'),
    name: z.string().min(1).max(NAME_MAX).optional(),
    sourceUnit: SourceUnitSchema.optional(),
    fit: FitArg.optional(),
  }),
  result: z.object({
    referenceId: ReferenceIdSchema,
    sourceUnit: SourceUnitSchema,
    guess: z.object({ unit: SourceUnitSchema, reason: z.string() }),
    ...PlacedFields,
    warnings: Warnings,
  }),
  async prepare(doc, args, ctx: CommandContext): Promise<AppResult<Imported>> {
    const where = 'design.reference.import'
    const loaded = loadPart(doc, args.partId, where)
    if (loaded.isErr()) return loaded
    if (!ABSOLUTE_PATH.test(args.path))
      return fail('input.malformed', `${args.path}: not an absolute path`, {
        issues: [{ path: ['path'], rule: 'absolutePath', message: 'must be an absolute path' }],
        where,
      })
    const session = ctx.services.project
    if (session === undefined)
      return fail('internal.unexpected', 'no project session configured', { where })
    const stored = await session.importAsset(args.path, { maxBytes: STL_LIMITS.maxBytes })
    if (stored.isErr()) return Err(stored.unwrapErr().withContext(where))
    const asset = stored.unwrap()
    const file = session.assetFile(asset.path)
    if (file.isErr()) return Err(file.unwrapErr().withContext(where))
    const mesh = await ctx.services.workers.run(
      stlParse,
      { path: file.unwrap() },
      { signal: new AbortController().signal, progress: () => undefined },
    )
    if (mesh.isErr()) return Err(mesh.unwrapErr().withContext(where, { path: args.path }))
    return Ok({ asset, mesh: mesh.unwrap() })
  },
  run(draft, args, ctx, prepared: Imported) {
    const where = 'design.reference.import'
    const loaded = loadPart(draft as ProjectDoc, args.partId, where)
    if (loaded.isErr()) return loaded
    const l = loaded.unwrap()
    const { asset, mesh } = prepared
    const guess = guessUnit(mesh.bounds, stockSize(l))
    const sourceUnit = args.sourceUnit ?? guess.unit
    const id = ctx.ids.next('reference')
    const zero = literal('0°', 'angle', l.units)
    const scale = literal('1', 'scalar', l.units)
    if (zero.isErr()) return zero
    if (scale.isErr()) return scale
    const base: Omit<ReferenceDTO, 'position'> = {
      id,
      partId: args.partId,
      name: args.name ?? baseName(args.path),
      asset: {
        path: asset.path,
        sha256: asset.sha256,
        format: 'stl',
        triangles: mesh.triangles,
        bounds: mesh.bounds,
      },
      sourceUnit,
      scale: scale.unwrap() as ReferenceDTO['scale'],
      rotation: {
        x: zero.unwrap(),
        y: zero.unwrap(),
        z: zero.unwrap(),
      } as ReferenceDTO['rotation'],
    }
    const p = {
      sourceUnit,
      scale: 1,
      rotation: { x: 0, y: 0, z: 0 },
      position: { x: 0, y: 0, z: 0 },
    }
    const fit = fitted(base as ReferenceDTO, p, l, args.fit ?? {}, where)
    if (fit.isErr()) return fit
    const f = fit.unwrap()
    const ref: ReferenceDTO = {
      ...base,
      ...(f.scale ? { scale: f.scale } : {}),
      position: f.position,
    }
    draft.references[id] = ref
    const warnings: ReferenceWarning[] = []
    if (args.sourceUnit === undefined)
      warnings.push({
        code: 'reference.unitGuessed',
        severity: 'info',
        message: guess.reason,
        referenceId: id,
        params: { unit: guess.unit },
      })
    if (!mesh.closed)
      warnings.push({
        code: 'reference.openMesh',
        severity: 'info',
        message: 'The STL is not a closed mesh (shown as is; it never affects the part)',
        referenceId: id,
        params: {},
      })
    if (mesh.triangles > STL_LIMITS.warnTriangles)
      warnings.push({
        code: 'reference.manyTriangles',
        severity: 'warning',
        message: `${mesh.triangles} triangles: the viewport may get slow above ${STL_LIMITS.warnTriangles}`,
        referenceId: id,
        params: { triangles: mesh.triangles, limit: STL_LIMITS.warnTriangles },
      })
    const fields = placedFields(ref, f.placement, l)
    const over = exceedsStock(id, fields.placed, stockSize(l))
    if (over !== undefined) warnings.push(over)
    return Ok({ referenceId: id, sourceUnit, guess, ...fields, warnings })
  },
})

const NINETY = Rational.int(90n)
const FULL = Rational.int(360n)

/** `deg + 90° × turns`, kept within ±360° and exact; the source is the exact value in degrees. */
function quarterTurn(dto: QuantityDTO, turns: number): AppResult<QuantityDTO> {
  return Quantity.fromDTO(dto).andThen((q) => {
    let v = q.exact.add(NINETY.mul(Rational.int(BigInt(turns))))
    while (v.compare(FULL) >= 0) v = v.sub(FULL)
    while (v.compare(FULL.neg()) <= 0) v = v.add(FULL)
    const digits = v.decimalDigits(6)
    const text = digits.isSome() ? v.toFixed(digits.unwrap()) : v.toString()
    return Quantity.create({
      kind: 'angle',
      source: `${text}°`,
      defaultUnit: 'deg',
      exact: v,
      tolerance: None,
    }).map((r) => r.toDTO())
  })
}

function invalid(path: string, rule: string, message: string, where: string): AppResult<never> {
  return fail('input.malformed', `${path}: ${message}`, {
    issues: [{ path: [path], rule, message }],
    where,
  })
}

/**
 * One command for every placement edit (the inspector's fields, 90° buttons and "Fit to stock"),
 * so agents see one tool: fields first, then `turn`, then `fit` (which writes `position`).
 */
const referenceUpdate = defineCommand({
  kind: 'document',
  name: 'design.reference.update',
  summary:
    'Change a reference (rotation: deg, x then y then z; position: min corner), then turn it by 90° steps, then fit it onto the stock (u = X, v = Y; default centre + top).',
  title: (a) =>
    a.fit !== undefined
      ? 'Fit reference to stock'
      : a.turn !== undefined
        ? 'Rotate reference'
        : 'Update reference',
  machine: false,
  args: z.object({
    ...RefArg,
    name: z.string().min(1).max(NAME_MAX).optional(),
    sourceUnit: SourceUnitSchema.optional(),
    scale: Src.optional(),
    rotation: Xyz.optional(),
    position: Xyz.optional(),
    turn: z
      .object({ axis: z.enum(['x', 'y', 'z']), turns: z.number().int().min(-1).max(2) })
      .optional(),
    fit: FitArg.optional(),
  }),
  result: z.object({ ...PlacedFields, warnings: Warnings }),
  async prepare(doc, args, ctx): Promise<AppResult<HoleSizes | undefined>> {
    const scales =
      args.scale !== undefined || args.fit?.scaleTo !== undefined || args.sourceUnit !== undefined
    return Ok(scales ? await holeSizes(doc, args, ctx, 'design.reference.update') : undefined)
  },
  run(draft, args, _ctx, before: HoleSizes | undefined) {
    const where = 'design.reference.update'
    if (args.turn?.turns === 0) return invalid('turn', 'turns', 'turns must be -1, 1 or 2', where)
    if (args.fit !== undefined && args.position !== undefined)
      return invalid('fit', 'fitWithPosition', 'give either position or fit', where)
    if (args.fit?.scaleTo !== undefined && args.scale !== undefined)
      return invalid('fit', 'fitWithScale', 'give either scale or fit.scaleTo', where)
    return edit(
      draft,
      args,
      where,
      (ref, l) => {
        const resolver = stockResolver(l)
        const parsed: AppResult<unknown>[] = []
        const q = (path: (string | number)[], kind: FieldKind, src: string) => {
          const r = quantityFromSource(src, fieldContext(kind, l.units), resolver)
            .andThen((v) =>
              kind === 'scalar' && v.exact.compare(Rational.ZERO) <= 0
                ? fail('model.invariant', 'scale must be > 0', {
                    issues: [{ path: [], rule: 'positive', message: 'must be greater than 0' }],
                  })
                : Ok(v),
            )
            .map((v) =>
              // tolerances mean nothing for a reference: keep the value only
              Quantity.create({ ...v, tolerance: None })
                .unwrapOr(v)
                .toDTO(),
            )
            .mapErr((e) => e.prefixIssues(...path))
          parsed.push(r)
          return r
        }
        const next: Record<string, unknown> = { ...ref }
        if (args.name !== undefined) next['name'] = args.name
        if (args.sourceUnit !== undefined) next['sourceUnit'] = args.sourceUnit
        if (args.scale !== undefined) {
          const s = q(['scale'], 'scalar', args.scale)
          if (s.isOk()) next['scale'] = s.unwrap()
        }
        for (const [field, kind] of [
          ['rotation', 'angle'],
          ['position', 'length'],
        ] as const) {
          const a = args[field]
          if (a === undefined) continue
          const xyz: Record<string, unknown> = { ...ref[field] }
          for (const axis of ['x', 'y', 'z'] as const) {
            const src = a[axis]
            if (src === undefined) continue
            const r = q([field, axis], kind, src)
            if (r.isOk()) xyz[axis] = r.unwrap()
          }
          next[field] = xyz
        }
        const all = collect(parsed)
        if (all.isErr()) return Err(all.unwrapErr().withContext(where))
        let out = next as ReferenceDTO
        if (args.turn !== undefined) {
          const { axis, turns } = args.turn
          const angle = quarterTurn(out.rotation[axis], turns)
          if (angle.isErr()) return Err(angle.unwrapErr().withContext(where))
          out = { ...out, rotation: { ...out.rotation, [axis]: angle.unwrap() } }
        }
        if (args.fit !== undefined) {
          const fit = args.fit
          const r = placementOf(out, where).andThen((p) => fitted(out, p, l, fit, where))
          if (r.isErr()) return r
          const f = r.unwrap()
          out = { ...out, ...(f.scale ? { scale: f.scale } : {}), position: f.position }
        }
        const { id: _id, partId: _partId, asset: _asset, ...changed } = out
        return Ok(changed)
      },
      (ref, p) => featureBelowTool(before, ref, p),
    )
  },
})

const referenceRemove = defineCommand({
  kind: 'document',
  name: 'design.reference.remove',
  summary: 'Remove a reference model.',
  title: () => 'Remove reference',
  machine: false,
  args: z.object(RefArg),
  result: z.object({}),
  run(draft, args) {
    const where = 'design.reference.remove'
    const found = findReference(draft as ProjectDoc, args.partId, args.referenceId, where)
    if (found.isErr()) return found
    delete draft.references[args.referenceId]
    return Ok({})
  },
})

const referenceList = defineQuery({
  name: 'design.reference.list',
  summary: "List a part's references with placed bounds (mm) and facing depths.",
  args: z.object({ partId: PartIdSchema }),
  result: z.object({
    references: z.array(
      ReferenceDtoSchema.extend({
        placed: BoxSchema.describe('Placed bounding box in the part frame, mm'),
        facingDepth: FacingDepthSchema,
        warnings: Warnings,
      }),
    ),
  }),
  run(doc, args) {
    const where = 'design.reference.list'
    const loaded = loadPart(doc, args.partId, where)
    if (loaded.isErr()) return loaded
    const refs = Object.values(doc.references).filter((r) => r.partId === args.partId)
    return collect(
      refs.map((ref) =>
        placementOf(ref, where).map((p) => {
          const { placed, facingDepth } = placedFields(ref, p, loaded.unwrap())
          const w = exceedsStock(ref.id, placed, stockSize(loaded.unwrap()))
          return { ...ref, placed, facingDepth, warnings: w === undefined ? [] : [w] }
        }),
      ),
    ).map((references) => ({ references }))
  },
})

// ── find (DF60 P1) ─────────────────────────────────────────────────────────────────────────

const r3 = (v: number): number => {
  const r = Math.round(v * 1000) / 1000
  return r === 0 ? 0 : r
}
const P2 = z.tuple([z.number(), z.number()])
/** At most this many loops in a section summary, and sharp corner positions per loop. */
export const FIND_LOOPS_MAX = 50
export const SHARP_SHOWN_MAX = 8

/** Point results in a setup's WCS (P2, `frame: 'setup'`): mm, rounded to 0.001. */
const WcsSchema = z.object({
  z: z.number().optional(),
  bounds: z.tuple([P2, P2]).optional(),
  center: P2.optional(),
  sharp: z.array(P2).optional(),
  holes: z.array(P2).optional(),
})
type Wcs = z.output<typeof WcsSchema>

/** Face-frame bounds at height w in the WCS (a quarter turn keeps them axis-aligned). */
function wcsBounds(
  wcs: (p: Vec3) => Vec3,
  b: readonly [readonly [number, number], readonly [number, number]],
  w: number,
): [[number, number], [number, number]] {
  const a = wcs([b[0][0], b[0][1], w])
  const c = wcs([b[1][0], b[1][1], w])
  return [
    [r3(Math.min(a[0], c[0])), r3(Math.min(a[1], c[1]))],
    [r3(Math.max(a[0], c[0])), r3(Math.max(a[1], c[1]))],
  ]
}
const wcsPoint = (wcs: (p: Vec3) => Vec3, p: readonly [number, number], w: number) => {
  const q = wcs([p[0], p[1], w])
  return [r3(q[0]), r3(q[1])] as [number, number]
}

const LevelSchema = z.object({
  depth: z.number(),
  facing: z.enum(['face', 'opposite']),
  area: z.number(),
  visibleArea: z.number(),
  bounds: z.tuple([P2, P2]),
  depthFromOpposite: z.number().optional(),
  wcs: WcsSchema.optional(),
})
const LoopSummarySchema = z.object({
  role: z.enum(['outer', 'hole']),
  area: z.number(),
  bounds: z.tuple([P2, P2]),
  elements: z.number().int(),
  circle: z.object({ center: P2, diameter: z.number() }).optional(),
  corners: z.object({
    minInsideRadius: z.number().optional(),
    sharp: z.array(P2),
    sharpCount: z.number().int(),
  }),
  maxDeviation: z.number(),
  open: z.literal(true).optional(),
  wcs: WcsSchema.optional(),
})
export type LoopSummary = z.output<typeof LoopSummarySchema>

/**
 * The compact summary of a fitted loop (RT-G), mm rounded to 0.001; with `wcs` (P2) its points
 * also in the setup's WCS, the loop at face-frame height `w`.
 */
export function loopSummary(
  l: FittedLoop,
  wcs?: { readonly at: (p: Vec3) => Vec3; readonly w: number },
): LoopSummary {
  const pt = (p: readonly [number, number]): [number, number] => [r3(p[0]), r3(p[1])]
  return {
    role: l.role,
    area: r3(l.area),
    bounds: [pt(l.bounds.min), pt(l.bounds.max)],
    elements: l.loop.elements.length,
    ...(l.circle
      ? { circle: { center: pt(l.circle.centre), diameter: r3(l.circle.diameter) } }
      : {}),
    corners: {
      ...(l.minInsideRadius === undefined ? {} : { minInsideRadius: r3(l.minInsideRadius) }),
      sharp: l.sharp.slice(0, SHARP_SHOWN_MAX).map(pt),
      sharpCount: l.sharp.length,
    },
    maxDeviation: r3(l.maxDeviation),
    ...(l.open ? { open: true as const } : {}),
    ...(wcs === undefined
      ? {}
      : {
          wcs: {
            bounds: wcsBounds(wcs.at, [l.bounds.min, l.bounds.max], wcs.w),
            ...(l.circle ? { center: wcsPoint(wcs.at, l.circle.centre, wcs.w) } : {}),
            sharp: l.sharp.slice(0, SHARP_SHOWN_MAX).map((p) => wcsPoint(wcs.at, p, wcs.w)),
          } satisfies Wcs,
        }),
  }
}

const HoleSizeSchema = z.object({
  diameter: z.number(),
  top: z.number().describe('Mouth level below the face'),
  depth: z.number(),
  bottom: z.enum(['through', 'flat', 'cone']),
  coneAngle: z.number().optional(),
  mouth: z
    .union([
      z.object({ type: z.literal('countersink'), diameter: z.number(), angle: z.number() }),
      z.object({ type: z.literal('counterbore'), diameter: z.number(), depth: z.number() }),
    ])
    .optional(),
  steps: z.array(z.object({ diameter: z.number(), depth: z.number() })).optional(),
})
const Args = z.record(z.string(), z.unknown())
const HoleGroupSchema = z.object({
  count: z.number().int(),
  holes: z.array(P2),
  size: HoleSizeSchema,
  pattern: z
    .union([
      z.object({
        kind: z.literal('grid'),
        origin: P2,
        pitch: P2,
        count: z.tuple([z.number().int(), z.number().int()]),
      }),
      z.object({
        kind: z.literal('circle'),
        center: P2,
        pitchDiameter: z.number(),
        count: z.number().int(),
        startAngle: z.number(),
      }),
    ])
    .optional(),
  suggest: z.object({
    command: z.enum(['design.hole.add', 'design.drilling.add']),
    args: Args.describe('The first hole; add partId'),
    also: z.array(Args).optional(),
    clones: z
      .object({ rows: z.array(Args) })
      .optional()
      .describe('design.clones.add rows; source: what the calls made'),
    note: z.literal('belowFace').optional(),
  }),
  note: z.literal('noTool').optional(),
  smallestTool: z.number().optional(),
  message: z.string().optional().describe('English: why the notes'),
  wcs: WcsSchema.optional(),
})
export type HoleGroupSummary = z.output<typeof HoleGroupSchema>

/**
 * A hole group as the find returns it (RT-G, mm rounded to 0.001): its size, pattern, the
 * ready-to-send suggestion and the notes (`noTool` below the smallest library drill or end mill,
 * `belowFace` on the suggestion); with `wcs` (P2) the centres also in the setup's WCS.
 * Doc: docs/modes/reference-tools.md#2-features-holes
 */
export function holeGroupSummary(
  g: HoleGroup,
  face: string,
  smallest: number | undefined,
  wcs?: (p: Vec3) => Vec3,
): HoleGroupSummary {
  const pt = (p: readonly [number, number]): [number, number] => [r3(p[0]), r3(p[1])]
  const s = g.size
  const suggest = holeSuggestion(g, face)
  const small = smallest !== undefined && s.diameter < smallest - TOOL_MATCH_TOLERANCE
  const messages = [
    ...(small
      ? [
          `Ø ${r3(s.diameter)} mm < the smallest drill or end mill in the library, ${r3(smallest)} mm`,
        ]
      : []),
    ...(suggest.note === 'belowFace'
      ? [
          `The mouth is ${r3(s.top)} mm below ${face}: set on to the surface there (a facing or pocket floor); the depths are from it`,
        ]
      : []),
  ]
  const m = s.mouth
  return {
    count: g.count,
    holes: g.holes.map(pt),
    size: {
      diameter: r3(s.diameter),
      top: r3(s.top),
      depth: r3(s.depth),
      bottom: s.bottom,
      ...(s.coneAngle === undefined ? {} : { coneAngle: r3(s.coneAngle) }),
      ...(m === undefined
        ? {}
        : {
            mouth:
              m.type === 'countersink'
                ? { type: m.type, diameter: r3(m.diameter), angle: r3(m.angle) }
                : { type: m.type, diameter: r3(m.diameter), depth: r3(m.depth) },
          }),
      ...(s.steps === undefined
        ? {}
        : { steps: s.steps.map((x) => ({ diameter: r3(x.diameter), depth: r3(x.depth) })) }),
    },
    ...(g.pattern === undefined
      ? {}
      : {
          pattern:
            g.pattern.kind === 'grid'
              ? {
                  kind: 'grid' as const,
                  origin: pt(g.pattern.origin),
                  pitch: pt(g.pattern.pitch),
                  count: [g.pattern.count[0], g.pattern.count[1]] as [number, number],
                }
              : {
                  kind: 'circle' as const,
                  center: pt(g.pattern.center),
                  pitchDiameter: r3(g.pattern.pitchDiameter),
                  count: g.pattern.count,
                  startAngle: r3(g.pattern.startAngle),
                },
        }),
    suggest: {
      command: suggest.command,
      args: { ...suggest.args },
      ...(suggest.also === undefined ? {} : { also: suggest.also.map((a) => ({ ...a })) }),
      ...(suggest.clones === undefined
        ? {}
        : { clones: { rows: suggest.clones.rows.map((r) => ({ ...r })) } }),
      ...(suggest.note === undefined ? {} : { note: suggest.note }),
    },
    ...(small ? { note: 'noTool' as const, smallestTool: r3(smallest) } : {}),
    ...(messages.length > 0 ? { message: messages.join('. ') } : {}),
    ...(wcs === undefined
      ? {}
      : {
          wcs: {
            z: r3(wcs([0, 0, -s.top])[2]),
            holes: g.holes.map((h) => wcsPoint(wcs, h, -s.top)),
          } satisfies Wcs,
        }),
  }
}

/** The loops a `loops` arg keeps. */
export function keepLoops(loops: readonly FittedLoop[], which: 'all' | 'outer' | 'holes' = 'all') {
  return loops.filter((l) => which === 'all' || (which === 'outer') === (l.role === 'outer'))
}

const referenceFind = defineAsyncQuery({
  name: 'design.reference.find',
  async: true,
  summary:
    'Read the reference from a stock face (face frame, mm): levels = flat floors seen from the face and its opposite; section = loops at a depth, fitted, with inside corner radii (shapes: design.shape.import from); holes = grouped, with hole/drilling (+ clones) args to send.',
  args: z.object({
    partId: PartIdSchema,
    referenceId: ReferenceIdSchema.optional().describe('Default: the only one'),
    face: FaceArg.optional(),
    frame: z.enum(['face', 'setup']).optional().describe('setup ({setupId}): points also in WCS'),
    kind: z.enum(['levels', 'section', 'holes']),
    sides: z.enum(['both', 'face']).optional().describe('levels; default both'),
    minArea: z.number().nonnegative().optional().describe('levels: mm², default 1'),
    limit: z.number().int().min(1).max(256).optional().describe('levels 32, holes 64'),
    maxDiameter: z.number().positive().max(500).optional().describe('holes: mm, default 50'),
    depth: Src.optional().describe('section (required): below the face, length'),
    tolerance: z.number().min(0.001).max(1).optional().describe('section: mm, default 0.01'),
    cornerAngle: z.number().min(1).max(90).optional().describe('section: deg, default 15'),
    loops: z.enum(['all', 'outer', 'holes']).optional(),
  }),
  result: z.object({
    kind: z.enum(['levels', 'section', 'holes']),
    referenceId: ReferenceIdSchema,
    face: z.string(),
    setupId: z.string().optional(),
    wcs: WcsSchema.optional(),
    opposite: z.string().optional(),
    levels: z.array(LevelSchema).optional(),
    depth: z.number().optional(),
    tolerance: z.number().optional(),
    loops: z.array(LoopSummarySchema).optional(),
    fit: z.object({ elements: z.number().int(), maxDeviation: z.number() }).optional(),
    groups: z.array(HoleGroupSchema).optional(),
    holeCount: z.number().int().optional(),
    more: z.number().int().optional(),
    note: z.string().optional(),
  }),
  async run(doc, args, ctx) {
    const where = 'design.reference.find'
    const loaded = loadPart(doc, args.partId, where)
    if (loaded.isErr()) return loaded
    const l = loaded.unwrap()
    const found = targetReference(doc, args.partId, args.referenceId, where)
    if (found.isErr()) return found
    const ref = found.unwrap()
    const face = resolveFace(doc, args.partId, args.face, ['face'], where)
    if (face.isErr()) return face
    const { direction, setup } = face.unwrap()
    if (args.frame === 'setup' && setup === undefined)
      return fail('input.malformed', "frame: 'setup' needs a setup face", {
        issues: [
          {
            path: ['frame'],
            rule: 'setupFrameNeedsSetup',
            message: "frame 'setup' needs face: { setupId }",
          },
        ],
        where,
      })
    const p = placementOf(ref, where)
    if (p.isErr()) return p
    const view = referenceView(
      ref,
      p.unwrap(),
      stockSize(l),
      direction,
      args.frame === 'setup' ? setup?.rotation : undefined,
    )
    const head = {
      referenceId: ref.id,
      face: view.face,
      ...(setup === undefined ? {} : { setupId: setup.id }),
    }
    const wcs = view.wcs
    if (args.kind === 'levels') {
      const r = await referenceLevelsOf(
        ctx,
        view,
        {
          minArea: args.minArea ?? 1,
          limit: args.limit ?? 32,
          sides: args.sides ?? 'both',
        },
        where,
      )
      if (r.isErr()) return r
      const { levels, more } = r.unwrap()
      return Ok({
        kind: 'levels' as const,
        ...head,
        opposite: view.opposite,
        levels: levels.map((x) => ({
          ...x,
          bounds: [[...x.bounds[0]], [...x.bounds[1]]],
          ...(wcs === undefined
            ? {}
            : {
                wcs: {
                  z: r3(wcs([0, 0, -x.depth])[2]),
                  bounds: wcsBounds(wcs, x.bounds, -x.depth),
                } satisfies Wcs,
              }),
        })) as z.output<typeof LevelSchema>[],
        ...(more === undefined ? {} : { more }),
      })
    }
    if (args.kind === 'holes') {
      const r = await referenceHolesOf(
        ctx,
        view,
        {
          maxDiameter: args.maxDiameter ?? HOLE_MAX_DIAMETER_MM,
          limit: args.limit ?? HOLE_LIMIT,
        },
        where,
      )
      if (r.isErr()) return r
      const { holes, more } = r.unwrap()
      const grouped = holeGroups(holes)
      const smallest = smallestHoleTool(ctx)
      const left = (more ?? 0) + (grouped.more ?? 0)
      return Ok({
        kind: 'holes' as const,
        ...head,
        holeCount: holes.length,
        groups: grouped.groups.map((g) => holeGroupSummary(g, view.face, smallest, wcs)),
        ...(left > 0 ? { more: left } : {}),
        ...(holes.length === 0 ? { note: 'No round holes along the face normal' } : {}),
      })
    }
    if (args.depth === undefined)
      return fail('input.malformed', 'depth: required for a section', {
        issues: [{ path: ['depth'], rule: 'required', message: 'required for kind section' }],
        where,
      })
    const depth = lengthArg(args.depth, l, ['depth'], where)
    if (depth.isErr()) return depth
    const fit = fitOptions(args)
    const r = await fittedSection(ctx, view, depth.unwrap(), fit, where)
    if (r.isErr()) return r
    const all = keepLoops(r.unwrap(), args.loops)
    const shown = all.slice(0, FIND_LOOPS_MAX)
    const closed = all.filter((x) => !x.open)
    return Ok({
      kind: 'section' as const,
      ...head,
      depth: r3(depth.unwrap()),
      tolerance: fit.tolerance,
      ...(wcs === undefined ? {} : { wcs: { z: r3(wcs([0, 0, -depth.unwrap()])[2]) } }),
      loops: shown.map((x) =>
        loopSummary(x, wcs === undefined ? undefined : { at: wcs, w: -depth.unwrap() }),
      ),
      fit: {
        elements: closed.reduce((s, x) => s + x.loop.elements.length, 0),
        maxDeviation: r3(closed.reduce((m, x) => Math.max(m, x.maxDeviation), 0)),
      },
      ...(all.length > shown.length ? { more: all.length - shown.length } : {}),
      ...(all.length === 0 ? { note: 'The plane misses the reference at this depth' } : {}),
      ...(all.some((x) => x.open)
        ? { note: 'Open loops (the mesh is not closed): shape import skips them' }
        : {}),
    })
  },
})

export const REFERENCE_COMMANDS: readonly AnyCommand[] = [
  referenceImport as AnyCommand,
  referenceUpdate,
  referenceRemove,
]

export const REFERENCE_QUERIES: readonly AnyQueryDef[] = [referenceList, referenceFind]
