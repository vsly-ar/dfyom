// The compare overlay's state (DF60 P5): its settings (on while set), the last job result of
// `design.reference.compare` and the per-vertex view of the mesh it measured, and the pure helpers
// the panel, the runner and the scene share (region boxes, the viewport's deviation view).
// Doc: docs/conventions/ui.md#reference-tools-df60, docs/modes/reference-tools.md#overlay-ui
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { deviationScale, type DeviationView } from '../../viewport/deviation'
import type { Box } from '../../viewport/mesh'

/** The compare overlay is on for this reference of this part, at this threshold (mm). */
export interface CompareSettings {
  readonly partId: string
  readonly referenceId: string
  readonly threshold: number
}

/** Default threshold (mm), as the command's. */
export const COMPARE_THRESHOLD_MM = 0.1
/** Regions the panel lists (the command's `limit`). */
export const COMPARE_REGIONS = 20
/** The overlay re-runs this long after an evaluation finished (ms). */
export const COMPARE_DEBOUNCE_MS = 300
/** A region is framed at least this large (mm). */
export const COMPARE_FRAME_MIN_MM = 10

type V3 = readonly [number, number, number]

/** A region of the result (reference-commands.ts `CompareRegionSchema`). */
export interface CompareRegion {
  readonly kind: 'missing' | 'extra'
  readonly volume: number
  readonly maxDev: number
  readonly at: V3
  readonly bounds: readonly [V3, V3]
  readonly surfaces: readonly string[]
  readonly operationIds: readonly string[]
  readonly cause?: 'cornerRadius'
}

/** The job's result (`design.reference.compare`). */
export interface CompareResult {
  readonly method: 'boolean' | 'heightmap'
  readonly threshold: number
  readonly stats: {
    readonly missingVolume: number
    readonly extraVolume: number
    readonly maxMissing: number
    readonly maxExtra: number
    readonly referenceVolume: number
    readonly partVolume: number
  }
  readonly regions: readonly CompareRegion[]
  readonly more?: number
  readonly below: { readonly count: number; readonly volume: number }
  readonly note?: string
  readonly evaluation: string
}

/** The per-vertex view of one mesh (`reference.compareView`). */
export interface CompareView {
  /** The mesh's positions the distances belong to (identity: the scene draws them only then). */
  readonly positions: Float32Array
  readonly distances: Float32Array
  readonly missing: Float32Array | null
}

export interface CompareState {
  /** A job or view request is under way. */
  readonly busy: boolean
  readonly result?: CompareResult
  readonly view?: CompareView
  readonly error?: AppErrorData
}

export const IDLE_COMPARE: CompareState = { busy: false }

/** The listed region of the largest deviation (the regions are ranked by volume). */
export function worstRegion(r: Pick<CompareResult, 'regions'>): CompareRegion | undefined {
  let worst: CompareRegion | undefined
  for (const x of r.regions) if (worst === undefined || x.maxDev > worst.maxDev) worst = x
  return worst
}

/** A region's box grown about its centre to at least `COMPARE_FRAME_MIN_MM` on each axis. */
export function regionFrame(r: Pick<CompareRegion, 'bounds'>): Box {
  const [lo, hi] = r.bounds
  const min: number[] = []
  const max: number[] = []
  for (let k = 0; k < 3; k++) {
    const c = (lo[k]! + hi[k]!) / 2
    const half = Math.max(hi[k]! - lo[k]!, COMPARE_FRAME_MIN_MM) / 2
    min.push(c - half)
    max.push(c + half)
  }
  return { min: [min[0]!, min[1]!, min[2]!], max: [max[0]!, max[1]!, max[2]!] }
}

/**
 * What the viewport draws for `positions` (the mesh it shows): the view when it was measured on
 * that mesh, else null (a newer mesh waits for its own distances).
 */
export function deviationView(
  state: CompareState,
  threshold: number,
  positions: Float32Array | undefined,
  region: number | null,
): DeviationView | null {
  const v = state.view
  if (v === undefined || positions === undefined || v.positions !== positions) return null
  const r = region === null ? undefined : state.result?.regions[region]
  return {
    distances: v.distances,
    threshold,
    scale: deviationScale(v.distances, threshold),
    missing: v.missing,
    region: r === undefined ? null : { min: r.bounds[0], max: r.bounds[1] },
  }
}
