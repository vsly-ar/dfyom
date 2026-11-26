/**
 * The depth legend's levels (engraved-patterns.md § UI, Line and Engraved pattern inspectors): the
 * distinct levels a Line's paths use, each a tick on the dark-to-light bar from `max` to `min`.
 * A path without levels is level 1; an open path's per-vertex levels each count; levels within
 * `LEGEND_STEP` are one tick. More than `LEGEND_TICKS_MAX` distinct levels (a continuous fade, as
 * Wood grain's) is reported as `continuous` with the range, so the bar is not a comb.
 * Pure (core); the inspectors draw it. Doc: docs/modes/engraved-patterns.md#depth-legend
 */
import type { Region2dPort } from '../../geometry/2d/port'
import type { LinePathLevels } from '../../geometry/model'
import type { ShapeDTO } from '../shape.dto'
import { engravingResolved } from './engraving'

/** Levels closer than this are one tick. */
export const LEGEND_STEP = 0.01
/** At most this many ticks; more is a continuous fade. */
export const LEGEND_TICKS_MAX = 12

/** The levels in use: ticks (descending, deepest first), or a continuous range. */
export type LegendLevels =
  | { readonly kind: 'ticks'; readonly levels: readonly number[] }
  | { readonly kind: 'continuous'; readonly min: number; readonly max: number }

/** The legend of a set of level values (0..1). */
export function legendOf(values: Iterable<number>): LegendLevels {
  const set = new Set<number>()
  for (const v of values)
    if (Number.isFinite(v)) set.add(Math.round(Math.min(1, Math.max(0, v)) / LEGEND_STEP))
  const levels = [...set].sort((a, b) => b - a).map((k) => +(k * LEGEND_STEP).toFixed(2))
  if (levels.length === 0) return { kind: 'ticks', levels: [1] }
  if (levels.length > LEGEND_TICKS_MAX)
    return { kind: 'continuous', min: levels.at(-1)!, max: levels[0]! }
  return { kind: 'ticks', levels }
}

/** The level values of resolved Line paths (null: no levels, level 1). */
export function* pathLevelValues(levels: readonly (LinePathLevels | null)[]): Generator<number> {
  for (const l of levels)
    if (l === null) yield 1
    else if (l.kind === 'loops') yield l.level
    else yield* l.level
}

const OWNED_LINES = /^(.+)_lines$/

/**
 * The legend of a Line's paths, read from the part's shape records: a path item's `levels` (one
 * value or one per vertex), 1 where an item has none (primitives never have levels); an engraved
 * pattern's owned shape by its resolved lines (needs the 2D port; without it, or when it does not
 * resolve, level 1).
 */
export function lineLegend(
  shapeIds: readonly string[],
  shapes: readonly ShapeDTO[],
  port: Region2dPort | undefined,
): LegendLevels {
  const values: number[] = []
  for (const id of shapeIds) {
    const s = shapes.find((x) => x.id === id)
    if (s === undefined) continue
    if (s.engraving !== undefined) {
      const featureId = OWNED_LINES.exec(id)?.[1]
      const r = featureId === undefined ? undefined : engravingResolved(featureId, shapes, port)
      if (r === undefined) values.push(1)
      else values.push(...pathLevelValues(r.lines.map((l) => l.levels)))
      continue
    }
    for (const item of s.items) {
      // a primitive (circle, rectangle, …) has no levels: level 1
      const lv = item.kind === 'path' ? item.levels : undefined
      if (lv === undefined) values.push(1)
      else if (typeof lv === 'number') values.push(lv)
      else values.push(...lv)
    }
  }
  return legendOf(values)
}
