/**
 * The plan → post contract: a machining program of one setup, controller-neutral.
 * Doc: docs/architecture/grbl.md#input-boundary
 *
 * Plain float64 data: lengths in mm in the setup's WCS (Z0 = stock top), feeds in mm/min,
 * spindle speeds in rpm. The post converts units and owns every text detail.
 */
import type { Vec3 } from '../toolpath/model'
import type { Overreach } from '../toolpath/overreach'

/** The tool snapshot as the header and tool-change marker show it. */
export interface ProgramTool {
  readonly name: string
  /** mm */
  readonly diameter: number
}

/**
 * `toolChange`: tool `number` (1, 2, … in order of first use) goes in; the first block of every
 * program is one. `spindle`: start (or change) the spindle at `rpm`, or stop it. `arc`: XY plane,
 * `i`/`j` = center − start (mm); a Z change makes it a helix; `to` equal to the start in X and Y
 * is a full circle.
 */
export type Block =
  | { readonly kind: 'toolChange'; readonly number: number; readonly tool: ProgramTool }
  | { readonly kind: 'spindle'; readonly rpm: number | 'off' }
  | { readonly kind: 'rapid'; readonly to: Vec3 }
  | { readonly kind: 'feed'; readonly to: Vec3; readonly feed: number }
  | {
      readonly kind: 'arc'
      readonly to: Vec3
      readonly i: number
      readonly j: number
      readonly cw: boolean
      readonly feed: number
    }
  | { readonly kind: 'comment'; readonly text: string }

/**
 * How the stock sits for the program's setup (hardening DF58), for the header comments:
 * docs/architecture/grbl.md#setup-header-hardening-df58. Built by `setupHeader` (plan side).
 */
export interface SetupHeader {
  /** Position in machining order (1, 2, …) and the plan's setup count. */
  readonly number: number
  readonly count: number
  /** Part faces up (machine +Z), towards the operator (−Y) and on the right (+X): "bottom". */
  readonly up: string
  readonly front: string
  readonly right: string
  /** The move from setup 1's orientation ("flip about X"); absent for setup 1. */
  readonly fromFirst?: string
  /** The part corner at the work zero, besides the up face: "back left". */
  readonly corner: string
  /** Stock extents along machine X, Y, Z (mm). */
  readonly stock: Vec3
  /**
   * How far the program's tools reach past the stock sides (mm, hardening DF59); absent = no
   * reach lines.
   */
  readonly overreach?: Overreach
}

export interface MachiningProgram {
  /** Plan name (header comment). */
  readonly name: string
  readonly setupName: string
  /** The setup instructions of the header; absent = only the setup name. */
  readonly setup?: SetupHeader
  /** Text units (the machine's `programUnits`); block values stay mm. */
  readonly units: 'mm' | 'in'
  /** The machine's `spindle.control`: `manual` pauses for the user to set the speed. */
  readonly spindleControl: 'gcode' | 'manual'
  /** Stock top in the WCS (0) + the setup's `clearanceHeight`: start, end, tool changes. */
  readonly clearanceZ: number
  readonly blocks: readonly Block[]
}
