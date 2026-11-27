/**
 * The tool's collision envelope (hardening DF132 H2): the tool from its tip up to the stickout,
 * the collet nut above it, the spindle body above that to infinity. Without a holder it is the
 * WH-F cylinder (one segment, tip to infinity).
 * Doc: docs/modes/tool-holder.md#collision-envelope
 *
 * Pure and headless; mm, heights from the tool tip.
 */

/** A holder's sizes (mm) and the name messages give it ("ER11", or none when measured). */
export interface HolderSizes {
  readonly nutDiameter: number
  readonly nutLength: number
  readonly bodyDiameter: number
  /** Short name for messages: the preset ("ER11 mini"), absent for measured sizes. */
  readonly name?: string
}

export type EnvelopePart = 'tool' | 'nut' | 'body'

/** One cylinder of the envelope: its radius and its Z band above the tip (mm). */
export interface EnvelopeSegment {
  readonly part: EnvelopePart
  readonly radius: number
  readonly zFrom: number
  readonly zTo: number
}

/**
 * `toolEnvelope(tool, stickout, holder)`: tool, nut and body as the doc's table gives them; one
 * segment (the tool from 0 to ∞) without a holder or without a stickout.
 */
export function toolEnvelope(
  tool: { readonly diameter: number; readonly shankDiameter?: number },
  stickout: number | undefined,
  holder: HolderSizes | undefined,
): EnvelopeSegment[] {
  const radius = Math.max(tool.diameter, tool.shankDiameter ?? 0) / 2
  if (holder === undefined || stickout === undefined)
    return [{ part: 'tool', radius, zFrom: 0, zTo: Infinity }]
  const nutTop = stickout + holder.nutLength
  return [
    { part: 'tool', radius, zFrom: 0, zTo: stickout },
    { part: 'nut', radius: holder.nutDiameter / 2, zFrom: stickout, zTo: nutTop },
    { part: 'body', radius: holder.bodyDiameter / 2, zFrom: nutTop, zTo: Infinity },
  ]
}
