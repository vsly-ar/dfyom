/**
 * Heatsink presets (pattern-presets.md H1, HS-B): the Straight fins parameter step as pure
 * functions. A preset fills the pattern's fields once from fin terms (fin thickness, slot width,
 * fin height, outer wall) and nothing stays linked; the heatsink read-out is derived from the
 * fields, so it is always true. Fin terms and pattern fields: the pattern's Gap is the web between
 * cells, i.e. the **fin**, and the cell's width is the **slot**.
 * H2: the pin-fin steps (square, round and staggered pins: inverted cells, margin 0), the pin
 * read-out and the channel suggestion.
 * Doc: docs/modes/pattern-presets.md#mapping-onto-the-pattern-model,
 * docs/modes/pattern-presets.md#what-a-preset-stores, docs/modes/pattern-presets.md#implementation-h1,
 * docs/modes/pattern-presets.md#implementation-h2
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
    /** H2: a round pin. */
    | { readonly kind: 'circle'; readonly diameter: number }
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

// ── H2: pin fins (pattern-presets.md § Mapping, § Implementation (H2)) ──────────────────────

/** The three pin-fin presets: square pins, round pins on a square lattice, staggered round pins. */
export type PinKind = 'square' | 'round' | 'staggered'

/** What a pin-fin step asks for, plus the face it is applied to (mm). Margin 0: open all round. */
export interface PinFinsStep {
  readonly kind: PinKind
  /** Pin size: the square's side or the circle's Ø (the cell). */
  readonly pin: number
  /** Channel: the pattern's gap (the web between the pins' boxes). */
  readonly channel: number
  /** Pin height: the pattern's depth. */
  readonly height: number
  /** The face's extents along u and v. */
  readonly across: number
  readonly along: number
  /** Material under the face: the base is what stays. */
  readonly thickness?: number | undefined
}

/** The layout a pin-fin step gives. */
export interface PinFinsLayout {
  readonly pins: number
  /** Square lattices: pins along u × along v (staggered: undefined, the rows alternate). */
  readonly grid?: readonly [number, number] | undefined
  /** Pitch along the rows and between them (pin + channel both ways). */
  readonly pitch: number
  /** The narrowest open border between the outer pins and the face edge. */
  readonly border: number
  /** The lattice node moved off the face centre to fit more pins (face frame), when it is. */
  readonly origin?: readonly [number, number] | undefined
  /** Pin height over the pin size (Q205: the island is the pin). */
  readonly ratio: number
  readonly base?: number | undefined
}

/** The lattice of each pin kind (staggered: odd rows shifted half a pitch, patterns.md). */
export const PIN_LATTICE: Readonly<Record<PinKind, 'square' | 'staggered'>> = {
  square: 'square',
  round: 'square',
  staggered: 'staggered',
}

/**
 * The pins a lattice about origin `o` leaves whole on the face (the layout's `whole` rule on a
 * rectangle: the pin's box inside the face) and the narrowest border.
 */
function pinsAt(
  s: PinFinsStep,
  o: readonly [number, number],
): { pins: number; border: number; us: Set<number>; vs: Set<number>; at: [number, number][] } {
  const a = s.pin + s.channel
  const r = s.pin / 2
  const shifted = PIN_LATTICE[s.kind] === 'staggered'
  let pins = 0
  let border = Infinity
  const us = new Set<number>()
  const vs = new Set<number>()
  const at: [number, number][] = []
  const j1 = Math.ceil(s.along / a) + 1
  const i1 = Math.ceil(s.across / a) + 1
  for (let j = -j1; j <= j1; j++) {
    const v = o[1] + j * a
    const sh = shifted && ((j % 2) + 2) % 2 === 1 ? a / 2 : 0
    for (let i = -i1; i <= i1; i++) {
      const u = o[0] + i * a + sh
      const b = Math.min(u - r, s.across - u - r, v - r, s.along - v - r)
      if (b < -EPS) continue
      pins++
      border = Math.min(border, b)
      us.add(Math.round(u * 1e6))
      vs.add(Math.round(v * 1e6))
      at.push([u, v])
    }
  }
  return { pins, border, us, vs, at }
}

/** The pin centres of a layout (face frame): the cards' previews. */
export function pinCentres(s: PinFinsStep, l: PinFinsLayout): [number, number][] {
  return pinsAt(s, l.origin ?? [s.across / 2, s.along / 2]).at
}

/**
 * The most pins the face holds with this pin and channel. The layout centres the lattice on the
 * face; when half a pitch off the centre (along u, v or both) fits more pins (an even count, as the
 * straight fins' count), the origin moves there. Undefined when a size is not positive or no pin
 * fits.
 */
export function pinFins(s: PinFinsStep): PinFinsLayout | undefined {
  if (!(s.pin > 0 && s.channel > 0 && s.height > 0 && s.across > 0 && s.along > 0)) return undefined
  const a = s.pin + s.channel
  const c: [number, number] = [s.across / 2, s.along / 2]
  // centred first: an origin moves only for more pins
  let best: { o: [number, number]; n: ReturnType<typeof pinsAt> } | undefined
  for (const [du, dv] of [
    [0, 0],
    [a / 2, 0],
    [0, a / 2],
    [a / 2, a / 2],
  ] as const) {
    const o: [number, number] = [c[0] + du, c[1] + dv]
    const n = pinsAt(s, o)
    if (best === undefined || n.pins > best.n.pins) best = { o, n }
  }
  if (best === undefined || best.n.pins === 0) return undefined
  const moved = best.o[0] !== c[0] || best.o[1] !== c[1]
  return {
    pins: best.n.pins,
    ...(PIN_LATTICE[s.kind] === 'square'
      ? { grid: [best.n.us.size, best.n.vs.size] as const }
      : {}),
    pitch: a,
    border: Math.round(best.n.border * 1e6) / 1e6,
    ...(moved ? { origin: best.o } : {}),
    ratio: ratioOf(s.height, s.pin),
    ...(s.thickness === undefined
      ? {}
      : { base: Math.round((s.thickness - s.height) * 1e6) / 1e6 }),
  }
}

/**
 * The `design.pattern.update` args of a pin-fin preset (one update, one undo step): the pin as an
 * inverted cell (square: a sharp rectangle; round, staggered: a circle), gap = channel, margin 0
 * (the channels open at every edge), whole pins, depth = pin height.
 */
export function pinFinsArgs(s: PinFinsStep, layout: PinFinsLayout): Record<string, unknown> {
  return {
    cell:
      s.kind === 'square'
        ? {
            kind: 'rectangle',
            length: mmSource(s.pin),
            width: mmSource(s.pin),
            cornerRadius: '0 mm',
            rotation: '0°',
          }
        : { kind: 'circle', diameter: mmSource(s.pin), rotation: '0°' },
    lattice: PIN_LATTICE[s.kind],
    spacing: { gap: mmSource(s.channel) },
    alternate: 'none',
    angle: '0°',
    origin: layout.origin === undefined ? null : layout.origin.map(mmSource),
    boundary: null,
    margin: '0 mm',
    fit: 'whole',
    invert: true,
    through: false,
    depth: mmSource(s.height),
  }
}

/** § DFM Pins: the step suggests a channel of Ø + 0.5 mm, so the second pass finishes. */
export const PIN_CHANNEL_EXTRA = 0.5
export const suggestedChannel = (diameter: number): number =>
  Math.round((diameter + PIN_CHANNEL_EXTRA) * 1e6) / 1e6

/**
 * How a tool cuts a pin-fin channel: as wide as the tool (contoured round each pin, so cut twice;
 * the step suggests Ø + 0.5 mm), a finishing ring round every pin, a thin one, or too wide.
 */
export type ChannelCut = 'twice' | 'finishing' | 'thinFinish' | 'tooWide'
export function channelCut(channel: number, diameter: number, allowance: number): ChannelCut {
  const c = slotCut(channel, diameter, allowance)
  return c === 'onePass' ? 'twice' : c
}

/** The pin read-out (derived): "49 pins 3 mm · 8 mm high (1:2.7) · channels 2.5 mm · base 6 mm". */
export interface PinsReadout {
  readonly kind: PinKind
  readonly pins: number
  readonly pin: number
  readonly channel: number
  readonly height: number
  readonly ratio: number
  readonly base?: number | undefined
}

/**
 * A pattern that is pin fins (inverted, not through; a sharp square cell turned by a multiple of
 * 90° on a square lattice, or a circle on a square or staggered one; a gap, no flip, lattice angle
 * 0) reads as pin fins; else undefined (the cell read-out).
 */
export function pinsReadout(f: FinsFields): PinsReadout | undefined {
  const c = f.cell
  if (!f.invert || f.through || f.alternate !== 'none' || f.gap === undefined) return undefined
  if (quarter(f.angle) !== 0 || f.cells < 1) return undefined
  let kind: PinKind
  let pin: number
  if (c.kind === 'circle') {
    if (f.lattice !== 'square' && f.lattice !== 'staggered') return undefined
    kind = f.lattice === 'square' ? 'round' : 'staggered'
    pin = c.diameter
  } else if (c.kind === 'rectangle') {
    if (f.lattice !== 'square' || c.cornerRadius > EPS || quarter(c.rotation) === undefined)
      return undefined
    if (Math.abs(c.length - c.width) > EPS) return undefined
    kind = 'square'
    pin = c.length
  } else return undefined
  return {
    kind,
    pins: f.cells,
    pin,
    channel: f.gap,
    height: f.depth,
    ratio: ratioOf(f.depth, pin),
    ...(f.thickness === undefined ? {} : { base: Math.round((f.thickness - f.depth) * 1e6) / 1e6 }),
  }
}
