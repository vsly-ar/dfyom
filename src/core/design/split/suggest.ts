/**
 * Split parts 4c: "Split to fit". `design.split.suggest` returns the fewest levels, then the
 * fewest lines, that make every piece (plus margins) fit a library stock (turned 0° or 90°) and the
 * machine travel; the stoutest grid among equals. A query: the user or agent applies the result
 * with `design.split.set`. Doc: docs/modes/split-parts.md#implementation-4c
 */
import { z } from 'zod'
import { Err, fail, Ok, type AppResult } from '../../../shared/result'
import { defineQuery, type AnyQueryDef } from '../../commands/define'
import type { Region2dPort } from '../../geometry/2d/port'
import { ItemIdSchema } from '../../library/item'
import type { Library } from '../../library/library'
import { Machine } from '../../library/machine'
import { Stock } from '../../library/stock'
import type { ProjectDoc } from '../../project/document'
import { PartArg } from '../commands'
import type { Issue } from '../../../shared/errors/app-error'
import { toGeometryInput } from '../geometry-input'
import { loadPart, type LoadedPart } from '../load'
import type { SplitDTO } from '../part.dto'
import { requirePort } from '../shape'
import { holds, type Size3 } from './blanks'
import { derivedPartError } from './derived'
import { machines as projectMachines, type MachineTravel } from './findings'
import { EPS, regionBounds, splitLayout, type SplitNumbers } from './layout'
import { lengthDTO, planPieces } from './pieces'
import { isKeyKind } from './keys'

const malformed = (issues: Issue[], where: string): AppResult<never> =>
  fail('input.malformed', issues.map((i) => i.message).join('; '), { issues, where })

/** At most this many lines per axis and levels (as `design.split.set`). */
const MAX_CUTS = 20

/** What every piece's need must fit: a stock, a machine's travel (one of several), or both. */
export interface FitBox {
  readonly stock?: { readonly name: string; readonly size: Size3 }
  readonly machines: readonly MachineTravel[]
}

export interface Suggestion {
  /** Part frame, mm. */
  readonly xs: readonly number[]
  readonly ys: readonly number[]
  readonly levels: readonly number[]
  readonly pieces: number
  /** The largest need of a piece (length, width, thickness, mm). */
  readonly need: Size3
}

const fitsBox = (need: Size3, box: FitBox) =>
  (box.stock === undefined || holds(need, box.stock.size) !== undefined) &&
  (box.machines.length === 0 || box.machines.some((m) => holds(need, m.travel) !== undefined))

/** `n` − 1 cuts evenly over [lo, hi], rounded to `step` mm (0 = 1 µm). */
const evenly = (lo: number, hi: number, n: number, step: number) =>
  Array.from({ length: n - 1 }, (_, k) => {
    const v = lo + ((hi - lo) * (k + 1)) / n
    return step > 0 ? Math.round(v / step) * step : Math.round(v * 1e6) / 1e6
  })

/** Steps tried for rounding positions: whole mm, 0.01 mm, then exact. */
const STEPS = [1, 0.01, 0] as const

/**
 * The suggestion for a loaded source part (its split's margin and joint kept), or why none:
 * `noFit` when nothing within 20 lines per axis and 20 levels fits.
 */
export function suggestSplit(
  loaded: LoadedPart,
  port: Region2dPort,
  box: FitBox,
  where: string,
): AppResult<Suggestion> {
  const input = toGeometryInput(loaded.part, loaded.stock, port)
  if (input.isErr()) return Err(input.unwrapErr().withContext(where))
  const geometry = input.unwrap().operations
  const ops = loaded.part.operations
  const units = loaded.units
  const stock = {
    length: loaded.stock.length.canonical,
    width: loaded.stock.width.canonical,
    thickness: loaded.stock.thickness.canonical,
  }
  const prev = loaded.dto.split
  const mm = (q: { exact: { num: string; den: string } }) =>
    Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))
  const margin = prev === undefined ? (units === 'inch' ? 5.08 : 5) : mm(prev.margin)
  const keyed = prev !== undefined && isKeyKind(prev.joint.kind)
  const noFit = () =>
    malformed(
      [
        {
          path: ['stockLibraryItemId'],
          rule: 'noFit',
          message: `no split of up to ${MAX_CUTS} lines per axis and ${MAX_CUTS} levels fits every piece`,
        },
      ],
      where,
    )
  // levels: the fewest bands no thicker than the box, evenly over the stock
  const zMax = Math.min(
    box.stock?.size[2] ?? Infinity,
    box.machines.length === 0 ? Infinity : Math.max(...box.machines.map((m) => m.travel[2])),
  )
  const T = stock.thickness
  const bands = Math.ceil(T / zMax - 1e-9)
  if (!(bands >= 1) || bands > MAX_CUTS + 1) return noFit()
  let levels: number[] = []
  for (const step of STEPS) {
    levels = evenly(-T, 0, bands, step)
    const zs = [-T, ...levels, 0]
    if (zs.every((z, i) => i === 0 || z - zs[i - 1]! <= zMax + EPS)) break
  }
  const base = splitLayout(
    port,
    { id: 'split1', xs: [], ys: [], levels: [], margin },
    stock,
    ops,
    geometry,
  )
  if (base.isErr()) return Err(base.unwrapErr().withContext(where))
  const fb = regionBounds(base.unwrap().footprint.region) ?? {
    min: [0, 0],
    max: [stock.length, stock.width],
  }
  // a grid: every cell's need fits (keys: the pieces' blanks, with their knobs)
  const check = (
    xs: readonly number[],
    ys: readonly number[],
  ): { pieces: number; stout: number; need: Size3 } | undefined => {
    const numbers: SplitNumbers = { id: 'split1', xs, ys, levels, margin }
    const layout = splitLayout(port, numbers, stock, ops, geometry)
    if (layout.isErr()) return undefined
    const cells = layout.unwrap().cells
    if (cells.length === 0) return undefined
    let stout = Infinity
    let need: Size3 = [0, 0, 0]
    for (const c of cells) {
      const w = c.bounds.max[0] - c.bounds.min[0]
      const h = c.bounds.max[1] - c.bounds.min[1]
      const n: Size3 = [w + 2 * margin, h + 2 * margin, c.band.zt - c.band.zb]
      if (!fitsBox(n, box)) return undefined
      stout = Math.min(stout, w, h)
      if (n[0] * n[1] * n[2] > need[0] * need[1] * need[2]) need = n
    }
    if (keyed) {
      const L = (v: number) => lengthDTO(v, units)
      const split: SplitDTO = {
        ...prev,
        lines: [
          ...xs.map((at) => ({ axis: 'x' as const, at: L(at) })),
          ...ys.map((at) => ({ axis: 'y' as const, at: L(at) })),
        ],
        levels: levels.map(L),
        joint: {
          kind: prev.joint.kind,
          ...(prev.joint.clearance ? { clearance: prev.joint.clearance } : {}),
        },
      }
      const planned = planPieces(loaded, split, port)
      if (planned.isErr()) return undefined
      for (const p of planned.unwrap().pieces)
        if (!fitsBox([p.blank.length, p.blank.width, p.blank.thickness], box)) return undefined
    }
    return { pieces: cells.length, stout, need }
  }
  for (let k = 0; k <= 2 * MAX_CUTS; k++) {
    let best: (Suggestion & { stout: number }) | undefined
    for (let nx = 1; nx <= k + 1; nx++) {
      const ny = k + 2 - nx
      if (nx - 1 > MAX_CUTS || ny - 1 > MAX_CUTS) continue
      for (const step of STEPS) {
        const xs = evenly(fb.min[0], fb.max[0], nx, step)
        const ys = evenly(fb.min[1], fb.max[1], ny, step)
        const inside =
          xs.every((x) => x > EPS && x < stock.length - EPS) &&
          ys.every((y) => y > EPS && y < stock.width - EPS)
        const r = inside ? check(xs, ys) : undefined
        if (r === undefined) continue
        if (
          best === undefined ||
          r.stout > best.stout + EPS ||
          (Math.abs(r.stout - best.stout) <= EPS && r.pieces < best.pieces)
        )
          best = { xs, ys, levels, pieces: r.pieces, need: r.need, stout: r.stout }
        break
      }
    }
    if (best !== undefined) {
      const { stout: _, ...out } = best
      return Ok(out)
    }
  }
  return noFit()
}

/** The box from the args: the library stock, the machine (given, else the project's or library's). */
function fitBox(
  doc: ProjectDoc,
  library: Library | undefined,
  args: { stockLibraryItemId?: string | undefined; machineLibraryItemId?: string | undefined },
  where: string,
): AppResult<FitBox> {
  const unknown = (path: string, what: string) =>
    malformed([{ path: [path], rule: 'unknownItem', message: `no such library ${what}` }], where)
  let stock: FitBox['stock']
  if (args.stockLibraryItemId !== undefined) {
    const found = library?.lookup('stock', args.stockLibraryItemId)
    if (found?.state !== 'found' || !(found.item.values instanceof Stock))
      return unknown('stockLibraryItemId', 'stock')
    const v = found.item.values
    stock = {
      name: v.name,
      size: [v.length.canonical, v.width.canonical, v.thickness.canonical],
    }
  }
  let ms: MachineTravel[]
  if (args.machineLibraryItemId !== undefined) {
    const found = library?.lookup('machine', args.machineLibraryItemId)
    if (found?.state !== 'found' || !(found.item.values instanceof Machine))
      return unknown('machineLibraryItemId', 'machine')
    const t = found.item.values.travel
    ms = [
      {
        name: found.item.values.name,
        travel: [t.x.canonical, t.y.canonical, t.z.canonical],
      },
    ]
  } else ms = projectMachines(doc, library)
  if (stock === undefined && ms.length === 0)
    return malformed(
      [
        {
          path: ['stockLibraryItemId'],
          rule: 'nothingToFit',
          message: 'give a library stock or have a machine in the library',
        },
      ],
      where,
    )
  return Ok({ ...(stock === undefined ? {} : { stock }), machines: ms })
}

const suggest = defineQuery({
  name: 'design.split.suggest',
  summary:
    'Fewest levels, then lines, so every piece fits a library stock and the machine travel; for design.split.set.',
  args: z.object({
    ...PartArg,
    stockLibraryItemId: ItemIdSchema.optional(),
    machineLibraryItemId: ItemIdSchema.optional().describe("Default: the plans' or library's"),
  }),
  result: z.object({
    lines: z.array(z.object({ axis: z.enum(['x', 'y']), at: z.string() })),
    levels: z.array(z.string()),
    pieces: z.number(),
    need: z
      .array(z.number())
      .describe("The largest piece's blank need: length, width, thickness (mm)"),
  }),
  run(doc, args, ctx) {
    const where = 'design.split.suggest'
    const loaded = loadPart(doc, args.partId, where)
    if (loaded.isErr()) return loaded
    const l = loaded.unwrap()
    if (l.dto.derivedFrom !== undefined) return derivedPartError(doc, l.dto, where)
    const port = requirePort(ctx.services.region2d, where)
    if (port.isErr()) return port
    const box = fitBox(doc, ctx.services.library, args, where)
    if (box.isErr()) return box
    const s = suggestSplit(l, port.unwrap(), box.unwrap(), where)
    if (s.isErr()) return s
    const src = (v: number) => lengthDTO(v, l.units).source
    const r = s.unwrap()
    if (!Number.isFinite(r.need[0]))
      return fail('internal.unexpected', 'no piece in the suggestion', { where })
    return Ok({
      lines: [
        ...r.xs.map((at) => ({ axis: 'x' as const, at: src(at) })),
        ...r.ys.map((at) => ({ axis: 'y' as const, at: src(at) })),
      ],
      levels: r.levels.map(src),
      pieces: r.pieces,
      need: r.need.map((v) => Math.round(v * 1000) / 1000),
    })
  },
})

export const SPLIT_QUERIES: readonly AnyQueryDef[] = [suggest]
