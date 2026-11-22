/**
 * Toolpath contract and generator inputs (task 2.10).
 * Doc: docs/modes/plan-v0.1.md#toolpath-data-model and #toolpath-generators-task-210
 *
 * Toolpaths are derived data: plain float64 mm in the setup's WCS (Z0 = stock top), feeds in
 * mm/min, spindle speed in rpm. Nothing here is a quantity or a model class.
 */
import type {
  AnalyticOperation,
  OperationGeometry,
  StockGeometry,
  Vec2,
  Vec3,
} from '../geometry/model'

export type { Vec2, Vec3 }

export type DrillCycle = 'simple' | 'peck' | 'chipBreak'

export interface RapidMove {
  readonly kind: 'rapid'
  readonly to: Vec3
}

export interface LineMove {
  readonly kind: 'line'
  readonly to: Vec3
  readonly feed: number
}

/** XY-plane arc from the previous position; a Z change makes it a helix. Sweeps at most 180°. */
export interface ArcMove {
  readonly kind: 'arc'
  readonly to: Vec3
  readonly center: Vec2
  readonly cw: boolean
  readonly feed: number
}

/**
 * A drilling cycle, kept semantic; starts and ends at `[at, retract]`. The export expands it
 * (`expandDrill`); GRBL 1.1 has no canned cycles.
 */
export interface DrillMove {
  readonly kind: 'drill'
  readonly at: Vec2
  /** Z of the hole's top (the `on` surface). */
  readonly top: number
  /** Z of the drill tip at full depth. */
  readonly bottom: number
  readonly cycle: DrillCycle
  /** Peck depth (`peck`, `chipBreak`). */
  readonly peck?: number
  /** Retract distance after each peck (`chipBreak`). */
  readonly back?: number
  readonly retract: number
  readonly feed: number
}

export type Move = RapidMove | LineMove | ArcMove | DrillMove

export type PassKind = 'rough' | 'finish' | 'drill'

export interface Pass {
  readonly kind: PassKind
  readonly moves: readonly Move[]
}

export interface ToolpathStats {
  /** Length of all feed moves incl. expanded drill cycles (mm). */
  readonly cutLength: number
  /** Length of all rapid moves incl. expanded drill cycles (mm). */
  readonly rapidLength: number
  /** Feed time plus rapid time at the machine's max feed rates; no acceleration (s). */
  readonly estimatedSeconds: number
}

/**
 * The toolpath of one plan operation. The tool is at clearance height before the first move
 * (a horizontal rapid at clearance) and after the last one.
 */
export interface Toolpath {
  readonly planOperationId: string
  /** Tool snapshot id. */
  readonly tool: string
  readonly spindleSpeed: number
  readonly passes: readonly Pass[]
  readonly stats: ToolpathStats
}

// ---------------------------------------------------------------- generator inputs

export type ToolpathToolType =
  'flatEndMill' | 'bullNoseEndMill' | 'ballEndMill' | 'drill' | 'chamferMill'

/** The plan's tool copy, reduced to float64 mm (and degrees for `pointAngle`). */
export interface ToolpathTool {
  /** Snapshot id, copied into `Toolpath.tool`. */
  readonly id: string
  readonly type: ToolpathToolType
  readonly diameter: number
  /** Effective corner radius: 0 flat, RE bull nose, D/2 ball. */
  readonly cornerRadius: number
  readonly fluteLength: number
  /** Drill only (SIG, degrees). */
  readonly pointAngle?: number
  /** Chamfer mill only: included angle (degrees) and tip diameter (0 = pointed). */
  readonly angle?: number
  readonly tipDiameter?: number
}

/** Resolved feeds and speeds (override → preset → calculator → strategy fallback). */
export interface CuttingParams {
  /** rpm */
  readonly spindleSpeed: number
  /** mm/min; also ramps and helices. */
  readonly feedRate: number
  /** mm/min; straight plunges and drilling. */
  readonly plungeRate: number
  /** mm per level. */
  readonly stepdown: number
  /** mm between neighbouring passes. */
  readonly stepover: number
}

/** Drilling uses no stepdown or stepover (the peck depth and helix pitch are its strategy's). */
export type DrillCuttingParams = Pick<CuttingParams, 'spindleSpeed' | 'feedRate' | 'plungeRate'>

/** The setup's safe heights (mm): clearance up from the stock top, retract up from `on`. */
export interface SafeHeights {
  readonly clearanceHeight: number
  readonly retractHeight: number
}

export type CutDirection = 'climb' | 'conventional'

export interface FacingStrategy {
  readonly pattern: 'zigzag' | 'oneWay'
  readonly axis: 'x' | 'y'
  /** Tool edge past the stock edge (mm). */
  readonly overshoot: number
  readonly direction: CutDirection
}

export type PocketEntry = 'helix' | 'ramp' | 'plunge'

export interface PocketStrategy {
  readonly entry: PocketEntry
  readonly helixDiameter: number
  /** Degrees; also the helix pitch angle. */
  readonly rampAngle: number
  /** Radial, walls only; 0 = no finishing pass. */
  readonly finishAllowance: number
  readonly finishStepdown: number
  readonly direction: CutDirection
}

export type DrillingStrategy = { readonly breakthrough: number } & (
  | { readonly cycle: 'simple' }
  | { readonly cycle: 'peck'; readonly peckDepth: number }
  | { readonly cycle: 'chipBreak'; readonly peckDepth: number; readonly chipBreakBack: number }
  | {
      readonly cycle: 'helix'
      /** Max descent per turn (mm). */
      readonly helixPitch: number
      /** Max helix slope (degrees; default as the pocket's `rampAngle`, 3°). */
      readonly rampAngle: number
      readonly direction: CutDirection
    }
)

export interface ProfileStrategy {
  readonly entry: 'ramp' | 'plunge'
  /** Degrees. */
  readonly rampAngle: number
  /** Below the stock bottom (mm). */
  readonly breakthrough: number
  readonly finishAllowance: number
  readonly direction: CutDirection
}

/** Max feed rate per axis (mm/min), from the machine copy; rapids run at it. */
export type AxisRates = Vec3

/** Everything one generator needs; `operation` comes from the plan's design snapshot. */
export interface GeneratorInput<Op, Strategy, Cutting = CuttingParams> {
  readonly planOperationId: string
  readonly tool: ToolpathTool
  readonly cutting: Cutting
  readonly heights: SafeHeights
  readonly stock: StockGeometry
  readonly operation: Op
  readonly strategy: Strategy
  /** Without a machine copy rapids are not timed (`estimatedSeconds` covers feed moves only). */
  readonly maxFeedRate?: AxisRates
}

export type FacingOperation = Extract<OperationGeometry, { kind: 'facing' }>
/** v0.1 contours only; general shapes go through generateRegionPocket (`regionPocket`). */
export type PocketOperation = AnalyticOperation<'pocket'>
export type DrillingOperation = Extract<OperationGeometry, { kind: 'drilling' }>
/** v0.1 contours, `outside` / `inside` only; general loops go through generateRegionProfile. */
export type ProfileOperation = AnalyticOperation<'profile'>

export type FacingInput = GeneratorInput<FacingOperation, FacingStrategy>
export type PocketInput = GeneratorInput<PocketOperation, PocketStrategy>
export type DrillingInput = GeneratorInput<DrillingOperation, DrillingStrategy, DrillCuttingParams>
export type ProfileInput = GeneratorInput<ProfileOperation, ProfileStrategy>
