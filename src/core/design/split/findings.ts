/**
 * DFM near a split (split parts 4a): `noOutline`, `cutsFeature` (lines through holes, chamfers;
 * side-face operations), `featureNear`, `thinJoint`, `sliver`, `noStock`, `outsideTravel`,
 * `fitsWhole`, and the dowel rules of 4b (`dowelNear`, `dowelFit`). Warnings and infos with code
 * `design.split`, never blocking. Pure; glue faces are sampled on a grid from the 2.5D model
 * (removal prisms), not from the evaluated mesh.
 * Doc: docs/modes/split-parts.md#dfm-near-a-split, docs/modes/split-parts.md#implementation-4b
 */
import type { Region2dPort } from '../../geometry/2d/port'
import { regionArea } from '../../geometry/2d/model'
import type { DfmWarning } from '../../geometry/model'
import type { Library } from '../../library/library'
import { Machine } from '../../library/machine'
import { Stock } from '../../library/stock'
import { libraryStockOptions, shortOf } from './blanks'
import type { ProjectDoc } from '../../project/document'
import type { LoadedPart } from '../load'
import type { SplitDTO } from '../part.dto'
import { toGeometryInput } from '../geometry-input'
import { operationTools } from '../tool-choice'
import { baseOf, isFrozenRecord } from '../frozen-memo'
import { EPS, regionBounds, splitNumbers } from './layout'
import { materialAt, removals } from './removals'
import { dowelFindings, dowelNumbers } from './dowels'
import { DOWEL_WALL_MIN } from '../dowel'
import { planPieces, splitFinding, type PiecesResult } from './pieces'

/** A glue face narrower than this is thin (split-parts.md § DFM; butt joints have no joint tool). */
export const THIN_JOINT_MM = 10
/** A piece below this share of the part's volume is a sliver. */
const SLIVER_SHARE = 0.05
/** Grid samples per glue face at most (keeps the check within the command budget). */
const SAMPLES_MAX = 60_000

const fmt = (mm: number) => +mm.toFixed(2)
const size3 = (a: readonly number[]) => a.map(fmt).join(' × ')
const mmOf = (q: { exact: { num: string; den: string } }) =>
  Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))

/**
 * The narrowest width of a sampled face: per solid sample the shorter of its runs along the two
 * axes (runs break at `breaksA` / `breaksB`, the other cuts), the minimum over all samples.
 * `a`, `b`: sample positions; `da`, `db`: their cell sizes.
 */
function narrowest(
  solid: (i: number, j: number) => boolean,
  a: readonly number[],
  da: readonly number[],
  b: readonly number[],
  db: readonly number[],
  breaksA: readonly number[],
  breaksB: readonly number[],
): number | undefined {
  const na = a.length
  const nb = b.length
  const grid = new Uint8Array(na * nb)
  for (let i = 0; i < na; i++) for (let j = 0; j < nb; j++) grid[i * nb + j] = solid(i, j) ? 1 : 0
  const crosses = (lo: number, hi: number, breaks: readonly number[]) =>
    breaks.some((c) => c > lo && c < hi)
  const runA = new Float64Array(na * nb)
  const runB = new Float64Array(na * nb)
  for (let j = 0; j < nb; j++) {
    let i = 0
    while (i < na) {
      if (grid[i * nb + j] === 0) {
        i++
        continue
      }
      let k = i
      let len = da[i]!
      while (k + 1 < na && grid[(k + 1) * nb + j] === 1 && !crosses(a[k]!, a[k + 1]!, breaksA)) {
        k++
        len += da[k]!
      }
      for (let m = i; m <= k; m++) runA[m * nb + j] = len
      i = k + 1
    }
  }
  for (let i = 0; i < na; i++) {
    let j = 0
    while (j < nb) {
      if (grid[i * nb + j] === 0) {
        j++
        continue
      }
      let k = j
      let len = db[j]!
      while (k + 1 < nb && grid[i * nb + k + 1] === 1 && !crosses(b[k]!, b[k + 1]!, breaksB)) {
        k++
        len += db[k]!
      }
      for (let m = j; m <= k; m++) runB[i * nb + m] = len
      j = k + 1
    }
  }
  let min: number | undefined
  for (let n = 0; n < na * nb; n++) {
    if (grid[n] === 0) continue
    const t = Math.min(runA[n]!, runB[n]!)
    if (min === undefined || t < min) min = t
  }
  return min
}

/** Uniform samples over [lo, hi] at most `count`: centres and the cell size. */
function samples(lo: number, hi: number, step: number): { at: number[]; size: number[] } {
  const n = Math.max(1, Math.ceil((hi - lo) / step - 1e-9))
  const h = (hi - lo) / n
  return {
    at: Array.from({ length: n }, (_, i) => lo + (i + 0.5) * h),
    size: Array.from({ length: n }, () => h),
  }
}

export interface MachineTravel {
  readonly name: string
  readonly travel: readonly [number, number, number]
}

/** The project's plans' machines, else the library's. */
export function machines(doc: ProjectDoc, library: Library | undefined): MachineTravel[] {
  const mm = (q: { exact: { num: string; den: string } }) =>
    Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))
  const out = new Map<string, MachineTravel>()
  for (const plan of Object.values(doc.plans)) {
    const snap = plan.snapshots.find((s) => s.id === plan.machine)
    if (snap?.values.kind !== 'machine') continue
    const t = snap.values.travel
    out.set(snap.values.name, { name: snap.values.name, travel: [mm(t.x), mm(t.y), mm(t.z)] })
  }
  if (out.size > 0 || library === undefined) return [...out.values()]
  return library.list('machine').items.flatMap((i) =>
    i.values instanceof Machine
      ? [
          {
            name: i.values.name,
            travel: [
              i.values.travel.x.canonical,
              i.values.travel.y.canonical,
              i.values.travel.z.canonical,
            ] as const,
          },
        ]
      : [],
  )
}

interface LibraryStock {
  readonly name: string
  readonly size: readonly [number, number, number]
}

function libraryStocks(library: Library | undefined): LibraryStock[] {
  if (library === undefined) return []
  return library.list('stock').items.flatMap((i) =>
    i.values instanceof Stock
      ? [
          {
            name: i.values.name,
            size: [
              i.values.length.canonical,
              i.values.width.canonical,
              i.values.thickness.canonical,
            ] as const,
          },
        ]
      : [],
  )
}

/** How far a blank is from fitting a box (0 = fits), rotation 0° or 90° about Z. */
function shortfall(blank: readonly number[], box: readonly number[]): number {
  const t = Math.max(0, blank[2]! - box[2]!)
  const a = Math.max(blank[0]! - box[0]!, blank[1]! - box[1]!, 0)
  const b = Math.max(blank[0]! - box[1]!, blank[1]! - box[0]!, 0)
  return Math.max(t, Math.min(a, b))
}

/** The split's DFM findings (the mapping's own `cutsFeature` findings come with `planPieces`). */
export function splitDfm(
  doc: ProjectDoc,
  loaded: LoadedPart,
  split: SplitDTO,
  planned: PiecesResult,
  port: Region2dPort,
  library: Library | undefined,
): DfmWarning[] {
  const g = geometricDfm(loaded, split, planned, port)
  return g === undefined
    ? []
    : [...g.findings, ...stockDfm(doc, loaded.dto.id, split, planned, g, library)]
}

/** What the library rules need from the geometric pass. */
interface GeometricDfm {
  readonly findings: readonly DfmWarning[]
  readonly fb: ReturnType<typeof regionBounds>
  readonly partHeight: number
}

/**
 * The rules from the part alone (`noOutline`, `cutsFeature`, `featureNear`, `thinJoint`, `sliver`):
 * a pure function of the part record and its snapshots, so `splitWarnings` caches it per frozen
 * record; undefined when the part has no geometry input.
 */
function geometricDfm(
  loaded: LoadedPart,
  split: SplitDTO,
  planned: PiecesResult,
  port: Region2dPort,
): GeometricDfm | undefined {
  const id = split.id
  const nums = splitNumbers(split)
  const out: DfmWarning[] = []
  const input = toGeometryInput(loaded.part, loaded.stock, port)
  if (input.isErr()) return undefined
  const geometry = input.unwrap().operations
  const { layout, pieces } = planned
  const W = loaded.stock.width.canonical
  const T = loaded.stock.thickness.canonical
  const outline = layout.footprint.outline
  if (outline === undefined)
    out.push(
      splitFinding(
        id,
        'noOutline',
        'warning',
        'The part has no through outline profile: the pieces are cut along the stock edges. Add the outline first.',
      ),
    )
  const anyCut = nums.xs.length + nums.ys.length + nums.levels.length > 0
  const dowels = dowelNumbers(split)
  // ── cutsFeature: lines through holes and chamfers; side-face operations ─────────────────
  const tools = operationTools(loaded.part.operations, loaded.snapshots ?? {})
  loaded.part.operations.forEach((op, i) => {
    const g = geometry[i]
    if (g === undefined) return
    const dir = g.direction ?? '+z'
    if (dir !== '+z' && dir !== '-z') {
      if (anyCut)
        out.push(
          splitFinding(
            id,
            'cutsFeature',
            'warning',
            `${op.name} is on a side face: pieces do not take side-face operations yet`,
            { operationId: op.id, reason: 'sideFace' },
          ),
        )
      return
    }
    if (g.kind !== 'drilling' && g.kind !== 'chamfer') return
    const r = g.diameter / 2
    const c: [number, number] =
      dir === '+z' ? [g.center[0], g.center[1]] : [g.center[0], W - g.center[1]]
    const crossed =
      nums.xs.some((x) => Math.abs(c[0] - x) < r - EPS) ||
      nums.ys.some((y) => Math.abs(c[1] - y) < r - EPS)
    if (crossed)
      out.push(
        splitFinding(
          id,
          'cutsFeature',
          'warning',
          `A split line crosses ${op.name}: it goes to the piece holding its centre, the other piece misses its part`,
          { operationId: op.id, reason: 'line' },
        ),
      )
  })
  // ── featureNear ──────────────────────────────────────────────────────────────────────────
  const rs = removals(loaded, geometry, outline)
  for (const r of rs) {
    if (r.mode === 'all' || r.bounds === undefined) continue
    const b =
      r.dir === '+z'
        ? r.bounds
        : {
            min: [r.bounds.min[0], W - r.bounds.max[1]],
            max: [r.bounds.max[0], W - r.bounds.min[1]],
          }
    const limit = 2 * (tools[r.id]?.tool.diameter ?? r.tool)
    const near: string[] = []
    const nearX: number[] = []
    const nearY: number[] = []
    const nearZ: number[] = []
    const gap = (lo: number, hi: number, c: number) => (c <= lo ? lo - c : c >= hi ? c - hi : 0)
    for (const x of nums.xs) {
      const d = gap(b.min[0], b.max[0], x)
      if (d > EPS && d < limit) {
        near.push(`x = ${fmt(x)}`)
        nearX.push(x)
      }
    }
    for (const y of nums.ys) {
      const d = gap(b.min[1], b.max[1], y)
      if (d > EPS && d < limit) {
        near.push(`y = ${fmt(y)}`)
        nearY.push(y)
      }
    }
    if (r.mode === 'in')
      for (const z of nums.levels) {
        const floor = r.dir === '+z' ? r.zlo : r.zhi
        const through = r.dir === '+z' ? r.zlo <= -T + EPS : r.zhi >= -EPS
        const d = Math.abs(floor - z)
        if (!through && d > EPS && d < limit) {
          near.push(`level ${fmt(z)}`)
          nearZ.push(z)
        }
      }
    if (near.length > 0)
      out.push(
        splitFinding(
          id,
          'featureNear',
          'warning',
          `${r.name} lies within ${fmt(limit)} mm (2 × its tool Ø) of ${near.join(', ')}: a thin wall at the joint`,
          { operationId: r.id, nearX, nearY, nearZ, limit },
        ),
      )
  }
  // ── thinJoint ────────────────────────────────────────────────────────────────────────────
  const fb = regionBounds(layout.footprint.region)
  let top = 0
  let bottom = -T
  for (const r of rs)
    if (r.mode === 'all') {
      if (r.dir === '+z') top = Math.min(top, r.zlo)
      else bottom = Math.max(bottom, r.zhi)
    }
  if (fb !== undefined) {
    const fp = layout.footprint.region
    const bands = [bottom, ...nums.levels.filter((z) => z > bottom && z < top), top]
    const zBreaks = [...new Set(rs.flatMap((r) => [r.zlo, r.zhi]))]
    const lineFace = (axis: 'x' | 'y', at: number) => {
      const [lo, hi] = axis === 'x' ? [fb.min[1], fb.max[1]] : [fb.min[0], fb.max[0]]
      const s = samples(lo, hi, Math.max(0.5, (hi - lo) / 2000))
      let min: number | undefined
      for (let k = 0; k + 1 < bands.length; k++) {
        const zb = bands[k]!
        const zt = bands[k + 1]!
        const zs = [zb, ...zBreaks.filter((z) => z > zb + EPS && z < zt - EPS), zt].sort(
          (p, q) => p - q,
        )
        const zc = zs.slice(1).map((z, i) => (z + zs[i]!) / 2)
        const dz = zs.slice(1).map((z, i) => z - zs[i]!)
        const w = narrowest(
          (i, j) =>
            axis === 'x'
              ? materialAt(fp, rs, W, at, s.at[i]!, zc[j]!)
              : materialAt(fp, rs, W, s.at[i]!, at, zc[j]!),
          s.at,
          s.size,
          zc,
          dz,
          axis === 'x' ? nums.ys : nums.xs,
          [],
        )
        if (w !== undefined && (min === undefined || w < min)) min = w
      }
      return min
    }
    // a doweled level (4b) needs room for its holes: Ø + a wall on each side
    const dowelLimit =
      dowels === undefined ? undefined : Math.max(THIN_JOINT_MM, dowels.hole + 2 * DOWEL_WALL_MIN)
    const report = (
      what: string,
      w: number | undefined,
      params: Record<string, number | string>,
      doweled = false,
    ) => {
      const limit = doweled && dowelLimit !== undefined ? dowelLimit : THIN_JOINT_MM
      if (w !== undefined && w < limit - EPS)
        out.push(
          splitFinding(
            id,
            'thinJoint',
            'warning',
            doweled && dowels !== undefined
              ? `The glue face at ${what} is about ${fmt(w)} mm wide at its narrowest (< ${fmt(limit)} mm): Ø${fmt(dowels.diameter)} dowels fit only where it is wider`
              : `The glue face at ${what} is about ${fmt(w)} mm wide at its narrowest (< ${THIN_JOINT_MM} mm): a weak butt joint`,
            { ...params, width: w, limit },
          ),
        )
    }
    for (const x of nums.xs) report(`x = ${fmt(x)}`, lineFace('x', x), { axis: 'x', at: x })
    for (const y of nums.ys) report(`y = ${fmt(y)}`, lineFace('y', y), { axis: 'y', at: y })
    const area = (fb.max[0] - fb.min[0]) * (fb.max[1] - fb.min[1])
    const step = Math.max(1, Math.sqrt(area / SAMPLES_MAX))
    const sx = samples(fb.min[0], fb.max[0], step)
    const sy = samples(fb.min[1], fb.max[1], step)
    for (const z of nums.levels) {
      if (z <= bottom + EPS || z >= top - EPS) continue
      const w = narrowest(
        (i, j) =>
          materialAt(fp, rs, W, sx.at[i]!, sy.at[j]!, z - 1e-4) &&
          materialAt(fp, rs, W, sx.at[i]!, sy.at[j]!, z + 1e-4),
        sx.at,
        sx.size,
        sy.at,
        sy.size,
        nums.xs,
        nums.ys,
      )
      report(`level ${fmt(z)}`, w, { level: z }, true)
    }
  }
  // ── dowels (4b) ──────────────────────────────────────────────────────────────────────────
  if (dowels !== undefined)
    out.push(
      ...dowelFindings(
        port,
        layout,
        split,
        rs,
        W,
        (n) => pieces.find((p) => p.n === n)?.name ?? `piece ${n}`,
        (rule, message, params) => splitFinding(id, rule, 'warning', message, params),
      ),
    )
  // ── keys (4b-2) ──────────────────────────────────────────────────────────────────────────
  out.push(...keyFindings(planned, (n) => pieces.find((p) => p.n === n)?.name ?? `piece ${n}`, id))
  // ── sliver ───────────────────────────────────────────────────────────────────────────────
  const partHeight = top - bottom
  const partVolume = regionArea(layout.footprint.region) * partHeight
  for (const p of pieces) {
    const bb = p.cell.bounds
    const zt = Math.min(p.cell.band.zt, top)
    const zb = Math.max(p.cell.band.zb, bottom)
    const narrow = Math.min(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], zt - zb)
    const share = (regionArea(p.cell.region) * (zt - zb)) / partVolume
    if (narrow < 2 * nums.margin - EPS || share < SLIVER_SHARE)
      out.push(
        splitFinding(
          id,
          'sliver',
          'warning',
          `${p.name} is a sliver: ${fmt(narrow)} mm at its narrowest, ${fmt(share * 100)} % of the part`,
          { piece: p.n, narrow, share },
        ),
      )
  }
  return { findings: out, fb, partHeight }
}

/**
 * `keyFit` (a run with no key: too short, only for a smaller tool, or no place clear of features
 * and the edge) and `thinJoint` for a key's neck under max(10 mm, 3 × the outline's tool Ø).
 */
function keyFindings(planned: PiecesResult, name: (n: number) => string, id: string): DfmWarning[] {
  const out: DfmWarning[] = []
  const tool = planned.outlineTool
  for (const k of planned.keys.issues) {
    const line = `${k.axis} = ${fmt(k.at)}`
    const pair = `${name(k.male.n)} and ${name(k.female.n)}`
    const run = `${k.axis === 'x' ? 'Y' : 'X'} ${fmt(k.run[0])}–${fmt(k.run[1])}`
    const params = {
      reason: k.reason,
      axis: k.axis,
      at: k.at,
      run: [k.run[0], k.run[1]],
      pieces: [k.male.n, k.female.n],
      tool,
    }
    out.push(
      splitFinding(
        id,
        'keyFit',
        'warning',
        k.reason === 'near'
          ? `No key on ${line} between ${pair} at ${run}: a feature or the part edge is within one tool Ø (${fmt(tool)} mm) of every place`
          : k.reason === 'tool'
            ? `The run of ${fmt(k.run[1] - k.run[0])} mm on ${line} between ${pair} holds a key only for a tool of Ø${fmt(k.maxTool!)} or less (the outline's is Ø${fmt(tool)}): no key there`
            : `The run of ${fmt(k.run[1] - k.run[0])} mm on ${line} between ${pair} is too short for a key: a butt joint there`,
        k.maxTool === undefined ? params : { ...params, maxTool: k.maxTool },
      ),
    )
  }
  const limit = Math.max(THIN_JOINT_MM, 3 * tool)
  const narrowest = new Map<string, (typeof planned.keys.keys)[number]>()
  for (const k of planned.keys.keys) {
    const key = `${k.axis}:${k.at}`
    const prev = narrowest.get(key)
    if (prev === undefined || k.size.neck < prev.size.neck) narrowest.set(key, k)
  }
  for (const k of narrowest.values())
    if (k.size.neck < limit - EPS)
      out.push(
        splitFinding(
          id,
          'thinJoint',
          'warning',
          `The key neck on ${k.axis} = ${fmt(k.at)} is ${fmt(k.size.neck)} mm (< ${fmt(limit)} mm, 3 × the Ø${fmt(tool)} outline tool): a weak key`,
          { axis: k.axis, at: k.at, width: k.size.neck, limit, what: 'keyNeck' },
        ),
      )
  return out
}

/** `noStock`, `outsideTravel`, `fitsWhole`: the library and the project's machines (cheap). */
function stockDfm(
  doc: ProjectDoc,
  sourceId: string,
  split: SplitDTO,
  planned: PiecesResult,
  g: GeometricDfm,
  library: Library | undefined,
): DfmWarning[] {
  const id = split.id
  const nums = splitNumbers(split)
  const anyCut = nums.xs.length + nums.ys.length + nums.levels.length > 0
  const { pieces } = planned
  const { fb, partHeight } = g
  const out: DfmWarning[] = []
  // ── noStock, outsideTravel, fitsWhole ────────────────────────────────────────────────────
  const stocks = libraryStocks(library)
  const ms = machines(doc, library)
  const records = new Map(
    Object.values(doc.parts)
      .filter((q) => q.derivedFrom?.partId === sourceId)
      .map((q) => [q.derivedFrom!.index, q]),
  )
  const options = libraryStockOptions(library)
  for (const p of pieces) {
    const need = p.need
    const record = records.get(p.n)
    const choice = record?.blank?.choice
    // the blank the piece is on (4c): its snapshot, else the need
    const snap = record === undefined ? undefined : doc.snapshots[record.stock]
    const blank =
      snap?.values.kind === 'stock'
        ? [mmOf(snap.values.length), mmOf(snap.values.width), mmOf(snap.values.thickness)]
        : need
    if (choice?.kind === 'library' && record?.blank?.libraryItemId !== choice.libraryItemId) {
      // the user's choice no longer holds the piece (or left the library): own block (4c)
      const chosen = options.find((o) => o.id === choice.libraryItemId)
      const short = chosen === undefined ? 0 : shortOf(need, chosen.size)
      out.push(
        splitFinding(
          id,
          'noStock',
          'warning',
          chosen === undefined
            ? `${p.name}: the chosen stock is no longer in the library; own blank`
            : `${p.name}: the chosen stock ${chosen.name} is ${fmt(short)} mm short of ${size3(need)}; own blank`,
          {
            piece: p.n,
            blank: need,
            chosen: choice.libraryItemId,
            reason: chosen === undefined ? 'missing' : 'short',
            short,
          },
        ),
      )
    } else if (
      record?.blank?.libraryItemId === undefined &&
      choice?.kind !== 'own' &&
      stocks.length > 0 &&
      !stocks.some((s) => shortfall(need, s.size) === 0)
    ) {
      const nearest = [...stocks].sort(
        (a, b) => shortfall(need, a.size) - shortfall(need, b.size),
      )[0]!
      out.push(
        splitFinding(
          id,
          'noStock',
          'info',
          `${p.name}: blank ${size3(need)} fits no library stock; nearest ${nearest.name} is ${fmt(shortfall(need, nearest.size))} mm short; own blank`,
          {
            piece: p.n,
            blank: need,
            nearest: nearest.name,
            short: shortfall(need, nearest.size),
          },
        ),
      )
    }
    if (ms.length > 0 && !ms.some((m) => shortfall(blank, m.travel) === 0))
      out.push(
        splitFinding(
          id,
          'outsideTravel',
          'warning',
          `${p.name}: blank ${size3(blank)} is larger than the travel of ${ms.map((m) => m.name).join(', ')}`,
          { piece: p.n, blank, machines: ms.map((m) => m.name) },
        ),
      )
  }
  if (fb !== undefined && anyCut) {
    const whole = [
      fb.max[0] - fb.min[0] + 2 * nums.margin,
      fb.max[1] - fb.min[1] + 2 * nums.margin,
      partHeight,
    ]
    const stock = stocks.find((s) => shortfall(whole, s.size) === 0)
    const fitsTravel = ms.length === 0 || ms.some((m) => shortfall(whole, m.travel) === 0)
    if (stock !== undefined && fitsTravel)
      out.push(
        splitFinding(
          id,
          'fitsWhole',
          'info',
          `The whole part (${size3(whole)} with margins) fits ${stock.name} and the machine: the split may be unnecessary`,
          { stock: stock.name, size: whole },
        ),
      )
  }
  return out
}

/**
 * The split findings of a loaded source part (the mapping's and the DFM's); [] without a split or
 * the 2D port. Shown by `design.split.set` and `design.warning.list`, not by every edit (cost).
 */
export function splitWarnings(
  doc: ProjectDoc,
  loaded: LoadedPart,
  services: { readonly region2d?: Region2dPort; readonly library?: Library },
): DfmWarning[] {
  const split = loaded.dto.split
  const port = services.region2d
  if (split === undefined || port === undefined) return []
  const geo = geometricOf(loaded, split, port)
  if (geo === undefined) return []
  const { planned, g } = geo
  return [
    ...planned.findings,
    ...(g === undefined
      ? []
      : [...g.findings, ...stockDfm(doc, loaded.dto.id, split, planned, g, services.library)]),
  ]
}

interface Geometric {
  readonly planned: PiecesResult
  readonly g: GeometricDfm | undefined
}

/**
 * The pieces and the geometric rules, cached per frozen part record and snapshot map (frozen-memo):
 * `design.warning.list` runs after every revision and evaluation step, and the geometric pass
 * (glue faces sampled on a grid) is the costly part (≈ 100 ms for the 8-piece enclosure); an
 * unchanged source reuses it. The library rules are cheap and run each time (the library is a
 * service, not a record). Doc: docs/modes/split-parts.md#implementation-4a
 */
const geometricCache = new WeakMap<
  object,
  { readonly snapshots: unknown; readonly port: Region2dPort; readonly value: Geometric }
>()

function geometricOf(
  loaded: LoadedPart,
  split: SplitDTO,
  port: Region2dPort,
): Geometric | undefined {
  const key = baseOf(loaded.dto)
  const hit = isFrozenRecord(key) ? geometricCache.get(key) : undefined
  if (hit !== undefined && hit.snapshots === loaded.snapshots && hit.port === port) return hit.value
  const planned = planPieces(loaded, split, port)
  if (planned.isErr()) return undefined
  const value = {
    planned: planned.unwrap(),
    g: geometricDfm(loaded, split, planned.unwrap(), port),
  }
  if (isFrozenRecord(key)) geometricCache.set(key, { snapshots: loaded.snapshots, port, value })
  return value
}
