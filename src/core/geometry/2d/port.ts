/**
 * Port to the 2D library (offsets and booleans of line/arc loops), like `SolidPort` for 3D. The
 * only implementation is `cavalier/` (CavalierContours as WASM, ADR 0019); measures are exact
 * TypeScript (measure.ts). Doc: docs/architecture/shapes.md#2d-port
 *
 * Plain data in and out: no library handle leaks. Every fallible method fails with
 * `geometry.evaluation` and an issue rule (`Region2dRule`). Build regions with `normalise` (or
 * another port call): the offsets assume a normalised region (a hole touching its outer loop must
 * already be part of it, ADR 0019 decision 3).
 */
import type { AppResult } from '../../../shared/result'
import type { Vec2 } from '../model'
import type { ChainPoint, Closest } from './measure'
import type { Loop, Path, Region } from './model'

export interface Region2dPort {
  /**
   * A region from loops of any nesting: loops apply from the largest |area| down, counter-clockwise
   * ones united, clockwise ones subtracted; self-touching loops split into lobes where that keeps
   * their orientation. Self-crossing loops are not repaired (callers refuse them first).
   */
  normalise(loops: readonly Loop[]): AppResult<Region>
  union(a: Region, b: Region): AppResult<Region>
  difference(a: Region, b: Region): AppResult<Region>
  intersect(a: Region, b: Region): AppResult<Region>
  /** Offset by `d` mm: positive shrinks (tool centre region of a pocket), negative grows. */
  offset(region: Region, d: number): AppResult<Region>
  /** Points within `d` > 0 of an open path: both sides with round ends (an `on` groove's band). */
  offsetPath(path: Path, d: number): AppResult<Region>
  /** Length of a loop or path. */
  length(chain: Loop | Path): number
  /** The point at distance `s` along a loop (wraps) or path (`outOfRange` outside it). */
  pointAt(chain: Loop | Path, s: number, closed: boolean): AppResult<ChainPoint>
  /** Whether `p` lies in the region (its boundary included). */
  contains(region: Region, p: Vec2): boolean
  /** Closest boundary point of the chains; undefined when they have no elements. */
  distance(chains: readonly (Loop | Path)[], p: Vec2): Closest | undefined
}
