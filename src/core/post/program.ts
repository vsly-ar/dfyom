/**
 * The plan → post contract: a machining program of one setup, controller-neutral.
 * Doc: docs/architecture/grbl.md#input-boundary
 *
 * Plain float64 data: lengths in mm in the setup's WCS (Z0 = stock top), feeds in mm/min,
 * spindle speeds in rpm. The post converts units and owns every text detail.
 */
import type { ToolpathToolType, Vec3 } from '../toolpath/model'
import type { Overreach } from '../toolpath/overreach'

/** The tool snapshot as the header, tool-change marker and pause message show it. */
export interface ProgramTool {
  readonly name: string
  /** mm */
  readonly diameter: number
  /** For the tool-change message's type word (grbl.md#pause-messages-hardening-df63). */
  readonly type: ToolpathToolType
  /** Tapered ball end mill only: the ball Ø (mm) and the angle per side (degrees), for its description. */
  readonly tipDiameter?: number
  readonly taperAngle?: number
  /**
   * The tool run's minimum stickout (mm, hardening DF130) for the header tool line and the
   * tool-change messages; absent = not written (grbl.md#pause-messages-hardening-df63).
   */
  readonly stickoutNeeded?: number
  /**
   * DF132 H3: the workholding item under the collet nut or spindle body that decides
   * `stickoutNeeded`, and the holder's preset name; written as a comment before the tool-change
   * marker for Run mode's dialog (docs/modes/tool-holder.md#run-mode). Absent = the deepest cut.
   */
  readonly stickoutReason?: {
    readonly part: 'nut' | 'body'
    readonly item: string
    readonly holder?: string
  }
  /**
   * DF132 H6: the tool's own holder (a library tool's override), as the header's holder line
   * ("ER16 nut dia 32 x 18 mm, body dia 65 mm"); absent = the machine's (`workholding.holder`).
   */
  readonly holder?: string
}

/**
 * A tool run's Z reference surface and touch-off spot (hardening DF69,
 * docs/modes/z-reference.md#exported-gcode): the post writes the run's Z shifted by −`level`, so
 * the operator zeroes Z on the surface, and rapids to the spot before the tool change pause.
 */
export interface ProgramZRef {
  /** As the program writes it: "the top face", "Facing 1 floor". */
  readonly label: string
  /** The surface's Z in the setup frame (mm, ≤ 0). */
  readonly level: number
  /** Touch-off spot (mm, WCS). */
  readonly at: readonly [number, number]
  /** The setup's up face (Z0 of the setup frame): no instruction lines, no first-tool pause. */
  readonly top: boolean
}

/**
 * `toolChange`: tool `number` (1, 2, … in order of first use) goes in; the first block of every
 * program is one. `spindle`: start (or change) the spindle at `rpm`, or stop it. `arc`: XY plane,
 * `i`/`j` = center − start (mm); a Z change makes it a helix; `to` equal to the start in X and Y
 * is a full circle.
 */
export type Block =
  | {
      readonly kind: 'toolChange'
      readonly number: number
      readonly tool: ProgramTool
      /** The run's Z reference (DF69); absent = Z0 on the up face, no spot. */
      readonly zRef?: ProgramZRef
    }
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
   * The work zero's offset from that corner along machine X, Y (mm; alignment phase 1,
   * docs/modes/alignment.md#export); absent = at the corner (the header as before).
   */
  readonly zero?: readonly [number, number]
  /** The alignment point the zero is on, by name. */
  readonly zeroOn?: string
  /** Alignment points in cycle order: name and WCS X, Y (mm); absent or empty = none. */
  readonly alignment?: readonly { readonly name: string; readonly at: readonly [number, number] }[]
  /**
   * How far the program's tools reach past the stock sides (mm, hardening DF59); absent = no
   * reach lines.
   */
  readonly overreach?: Overreach
  /**
   * The setup's clamp height and the links' margin above it (mm, hardening DF64): the clamp line
   * replaces the clearance in the DF59 note; absent = clamps below the clearance height.
   */
  readonly clamp?: { readonly height: number; readonly margin: number }
  /**
   * The setup's workholding (docs/modes/workholding.md#program-and-run): one line per item
   * ("Toe clamp 1: front X125 grip 10 top Z12", program units) and the margin the program keeps
   * (mm); absent = none modelled (the DF59 clamp note stays).
   */
  readonly workholding?: {
    readonly items: readonly string[]
    readonly margin: number
    /**
     * DF132 H3: the machine's holder ("ER11 nut dia 19 x 12 mm, body dia 52 mm"); absent = none,
     * or (H6) every tool has its own (`ProgramTool.holder`).
     */
    readonly holder?: string
  }
}

export interface MachiningProgram {
  /** Plan name (header comment). */
  readonly name: string
  /**
   * A split piece's line after the plan name ("Piece 3 of 8 of Enclosure 1", split parts 4a,
   * docs/modes/split-parts.md#plan-export-and-run-per-piece); absent for a plain part.
   */
  readonly piece?: string
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
