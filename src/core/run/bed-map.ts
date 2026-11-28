/**
 * The bed map (v0.5 RV11, Q228): a surface map of the bed taken in machine coordinates and kept
 * per library machine. Here: when it may be used (stale, old), the floor it gives every probe (or
 * the spoilboard estimate without it), the floor as the probe runner's function, and the map moved
 * into a run's work frame for "Compensate with the bed map". Pure and headless.
 * Doc: docs/modes/run-surface.md#the-bed-map-rv11
 */
import { filledHeights, mapHeight, type HeightMap } from '../post/height-map'
import type { Vec3 } from '../toolpath/model'
import type { HeightBump } from './grbl/emulator/probe-scene'
import { seededBumps } from './grbl/emulator/probe-scene'
import type { ProbeFloor } from './probe-cycle'

/** "Bed map age" (Settings › Run): older maps warn (days). */
export const BED_MAP_AGE = { min: 1, max: 365, default: 30 } as const

type Bounds = { readonly min: Vec3; readonly max: Vec3 }

/** What a bed map was taken after (docs/modes/run-surface.md#stale-and-old). */
export interface BedMapStamp {
  /** The controller's homing then: travel (mm per axis), pull-off (mm), homing mask. */
  readonly homing: {
    readonly travel: readonly [number, number, number]
    readonly pullOff: number
    readonly homingMask: number
  }
  /** The work area bound (MPos, margin in) then; null: none marked. */
  readonly workArea: Bounds | null
  /** The date of the machine's homing repeatability result then; null: none. */
  readonly repeatability: string | null
}

/** A saved bed map, as app settings `bedMaps` keep it (machine X/Y, contacts' machine Z). */
export interface BedMapLike extends BedMapStamp {
  readonly date: string
  readonly origin: readonly [number, number]
  readonly spacing: readonly [number, number]
  readonly cols: number
  readonly rows: number
  readonly z: readonly (number | null)[]
  /** mm below the spindle nose of what touched the bed; absent: not given. */
  readonly stickout?: number
}

/** The connection now, as far as the bed map's validity goes. */
export interface BedMapContext {
  readonly homed: boolean
  /** The controller's envelope (its `$$`): travel, pull-off, homing mask, the work area bound. */
  readonly envelope?: {
    readonly travel: readonly [number, number, number]
    readonly pullOff: number
    readonly homingMask: number
    readonly workArea?: Bounds
  }
  /** The machine's last homing repeatability result. */
  readonly repeatability?: { readonly date: string; readonly pass: boolean }
  /** ms since the epoch. */
  readonly now: number
  /** Days after which a map is old (`bedMapMaxAge`). */
  readonly maxAgeDays: number
}

/** Why a bed map is not used: no homing, not every point measured, or stale. */
export type BedMapUnusable = 'notHomed' | 'incomplete' | 'homing' | 'workArea' | 'repeatability'

export interface BedMapState {
  /** undefined: usable (floor and compensation). */
  readonly unusable?: BedMapUnusable
  /** Older than the age setting: a warning, still used. */
  readonly old: boolean
  /** Whole days since it was taken. */
  readonly ageDays: number
}

const DAY_MS = 86_400_000
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol
const sameBounds = (a: Bounds | null | undefined, b: Bounds | null | undefined) =>
  (a ?? null) === null || (b ?? null) === null
    ? (a ?? null) === (b ?? null)
    : [0, 1, 2].every((i) => near(a!.min[i]!, b!.min[i]!) && near(a!.max[i]!, b!.max[i]!))

/** The stamp of a map taken now (`envelope` from the live status). */
export function bedMapStamp(ctx: Pick<BedMapContext, 'envelope' | 'repeatability'>): BedMapStamp {
  const e = ctx.envelope
  return {
    homing: {
      travel: e === undefined ? [0, 0, 0] : [e.travel[0], e.travel[1], e.travel[2]],
      pullOff: e?.pullOff ?? 0,
      homingMask: e?.homingMask ?? 0,
    },
    workArea:
      e?.workArea === undefined
        ? null
        : { min: [...e.workArea.min] as Vec3, max: [...e.workArea.max] as Vec3 },
    repeatability: ctx.repeatability?.date ?? null,
  }
}

/**
 * Whether `map` may be used now (docs/modes/run-surface.md#stale-and-old): homed, complete, and
 * not stale (the homing, the work area, a failed repeatability test since); old after the age.
 */
export function bedMapState(map: BedMapLike, ctx: BedMapContext): BedMapState {
  const ageDays = Math.max(0, Math.floor((ctx.now - Date.parse(map.date)) / DAY_MS))
  const old = Number.isFinite(ageDays) && ageDays > ctx.maxAgeDays
  const out = (unusable?: BedMapUnusable): BedMapState => ({
    ...(unusable === undefined ? {} : { unusable }),
    old,
    ageDays,
  })
  if (map.z.some((v) => v === null) || map.z.length !== map.cols * map.rows)
    return out('incomplete')
  if (!ctx.homed || ctx.envelope === undefined) return out('notHomed')
  const e = ctx.envelope
  const h = map.homing
  if (
    !h.travel.every((t, i) => near(t, e.travel[i]!)) ||
    !near(h.pullOff, e.pullOff) ||
    h.homingMask !== e.homingMask
  )
    return out('homing')
  if (!sameBounds(map.workArea, e.workArea)) return out('workArea')
  const r = ctx.repeatability
  if (r !== undefined && !r.pass && r.date !== map.repeatability && r.date > map.date)
    return out('repeatability')
  return out()
}

/** The floor the host applies (MPos): the bed map's heights already for the tool, or a plane. */
export interface FloorSetting {
  readonly map?: {
    readonly origin: readonly [number, number]
    readonly spacing: readonly [number, number]
    readonly cols: number
    readonly rows: number
    readonly z: readonly number[]
  }
  /** The spoilboard top estimate (MPos Z), used where there is no map. */
  readonly plane?: number
}

/**
 * The spoilboard top in machine Z for a tool of `stickout` (docs/modes/run-surface.md#uses): the
 * nose is `noseToTable` above the table at Z home (MPos −pull-off), as the Z headroom estimate has it.
 */
export function spoilboardFloorZ(
  noseToTable: number,
  spoilboard: number,
  pullOff: number,
  stickout: number,
): number {
  return stickout + spoilboard - noseToTable - pullOff
}

/**
 * The floor to send (`run.machine.floor`): the usable bed map raised by the stickout difference
 * when both are known, and the spoilboard plane when given; undefined: none.
 */
export function floorSetting(
  map: BedMapLike | undefined,
  opts: { readonly stickout?: number; readonly plane?: number },
): FloorSetting | undefined {
  const dz =
    map?.stickout !== undefined && opts.stickout !== undefined ? opts.stickout - map.stickout : 0
  const grid =
    map === undefined || map.z.some((v) => v === null)
      ? undefined
      : {
          origin: [map.origin[0], map.origin[1]] as const,
          spacing: [map.spacing[0], map.spacing[1]] as const,
          cols: map.cols,
          rows: map.rows,
          z: map.z.map((v) => v! + dz),
        }
  if (grid === undefined && opts.plane === undefined) return undefined
  return {
    ...(grid === undefined ? {} : { map: grid }),
    ...(opts.plane === undefined ? {} : { plane: opts.plane }),
  }
}

/**
 * The runner's floor function: the map's bilinear height (X/Y clamped to the grid), else the
 * plane; `withMap: false` (a bed map being taken) leaves the map out.
 */
export function floorFunction(
  setting: FloorSetting | undefined,
  withMap = true,
): ProbeFloor | undefined {
  if (setting === undefined) return undefined
  const g = withMap ? setting.map : undefined
  if (g === undefined) {
    const plane = setting.plane
    return plane === undefined ? undefined : () => plane
  }
  const map: HeightMap = {
    origin: g.origin,
    spacing: g.spacing,
    cols: g.cols,
    rows: g.rows,
    z: g.z,
  }
  const h = mapHeight(map, g.z)
  const maxX = g.origin[0] + (g.cols - 1) * g.spacing[0]
  const maxY = g.origin[1] + (g.rows - 1) * g.spacing[1]
  return (x, y) =>
    h(Math.min(maxX, Math.max(g.origin[0], x)), Math.min(maxY, Math.max(g.origin[1], y)))
}

/**
 * The bed map in the work frame of `workZero` (G54 X/Y, MPos), for `run.job.check`/`start`'s
 * `surfaceMap` (followed like a stock map; heights stay relative, so machine Z is fine).
 */
export function bedFollowMap(
  map: BedMapLike,
  workZero: readonly [number, number],
): HeightMap & { readonly workZero: readonly [number, number] } {
  return {
    origin: [map.origin[0] - workZero[0], map.origin[1] - workZero[1]],
    spacing: [map.spacing[0], map.spacing[1]],
    cols: map.cols,
    rows: map.rows,
    z: [...map.z],
    workZero: [workZero[0], workZero[1]],
  }
}

/** True when every point is measured (`filledHeights` accepts it). */
export function bedMapComplete(map: BedMapLike): boolean {
  return filledHeights({ ...map }).isOk()
}

/**
 * The virtual machine's warped bed (docs/modes/run-surface.md#virtual-machine-bed): a tilt about
 * the travel's centre plus seeded bumps, range under 0.8 mm on an 800 × 600 table.
 */
export const VIRTUAL_BED = {
  tilt: [0.0005, -0.0003] as const,
  seed: 11,
  count: 6,
  amplitude: 0.1,
  /** The bumps' largest radius as a share of the travel's smaller side. */
  radius: 0.15,
} as const

/** The virtual bed's height field over a travel (MPos, X/Y in [−travel, 0]) at `z`. */
export function virtualBed(
  travel: readonly [number, number, number],
  z: number,
): { z: number; tilt: readonly [number, number]; origin: [number, number]; bumps: HeightBump[] } {
  const b = VIRTUAL_BED
  return {
    z,
    tilt: b.tilt,
    origin: [-travel[0] / 2, -travel[1] / 2],
    bumps: seededBumps(
      b.seed,
      b.count,
      [-travel[0], -travel[1], 0, 0],
      b.amplitude,
      b.radius * Math.min(travel[0], travel[1]),
    ),
  }
}
