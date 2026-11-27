/** Tools and inputs for toolpath tests (strategy defaults of plan-v0.1.md, metric). */
import type { StockGeometry } from '../../geometry/model'
import type {
  ChamferInput,
  CuttingParams,
  DrillingInput,
  FacingInput,
  PocketInput,
  ProfileInput,
  ToolpathTool,
} from '../model'
import type { LineInput } from '../line'

export const endMill = (diameter: number, fluteLength = 25): ToolpathTool => ({
  id: `em${diameter}`,
  type: 'flatEndMill',
  diameter,
  cornerRadius: 0,
  fluteLength,
})

export const bullNose = (diameter: number, cornerRadius: number): ToolpathTool => ({
  id: `bn${diameter}r${cornerRadius}`,
  type: 'bullNoseEndMill',
  diameter,
  cornerRadius,
  fluteLength: 20,
})

export const drill = (diameter: number, pointAngle = 118): ToolpathTool => ({
  id: `dr${diameter}`,
  type: 'drill',
  diameter,
  cornerRadius: 0,
  fluteLength: 40,
  pointAngle,
})

/** A chamfer mill: DC, included angle, tip diameter (0 = pointed). */
export const chamferMill = (diameter: number, angle = 90, tipDiameter = 0): ToolpathTool => ({
  id: `cm${diameter}`,
  type: 'chamferMill',
  diameter,
  cornerRadius: 0,
  fluteLength: 10,
  angle,
  tipDiameter,
})

/** A tapered ball end mill (tapered-ball-nose.md): large end DC, ball Ø, angle per side, LCF. */
export const taperedBall = (
  diameter: number,
  tipDiameter: number,
  taperAngle: number,
  fluteLength = 22,
): ToolpathTool => ({
  id: `tb${tipDiameter}`,
  type: 'taperedBallEndMill',
  diameter,
  cornerRadius: tipDiameter / 2,
  fluteLength,
  tipDiameter,
  taperAngle,
})

export const cutting = (tool: ToolpathTool, over: Partial<CuttingParams> = {}): CuttingParams => ({
  spindleSpeed: 18000,
  feedRate: 1200,
  plungeRate: 300,
  stepdown: 0.25 * tool.diameter,
  stepover: 0.4 * tool.diameter,
  ...over,
})

export const HEIGHTS = { clearanceHeight: 10, retractHeight: 2 } as const
export const RATES = [5000, 5000, 1000] as const

export function facingInput(
  stock: StockGeometry,
  tool: ToolpathTool,
  over: Partial<FacingInput> = {},
): FacingInput {
  return {
    planOperationId: 'op-facing',
    tool,
    cutting: cutting(tool, { stepover: 0.75 * tool.diameter, stepdown: 0.5 }),
    heights: HEIGHTS,
    stock,
    operation: { kind: 'facing', id: 'facing1', depth: 0.5 },
    strategy: { pattern: 'zigzag', axis: 'x', overshoot: 1, direction: 'climb' },
    maxFeedRate: RATES,
    ...over,
  }
}

export function pocketInput(
  stock: StockGeometry,
  operation: PocketInput['operation'],
  tool: ToolpathTool,
  over: Partial<PocketInput> = {},
): PocketInput {
  return {
    planOperationId: `op-${operation.id}`,
    tool,
    cutting: cutting(tool),
    heights: HEIGHTS,
    stock,
    operation,
    strategy: {
      entry: 'helix',
      helixDiameter: 0.8 * tool.diameter,
      rampAngle: 3,
      finishAllowance: 0.2,
      finishStepdown: operation.depth,
      direction: 'climb',
    },
    maxFeedRate: RATES,
    ...over,
  }
}

export function drillingInput(
  stock: StockGeometry,
  operation: DrillingInput['operation'],
  tool: ToolpathTool,
  strategy: DrillingInput['strategy'],
): DrillingInput {
  return {
    planOperationId: `op-${operation.id}`,
    tool,
    cutting: { spindleSpeed: 3000, feedRate: 600, plungeRate: 150 },
    heights: HEIGHTS,
    stock,
    operation,
    strategy,
    maxFeedRate: RATES,
  }
}

export function profileInput(
  stock: StockGeometry,
  operation: ProfileInput['operation'],
  tool: ToolpathTool,
  over: Partial<ProfileInput> = {},
): ProfileInput {
  return {
    planOperationId: `op-${operation.id}`,
    tool,
    cutting: cutting(tool),
    heights: HEIGHTS,
    stock,
    operation,
    strategy: {
      entry: 'ramp',
      rampAngle: 3,
      breakthrough: 0.5,
      finishAllowance: 0.2,
      direction: 'climb',
    },
    maxFeedRate: RATES,
    ...over,
  }
}

export function chamferInput(
  stock: StockGeometry,
  operation: ChamferInput['operation'],
  tool: ToolpathTool,
  strategy: Partial<ChamferInput['strategy']> = {},
): ChamferInput {
  return {
    planOperationId: `op-${operation.id}`,
    tool,
    cutting: { spindleSpeed: 16000, feedRate: 800, plungeRate: 200 },
    heights: HEIGHTS,
    stock,
    operation,
    strategy: { entry: 'contour', rampAngle: 3, direction: 'climb', ...strategy },
    maxFeedRate: RATES,
  }
}

/** A Line input (engraved-patterns.md E1): ramp-back at 10° by default, stepdown 0.5 mm. */
export function lineInput(
  stock: StockGeometry,
  operation: LineInput['operation'],
  tool: ToolpathTool,
  strategy: Partial<LineInput['strategy']> = {},
  over: Partial<LineInput['cutting']> = {},
): LineInput {
  return {
    planOperationId: `op-${operation.id}`,
    tool,
    cutting: { spindleSpeed: 18000, feedRate: 1000, plungeRate: 300, stepdown: 0.5, ...over },
    heights: HEIGHTS,
    stock,
    operation,
    strategy: { entry: 'ramp', rampAngle: 10, ...strategy },
    maxFeedRate: RATES,
  }
}
