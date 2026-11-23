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
import { defineCommand, defineQuery, type AnyCommand, type QueryDef } from '../commands/define'
import type { CommandContext } from '../commands/context'
import type { ReferenceResolver } from '../expression/evaluate'
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
  type Placement,
  type ReferenceWarning,
  type StockSize,
} from './reference'
import { ReferenceDtoSchema, type ReferenceDTO } from './reference.dto'
import { STL_LIMITS, type StlSummary } from './stl'
import { SurfaceTable } from './surfaces'

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

/** Stock surfaces only: a reference is placed on the stock, never on operation results. */
const stockResolver = (l: LoadedPart): ReferenceResolver =>
  SurfaceTable.build(l.part.operations, l.stock).resolver(0)

function placementOf(ref: ReferenceDTO, where: string): AppResult<Placement> {
  const q = (dto: QuantityDTO) => Quantity.fromDTO(dto).map((v) => v.canonical)
  const all = collect([
    q(ref.scale),
    q(ref.rotation.x),
    q(ref.rotation.y),
    q(ref.rotation.z),
    q(ref.position.x),
    q(ref.position.y),
    q(ref.position.z),
  ])
  if (all.isErr()) return Err(all.unwrapErr().withContext(where, { referenceId: ref.id }))
  const [scale, rx, ry, rz, px, py, pz] = all.unwrap() as [number, ...number[]]
  return Ok({
    sourceUnit: ref.sourceUnit,
    scale,
    rotation: { x: rx!, y: ry!, z: rz! },
    position: { x: px!, y: py!, z: pz! },
  })
}

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

/** `reference.exceedsStock` of a record (other warnings come from import only). */
function placementWarnings(ref: ReferenceDTO, l: LoadedPart, where: string) {
  return placementOf(ref, where).map((p) => {
    const w = exceedsStock(ref.id, placedBox(ref.asset.bounds, p), stockSize(l))
    return w === undefined ? [] : [w]
  })
}

/** The record as it is in the draft, edited, then checked for `exceedsStock`. */
function edit(
  draft: Draft<ProjectDoc>,
  args: { partId: string; referenceId: string },
  where: string,
  change: (ref: ReferenceDTO, l: LoadedPart) => AppResult<Partial<ReferenceDTO>>,
): AppResult<{ warnings: ReferenceWarning[] }> {
  const doc = draft as ProjectDoc
  const loaded = loadPart(doc, args.partId, where)
  if (loaded.isErr()) return loaded
  const found = findReference(doc, args.partId, args.referenceId, where)
  if (found.isErr()) return found
  const changed = change(found.unwrap(), loaded.unwrap())
  if (changed.isErr()) return changed
  const target = draft.references[args.referenceId]!
  Object.assign(target, changed.unwrap())
  return placementWarnings(target as ReferenceDTO, loaded.unwrap(), where).map((warnings) => ({
    warnings,
  }))
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
    const placed = placedBox(mesh.bounds, f.placement)
    const over = exceedsStock(id, placed, stockSize(l))
    if (over !== undefined) warnings.push(over)
    return Ok({ referenceId: id, sourceUnit, guess, warnings })
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
  result: z.object({ warnings: Warnings }),
  run(draft, args) {
    const where = 'design.reference.update'
    if (args.turn?.turns === 0) return invalid('turn', 'turns', 'turns must be -1, 1 or 2', where)
    if (args.fit !== undefined && args.position !== undefined)
      return invalid('fit', 'fitWithPosition', 'give either position or fit', where)
    if (args.fit?.scaleTo !== undefined && args.scale !== undefined)
      return invalid('fit', 'fitWithScale', 'give either scale or fit.scaleTo', where)
    return edit(draft, args, where, (ref, l) => {
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
    })
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

const BoxSchema = z.object({
  min: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  max: z.object({ x: z.number(), y: z.number(), z: z.number() }),
})

const referenceList = defineQuery({
  name: 'design.reference.list',
  summary: "List a part's references with placed bounds (mm).",
  args: z.object({ partId: PartIdSchema }),
  result: z.object({
    references: z.array(
      ReferenceDtoSchema.extend({
        placed: BoxSchema.describe('Placed bounding box in the part frame, mm'),
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
          const placed = placedBox(ref.asset.bounds, p)
          const w = exceedsStock(ref.id, placed, stockSize(loaded.unwrap()))
          return { ...ref, placed, warnings: w === undefined ? [] : [w] }
        }),
      ),
    ).map((references) => ({ references }))
  },
})

export const REFERENCE_COMMANDS: readonly AnyCommand[] = [
  referenceImport as AnyCommand,
  referenceUpdate,
  referenceRemove,
]

export const REFERENCE_QUERIES: readonly QueryDef[] = [referenceList]
