/**
 * Heatsink presets (pattern-presets.md H1, HS-B): the Straight fins parameter step as pure
 * functions. A preset fills the pattern's fields once from fin terms (fin thickness, slot width,
 * fin height, outer wall) and nothing stays linked; the heatsink read-out is derived from the
 * fields, so it is always true. Fin terms and pattern fields: the pattern's Gap is the web between
 * cells, i.e. the **fin**, and the cell's width is the **slot**.
 * Doc: docs/modes/pattern-presets.md#mapping-onto-the-pattern-model,
 * docs/modes/pattern-presets.md#what-a-preset-stores, docs/modes/pattern-presets.md#implementation-h1
 *
 * Numbers are mm; args are metric sources (the core parses units). Headless.
 */
import { SLOT_FIT_TOLERANCE } from '../../geometry/slots'

/** What the Straight fins step asks for, plus the face it is applied to (mm). */
export interface StraightFinsStep {
  /** Fin thickness: the pattern's gap. */
  readonly fin: number
  /** Slot width: the cell's width. */
  readonly slot: number
  /** Fin height: the pattern's depth. */
  readonly height: number
  /** The least outer wall at the two sides across the fins (margin u). */
  readonly wall: number
  /** The face's extent across the fins (u) and along them (v): the slots run along v. */
  readonly across: number
  readonly along: number
  /** Material under the face (the stock thickness on the top): the base is what stays. */
  readonly thickness?: number | undefined
}

/** The layout the step's fields give. */
export interface StraightFinsLayout {
  readonly slots: number
  /** Inner fins plus the two outer walls (slots + 1). */
  readonly fins: number
  /** The outer wall each side as laid out (≥ the step's wall; the slots are centred). */
  readonly wall: number
  /** Slot + fin. */
  readonly pitch: number
  /** Set when the count is even: the lattice node half a pitch off the centre (face frame). */
  readonly origin?: readonly [number, number] | undefined
  /** Fin height over the thinnest fin or wall (the "1:6.7" of the read-out). */
  readonly ratio: number
  /** Material left under the slots; undefined when the thickness is not known. */
  readonly base?: number | undefined
}

const EPS = 1e-9
/** mm without float noise, as a source. */
export const mmSource = (x: number): string => `${Math.round(x * 1e6) / 1e6} mm`
const ratioOf = (height: number, web: number) => Math.round((height / web) * 10) / 10

/**
 * The most slots n with n·slot + (n − 1)·fin ≤ across − 2·wall, centred (an even count moves the
 * origin half a pitch so the slots stay centred). Undefined when a size is not positive or no
 * slot fits.
 */
export function straightFins(s: StraightFinsStep): StraightFinsLayout | undefined {
  if (!(s.fin > 0 && s.slot > 0 && s.height > 0 && s.wall >= 0 && s.across > 0 && s.along > 0))
    return undefined
  const pitch = s.slot + s.fin
  const n = Math.floor((s.across - 2 * s.wall + s.fin) / pitch + EPS)
  if (n < 1) return undefined
  const wall = (s.across - n * s.slot - (n - 1) * s.fin) / 2
  const thinnest = n > 1 ? Math.min(s.fin, wall) : wall
  return {
    slots: n,
    fins: n + 1,
    wall: Math.round(wall * 1e6) / 1e6,
    pitch,
    ...(n % 2 === 0 ? { origin: [s.across / 2 + pitch / 2, s.along / 2] as const } : {}),
    ratio: thinnest > EPS ? ratioOf(s.height, thinnest) : Infinity,
    ...(s.thickness === undefined
      ? {}
      : { base: Math.round((s.thickness - s.height) * 1e6) / 1e6 }),
  }
}

/**
 * The `design.pattern.update` args of the Straight fins preset (one update, one undo step): a
 * slot cell (rectangle `along` × slot, R 0, turned 90° so it runs along v) on a square lattice
 * of one row, gap = fin, margin `[wall, 0]` (the slots run out of both ends), whole cells over the
 * face, depth = fin height.
 */
export function straightFinsArgs(
  s: StraightFinsStep,
  layout: StraightFinsLayout,
): Record<string, unknown> {
  return {
    cell: {
      kind: 'rectangle',
      length: mmSource(s.along),
      width: mmSource(s.slot),
      cornerRadius: '0 mm',
      rotation: '90°',
    },
    lattice: 'square',
    spacing: { gap: mmSource(s.fin) },
    alternate: 'none',
    angle: '0°',
    origin: layout.origin === undefined ? null : layout.origin.map(mmSource),
    boundary: null,
    margin: [mmSource(s.wall), '0 mm'],
    fit: 'whole',
    invert: false,
    through: false,
    depth: mmSource(s.height),
  }
}

/** How a tool cuts a slot (Q206): one pass per level, a finishing pass, or a thin one. */
export type SlotCut = 'onePass' | 'finishing' | 'thinFinish' | 'tooWide'

/**
 * Slot = tool Ø (within the pocket's tool-fit tolerance on each side, the slot rule): one pass per
 * level; slot ≥ Ø + 2 × allowance: a finishing pass on both walls; between: the finishing pass is
 * thinner than the allowance; a tool wider than the slot does not fit.
 */
export function slotCut(slot: number, diameter: number, allowance: number): SlotCut {
  if (Math.abs(slot - diameter) <= 2 * SLOT_FIT_TOLERANCE + EPS) return 'onePass'
  if (diameter > slot) return 'tooWide'
  return slot >= diameter + 2 * allowance - EPS ? 'finishing' : 'thinFinish'
}

/** The pattern's fields as the heatsink read-out reads them (mm, degrees). */
export interface FinsFields {
  readonly cell:
    | {
        readonly kind: 'rectangle'
        readonly length: number
        readonly width: number
        readonly cornerRadius: number
        readonly rotation: number
      }
    | { readonly kind: 'other' }
  readonly lattice: string
  readonly alternate: 'none' | 'flip'
  readonly invert: boolean
  readonly through: boolean
  /** The gap; undefined with an explicit pitch. */
  readonly gap?: number | undefined
  readonly angle: number
  readonly depth: number
  /** Laid-out cells. */
  readonly cells: number
  /** The area's box (the boundary less the margin) and the margin `[u, v]`. */
  readonly area: {
    readonly min: readonly [number, number]
    readonly max: readonly [number, number]
  }
  readonly margin: readonly [number, number]
  /** Material under the face; undefined: no base in the read-out. */
  readonly thickness?: number | undefined
}

/** The heatsink read-out (derived): "11 slots · 12 fins 1.5 mm · 10 mm high (1:6.7) · base 4 mm". */
export interface FinsReadout {
  readonly slots: number
  readonly fins: number
  readonly fin: number
  readonly height: number
  readonly ratio: number
  readonly base?: number | undefined
}

const quarter = (deg: number): number | undefined => {
  const r = ((deg % 180) + 180) % 180
  return Math.abs(r) < EPS || Math.abs(r - 180) < EPS ? 0 : Math.abs(r - 90) < EPS ? 90 : undefined
}

/**
 * A pattern that is straight fins (slot cells in one row: a sharp rectangle at least twice as
 * long as wide, turned by a multiple of 90°, square lattice, gap, not inverted or through, so
 * long that a second row cannot fit) reads as a heatsink; else undefined (the cell read-out).
 */
export function straightFinsReadout(f: FinsFields): FinsReadout | undefined {
  const c = f.cell
  if (c.kind !== 'rectangle' || c.cornerRadius > EPS) return undefined
  if (f.lattice !== 'square' || f.alternate !== 'none' || f.invert || f.through) return undefined
  if (f.gap === undefined || quarter(f.angle) !== 0 || f.cells < 1) return undefined
  const turn = quarter(c.rotation)
  if (turn === undefined) return undefined
  // the slot runs along the cell's longer side
  const [ex, ey] = turn === 0 ? [c.length, c.width] : [c.width, c.length]
  const alongV = ey >= ex
  const [slot, long] = alongV ? [ex, ey] : [ey, ex]
  if (long < 2 * slot) return undefined
  const areaLong = alongV ? f.area.max[1] - f.area.min[1] : f.area.max[0] - f.area.min[0]
  if (2 * long + f.gap <= areaLong + EPS) return undefined
  // the face across the fins: the area plus its margin each side
  const across = alongV
    ? f.area.max[0] - f.area.min[0] + 2 * f.margin[0]
    : f.area.max[1] - f.area.min[1] + 2 * f.margin[1]
  const span = f.cells * slot + (f.cells - 1) * f.gap
  const wall = (across - span) / 2
  const walls = wall > 1e-3
  const thinnest = f.cells > 1 ? (walls ? Math.min(f.gap, wall) : f.gap) : wall
  return {
    slots: f.cells,
    fins: walls ? f.cells + 1 : f.cells - 1,
    fin: f.gap,
    height: f.depth,
    ratio: thinnest > EPS ? ratioOf(f.depth, thinnest) : Infinity,
    ...(f.thickness === undefined ? {} : { base: Math.round((f.thickness - f.depth) * 1e6) / 1e6 }),
  }
}
