/**
 * Dowel sizes and fit, shared by the split's dowel joint (split parts 4b) and the registration
 * hole (alignment phase 1): hole Ø = dowel Ø + fit. Plain numbers in mm.
 * Doc: docs/modes/split-parts.md#implementation-4b, docs/modes/alignment.md#alignment-aids
 */

/** Common dowel Ø (mm): what the UI suggests and the split's placement tries. */
export const DOWEL_SIZES = [3, 4, 5, 6, 8, 10] as const

/** Hole Ø = dowel Ø + this (mm): a glue fit for wooden dowels, a slip fit for pins. */
export const DOWEL_FIT = 0.2

/** The thinnest wall (mm) a dowel hole keeps to a glue face's edge or a feature (`dowelNear`). */
export const DOWEL_WALL_MIN = 1.5

/** Accepted dowel Ø (mm). */
export const DOWEL_DIAMETER_MIN = 2
export const DOWEL_DIAMETER_MAX = 20

/** The default dowel Ø (mm) when none is chosen: the registration hole's 6 mm dowel. */
export const DOWEL_DEFAULT = 6

/** Default depth of each hole (mm): a dowel 5 × Ø long, 1 mm of glue room at each end. */
export const dowelDepthDefault = (diameter: number): number => 2.5 * diameter + 1

/** The hole Ø for a dowel (mm). */
export const dowelHole = (diameter: number): number => diameter + DOWEL_FIT

/** The deepest hole accepted (mm). */
export const DOWEL_DEPTH_MAX = 100
