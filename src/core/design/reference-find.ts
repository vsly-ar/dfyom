/**
 * The reference queries' common steps (DF60 P1): which reference and face a call means, the
 * matrix from the STL to that face's frame, and the worker calls for levels and fitted sections.
 * Used by `design.reference.find` (reference-commands.ts) and `design.shape.import { from }`
 * (shape-commands.ts). Results are in the face frame of a stock face, depths positive into the
 * stock from the face (docs/modes/reference-tools.md#faces-and-frames).
 * Doc: docs/modes/reference-tools.md
 */
import { z } from 'zod'
import { Err, fail, Ok, type AppResult, type AsyncAppResult } from '../../shared/result'
import type { QueryContext } from '../commands/context'
import type { ReferenceResolver } from '../expression/evaluate'
import { quantityFromSource } from '../expression/quantity'
import {
  DIRECTIONS,
  faceFrame,
  localStock,
  STOCK_FACE,
  type Direction,
  type StockSize,
} from '../geometry/face'
import type { ProjectDoc, UnitSystem } from '../project/document'
import { Quantity } from '../quantity/quantity'
import type { QuantityDTO } from '../quantity/quantity.dto'
import { referenceLevels, referenceSection } from '../workers/tasks'
import type { LoadedPart } from './load'
import type { LevelOptions, MeshLevels } from './mesh-levels'
import { fieldContext } from './operation'
import { ghostMatrix, sectionMatrix, type Placement } from './reference'
import type { ReferenceDTO } from './reference.dto'
import {
  SECTION_CORNER_DEG,
  SECTION_TOLERANCE_MM,
  type FittedLoop,
  type SectionFitOptions,
} from './reference-section'
import { SurfaceTable } from './surfaces'

/** Opposite stock face of each direction. */
const OPPOSITE: Readonly<Record<Direction, Direction>> = {
  '+z': '-z',
  '-z': '+z',
  '+x': '-x',
  '-x': '+x',
  '+y': '-y',
  '-y': '+y',
}

/** Checked by `stockFace` (rule `stockFaceOnly`), so no bounds in the schema (tools/list). */
export const FaceArg = z.string().describe('Stock face, default stock.top')

/**
 * The reference a call means: `referenceId`, or the part's only one (`noReference` without any,
 * `referenceAmbiguous` with several).
 */
export function targetReference(
  doc: ProjectDoc,
  partId: string,
  referenceId: string | undefined,
  where: string,
): AppResult<ReferenceDTO> {
  const refs = Object.values(doc.references).filter((r) => r.partId === partId)
  const refuse = (rule: string, message: string) =>
    fail('input.malformed', `${partId}: ${message}`, {
      issues: [{ path: ['referenceId'], rule, message }],
      where,
    })
  if (referenceId !== undefined) {
    const ref = refs.find((r) => r.id === referenceId)
    return ref === undefined ? refuse('unknownReference', 'no such reference') : Ok(ref)
  }
  if (refs.length === 0) return refuse('noReference', 'the part has no reference model')
  if (refs.length > 1)
    return refuse(
      'referenceAmbiguous',
      `the part has ${refs.length} references; give referenceId (${refs.map((r) => r.id).join(', ')})`,
    )
  return Ok(refs[0]!)
}

/** The direction of a stock face target (default the top); other surfaces → `stockFaceOnly`. */
export function stockFace(
  face: string | undefined,
  path: string,
  where: string,
): AppResult<Direction> {
  const name = face ?? STOCK_FACE['+z']
  const d = DIRECTIONS.find((x) => STOCK_FACE[x] === name)
  if (d !== undefined) return Ok(d)
  return fail('input.malformed', `${name}: not a stock face`, {
    issues: [
      {
        path: [path],
        rule: 'stockFaceOnly',
        message: 'a reference is read from a stock face (stock.top, stock.bottom, stock.side[n])',
      },
    ],
    where,
  })
}

/** What the worker needs to read a reference from a face. */
export interface ReferenceView {
  readonly ref: ReferenceDTO
  readonly direction: Direction
  readonly face: string
  readonly opposite: string
  /** STL (source units) → the face frame (mm), the face at w = 0, the stock below. */
  readonly matrix: number[]
  /** The stock's extent along the face normal (mm). */
  readonly extent: number
}

export function referenceView(
  ref: ReferenceDTO,
  placement: Placement,
  stock: StockSize,
  direction: Direction,
): ReferenceView {
  const frame = faceFrame(direction, stock)
  return {
    ref,
    direction,
    face: STOCK_FACE[direction],
    opposite: STOCK_FACE[OPPOSITE[direction]],
    matrix: sectionMatrix(ghostMatrix(ref.asset.bounds, placement), frame),
    extent: localStock(direction, stock).thickness,
  }
}

function assetPath(
  ctx: Pick<QueryContext, 'services'>,
  ref: ReferenceDTO,
  where: string,
): AppResult<string> {
  const session = ctx.services.project
  if (session === undefined)
    return fail('internal.unexpected', 'no project session configured', { where })
  const file = session.assetFile(ref.asset.path)
  return file.isErr()
    ? Err(file.unwrapErr().withContext(where, { referenceId: ref.id }))
    : Ok(file.unwrap())
}

const NO_PROGRESS = () => undefined

/** The fitted section `depth` mm below the face (largest loops first). */
export async function fittedSection(
  ctx: Pick<QueryContext, 'services'>,
  view: ReferenceView,
  depth: number,
  fit: SectionFitOptions,
  where: string,
): AsyncAppResult<FittedLoop[]> {
  const path = assetPath(ctx, view.ref, where)
  if (path.isErr()) return path
  const r = await ctx.services.workers.run(
    referenceSection,
    {
      path: path.unwrap(),
      triangles: view.ref.asset.triangles,
      matrix: view.matrix,
      level: -depth,
      fit,
    },
    { signal: new AbortController().signal, progress: NO_PROGRESS },
  )
  if (r.isErr()) return Err(r.unwrapErr().withContext(where, { referenceId: view.ref.id }))
  return Ok([...(r.unwrap().loops ?? [])])
}

/** The depth levels seen from the face (and its opposite with `sides: 'both'`). */
export async function referenceLevelsOf(
  ctx: Pick<QueryContext, 'services'>,
  view: ReferenceView,
  options: Omit<LevelOptions, 'extent'>,
  where: string,
): AsyncAppResult<MeshLevels> {
  const path = assetPath(ctx, view.ref, where)
  if (path.isErr()) return path
  const r = await ctx.services.workers.run(
    referenceLevels,
    {
      path: path.unwrap(),
      triangles: view.ref.asset.triangles,
      matrix: view.matrix,
      options: { ...options, extent: view.extent },
    },
    { signal: new AbortController().signal, progress: NO_PROGRESS },
  )
  return r.isErr() ? Err(r.unwrapErr().withContext(where, { referenceId: view.ref.id })) : r
}

/** Stock surfaces only, as for placement: a reference is read against the stock. */
export const stockResolver = (l: LoadedPart): ReferenceResolver =>
  SurfaceTable.build(l.part.operations, l.stock).resolver(0)

/** A length source (project units, `stock.*` formulas) → mm; issues at `path`. */
export function lengthArg(
  source: string,
  l: LoadedPart,
  path: readonly string[],
  where: string,
): AppResult<number> {
  const q = quantityFromSource(source, fieldContext('length', l.units), stockResolver(l))
  return q.isErr()
    ? Err(
        q
          .unwrapErr()
          .prefixIssues(...path)
          .withContext(where),
      )
    : Ok(q.unwrap().canonical)
}

/** Fit options from the args (mm, degrees), with the doc's defaults. */
export function fitOptions(a: {
  tolerance?: number | undefined
  cornerAngle?: number | undefined
}): SectionFitOptions {
  return {
    tolerance: a.tolerance ?? SECTION_TOLERANCE_MM,
    cornerAngle: a.cornerAngle ?? SECTION_CORNER_DEG,
  }
}

/** The placement of a stored record in mm and degrees. */
export function storedPlacement(ref: ReferenceDTO, where: string): AppResult<Placement> {
  const vals: number[] = []
  for (const dto of [
    ref.scale,
    ref.rotation.x,
    ref.rotation.y,
    ref.rotation.z,
    ref.position.x,
    ref.position.y,
    ref.position.z,
  ] as QuantityDTO[]) {
    const q = Quantity.fromDTO(dto)
    if (q.isErr()) return Err(q.unwrapErr().withContext(where, { referenceId: ref.id }))
    vals.push(q.unwrap().canonical)
  }
  const [scale, rx, ry, rz, px, py, pz] = vals as [number, ...number[]]
  return Ok({
    sourceUnit: ref.sourceUnit,
    scale,
    rotation: { x: rx!, y: ry!, z: rz! },
    position: { x: px!, y: py!, z: pz! },
  })
}

/** "Section 12.5 mm" (project units). */
export function sectionName(depthMm: number, units: UnitSystem): string {
  const t = (v: number, d: number) => {
    const s = v.toFixed(d)
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
  }
  return units === 'mm' ? `Section ${t(depthMm, 3)} mm` : `Section ${t(depthMm / 25.4, 4)}"`
}
