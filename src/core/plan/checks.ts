/**
 * Tool checks per operation (failing = `plan.check`) and machine checks (warnings).
 * Doc: docs/modes/plan-v0.1.md#tool-assignment-and-checks, docs/modes/plan-v0.1.md#plan-record
 *
 * Pure: inputs are models, outputs are issue lists; values in canonical mm, °, rpm, mm/min.
 */
import { z } from 'zod'
import { effectiveTolerance, type Operation, type Part } from '../design/operation'
import { SurfaceTable } from '../design/surfaces'
import type { Machine } from '../library/machine'
import type { Stock } from '../library/stock'
import type { ToolType } from '../library/tool.dto'
import type { Tool } from '../library/tool'
import type { Quantity } from '../quantity/quantity'
import type { ResolvedFeeds } from './feeds'
import type { ResolvedStrategy } from './strategy'
import { chamferCuts, holeDepth } from './strategy'
import { chamferFit } from '../geometry/tool-fit'

export const PLAN_WARNING_CODES = [
  'plan.check',
  'plan.order',
  'plan.loosePiece',
  'plan.cutoutBeforeSetup',
  'plan.machine',
  'plan.restMaterial',
  'plan.stepoverClamped',
  'plan.designToolReplaced',
  'plan.designToolFailed',
  'plan.toolUnresolved',
  'plan.libraryBlocked',
  'plan.rebuildBlocked',
  'plan.broken',
  'feeds.rpmAboveMachine',
  'feeds.rpmBelowMachine',
  'feeds.feedClamped',
  'feeds.rubbing',
  'feeds.chipLoadHigh',
  'feeds.powerExceeded',
  'feeds.powerSkipped',
  'feeds.noData',
  'feeds.lockInactive',
] as const
export type PlanWarningCode = (typeof PLAN_WARNING_CODES)[number]

/**
 * One finding of `plan.warning.list`. `error` findings make toolpath generation fail with their
 * code (`plan.check`, `plan.order`); `warning`/`info` never block.
 */
export interface PlanWarning {
  readonly code: PlanWarningCode
  readonly severity: 'error' | 'warning' | 'info'
  readonly message: string
  readonly planOperationId?: string
  /** The field to change, e.g. `tool`, `stickout`, `feedRate`, `strategy.helixDiameter`. */
  readonly field?: string
  readonly rule: string
  readonly params: Readonly<Record<string, number | string>>
}

export const PlanWarningSchema = z
  .object({
    code: z.enum(PLAN_WARNING_CODES),
    severity: z.enum(['error', 'warning', 'info']),
    message: z.string().describe('English, values in mm, rpm, mm/min'),
    planOperationId: z.string().optional(),
    field: z.string().optional().describe('Field to change, e.g. tool, stickout, feedRate'),
    rule: z.string(),
    params: z.record(z.string(), z.union([z.number(), z.string()])),
  })
  .describe('A plan finding: errors block toolpath generation, warnings never do')

/** Tool types per operation kind (drilling: a drill, or a flat end mill for helical boring). */
export const TOOL_TYPES_FOR: Readonly<Record<Operation['kind'], readonly ToolType[]>> = {
  facing: ['flatEndMill'],
  pocket: ['flatEndMill', 'bullNoseEndMill'],
  drilling: ['drill', 'flatEndMill'],
  profile: ['flatEndMill'],
  chamfer: ['chamferMill'],
}

/** Float slack for comparisons of derived float64 values. */
const EPS = 1e-9

/** A fit rule's values as finding params (numbers and strings only). */
function numeric(values: Readonly<Record<string, unknown>>): Record<string, number | string> {
  const out: Record<string, number | string> = {}
  for (const [k, v] of Object.entries(values))
    if (typeof v === 'number' || typeof v === 'string') out[k] = v
  return out
}

/** |actual − nominal| within the nominal's effective tolerance (exact match without one). */
function withinTolerance(actual: number, nominal: Quantity, op: Operation, part: Part): boolean {
  const d = actual - nominal.canonical
  return effectiveTolerance(nominal, op, part).mapOr(Math.abs(d) <= 1e-6, (t) => {
    return d <= t.upper.toNumber() + EPS && d >= t.lower.toNumber() - EPS
  })
}

export interface ToolCheckInput {
  readonly ops: readonly Operation[]
  readonly part: Part
  readonly stock: Stock
  readonly tool: Tool
  /** Resolved stickout, mm. */
  readonly stickout: number
  /** Resolved stepdown (facing), mm; None when not resolved. */
  readonly stepdown?: number
  /** Resolved strategy (breakthrough of profiles and through holes). */
  readonly strategy: ResolvedStrategy
}

type Finding = Omit<PlanWarning, 'code' | 'severity' | 'planOperationId'>

/** Depth of a surface below the stock face of its direction (mm, ≥ 0; the top in v0.1). */
function belowTop(table: SurfaceTable, id: string): number {
  return table.get(id).mapOr(0, (e) => -e.faceZ.toNumber())
}

/** The tool checks of the table (docs/modes/plan-v0.1.md#tool-assignment-and-checks). */
export function toolFindings(i: ToolCheckInput): Finding[] {
  const out: Finding[] = []
  const add = (field: string, rule: string, message: string, params: Finding['params'] = {}) =>
    out.push({ field, rule, message, params })
  const { tool, part, stock } = i
  const D = tool.diameter.canonical
  const kind = i.ops[0]?.kind
  if (kind === undefined) return out
  if (!TOOL_TYPES_FOR[kind].includes(tool.type)) {
    add('tool', 'toolType', `a ${kind} needs a ${TOOL_TYPES_FOR[kind].join(' or ')}`, {
      toolType: tool.type,
    })
    return out
  }
  const flute = tool.fluteLength.canonical
  const oal = tool.overallLength.canonical
  if (i.stickout <= 0 || i.stickout >= oal)
    add('stickout', 'stickoutRange', 'stickout must be > 0 and < the overall length', {
      stickout: i.stickout,
      overallLength: oal,
    })
  const table = SurfaceTable.build(part.operations, stock)
  const thickness = stock.thickness.canonical
  for (const op of i.ops) {
    switch (op.kind) {
      case 'facing':
        if (i.stepdown !== undefined && i.stepdown > flute + EPS)
          add('stepdown', 'fluteLength', 'stepdown must be at most the flute length', {
            stepdown: i.stepdown,
            fluteLength: flute,
          })
        break
      case 'pocket': {
        const s = op.shape
        if (s.kind === 'rectangle' && D / 2 > s.cornerRadius.canonical + EPS)
          add('tool', 'cornerRadius', 'tool radius must be at most the corner radius', {
            radius: D / 2,
            cornerRadius: s.cornerRadius.canonical,
          })
        if (s.kind === 'circle' && D > s.diameter.canonical + EPS)
          add('tool', 'pocketSize', 'tool diameter must fit the pocket', {
            diameter: D,
            pocket: s.diameter.canonical,
          })
        const floorRadius = op.floorRadius.canonical
        if (floorRadius > 0) {
          const re = tool.effectiveCornerRadius.toNumber()
          if (tool.type !== 'bullNoseEndMill' || !withinTolerance(re, op.floorRadius, op, part))
            add('tool', 'floorRadius', 'a floor fillet needs a bull nose with RE = floorRadius', {
              floorRadius,
              cornerRadius: re,
            })
        } else if (tool.type !== 'flatEndMill')
          add('tool', 'floorRadius', 'a sharp floor needs a flat end mill', { floorRadius })
        const depth = belowTop(table, `${op.id}.floor`)
        if (depth > i.stickout + EPS)
          add('stickout', 'reach', 'pocket depth must be at most the stickout', {
            depth,
            stickout: i.stickout,
          })
        break
      }
      case 'drilling': {
        const hole = op.diameter.canonical
        const depth = holeDepth(op, part.operations, stock)
        const through = op.bottom === 'through'
        const breakthrough = through && i.strategy.kind === 'drilling' ? i.strategy.breakthrough : 0
        const fromTop = belowTop(table, op.on) + depth + breakthrough
        if (tool.type === 'drill') {
          if (!withinTolerance(D, op.diameter, op, part))
            add('tool', 'drillDiameter', 'drill diameter must equal the hole diameter', {
              diameter: D,
              hole,
            })
          const sig = tool.pointAngle.mapOr(118, (q) => q.canonical)
          if (op.bottom === 'drillPoint' && op.pointAngle.isSome()) {
            const want = op.pointAngle.unwrap()
            if (!withinTolerance(sig, want, op, part))
              add('tool', 'pointAngle', 'drill point angle must equal the hole point angle', {
                pointAngle: sig,
                hole: want.canonical,
              })
          }
          if (op.bottom === 'flat')
            add('tool', 'flatBottom', 'a drill cannot make a flat bottom; use an end mill')
          const tip = D / 2 / Math.tan(((sig / 2) * Math.PI) / 180)
          if (depth + breakthrough + tip > flute + EPS)
            add('tool', 'fluteLength', 'hole depth + tip must be at most the flute length', {
              depth: depth + breakthrough,
              tip,
              fluteLength: flute,
            })
        } else {
          if (!(D > hole / 2 + EPS && D < hole - EPS))
            add('tool', 'helixDiameter', 'helical boring needs hole/2 < D < hole diameter', {
              diameter: D,
              hole,
            })
          if (op.bottom === 'drillPoint')
            add('tool', 'drillPoint', 'an end mill cannot make a drill point bottom')
          if (fromTop > i.stickout + EPS)
            add('stickout', 'reach', 'hole depth must be at most the stickout', {
              depth: fromTop,
              stickout: i.stickout,
            })
        }
        break
      }
      case 'profile': {
        // a blind `on` groove (v0.3) cuts to its depth below the stock face, without breakthrough
        const breakthrough = i.strategy.kind === 'profile' ? i.strategy.breakthrough : 0
        const cut = op.depth.mapOr(thickness + breakthrough, (d) => d.canonical)
        const what = op.depth.isSome() ? 'groove depth' : 'thickness + breakthrough'
        if (D > op.slotWidth.canonical + EPS)
          add('tool', 'slotWidth', 'tool diameter must be at most the slot width', {
            diameter: D,
            slotWidth: op.slotWidth.canonical,
          })
        if (cut > flute + EPS)
          add('tool', 'fluteLength', `${what} must be at most the flute length`, {
            depth: cut,
            fluteLength: flute,
          })
        if (cut > i.stickout + EPS)
          add('stickout', 'reach', `${what} must be at most the stickout`, {
            depth: cut,
            stickout: i.stickout,
          })
        break
      }
      case 'chamfer': {
        // plan-v0.4.md § Tool checks for chamfer mills: the design's fit row (angle, tip, slant
        // when contoured), then reach to the tip of the resolved entry
        const cut = chamferCuts(op, part.operations, stock, tool)
        if (cut === undefined) break
        const unfit = chamferFit(
          {
            type: tool.type,
            diameter: D,
            ...(tool.angle.isSome() ? { angle: tool.angle.unwrap().canonical } : {}),
            tipDiameter: tool.tipDiameterMm,
          },
          {
            edgeDiameter: cut.edgeDiameter,
            diameter: op.diameter.canonical,
            angle: op.angle.canonical,
          },
        )
        if (unfit !== undefined) add('tool', unfit.rule, unfit.detail, numeric(unfit.values))
        const plunged = i.strategy.kind === 'chamfer' && i.strategy.entry === 'plunge'
        const depth = belowTop(table, op.on) + (plunged ? cut.plungeDepth : cut.contourDepth)
        if (depth > i.stickout + EPS)
          add('stickout', 'reach', 'chamfer depth must be at most the stickout', {
            depth,
            stickout: i.stickout,
          })
        break
      }
    }
  }
  return out
}

/** Named stock sizes (mm) on the machine axes of one setup (`setupStockSize`). */
export interface AxisSizes {
  readonly x: readonly [string, number]
  readonly y: readonly [string, number]
  readonly z: readonly [string, number]
}

/**
 * Stock + clearance against the travel (sizes only: work zero on the table is unknown), with the
 * stock sizes in the setup's orientation (docs/modes/plan-v0.2.md#setups-from-face-directions).
 */
export function stockFindings(size: AxisSizes, clearance: number, machine: Machine): Finding[] {
  const out: Finding[] = []
  const fit = (axis: 'x' | 'y' | 'z', size: number, what: string) => {
    const travel = machine.travel[axis].canonical
    if (size > travel + EPS)
      out.push({
        field: 'machine',
        rule: 'travel',
        message: `${what} exceeds the ${axis.toUpperCase()} travel`,
        params: { axis, size, travel },
      })
  }
  fit('x', size.x[1], `stock ${size.x[0]}`)
  fit('y', size.y[1], `stock ${size.y[0]}`)
  fit('z', size.z[1] + clearance, `stock ${size.z[0]} + clearance height`)
  return out
}

/** Feed rates against the axes they move and the spindle speed against the spindle range. */
export function feedFindings(feeds: ResolvedFeeds, machine: Machine): Finding[] {
  const out: Finding[] = []
  const f = feeds.fields
  const maxXY = Math.min(machine.maxFeedRate.x.canonical, machine.maxFeedRate.y.canonical)
  const maxZ = machine.maxFeedRate.z.canonical
  f.feedRate.map((v) => {
    if (v.value > maxXY + EPS)
      out.push({
        field: 'feedRate',
        rule: 'maxFeedRate',
        message: 'feed rate exceeds the X/Y max feed rate',
        params: { feedRate: v.value, max: maxXY },
      })
  })
  f.plungeRate.map((v) => {
    if (v.value > maxZ + EPS)
      out.push({
        field: 'plungeRate',
        rule: 'maxFeedRate',
        message: 'plunge rate exceeds the Z max feed rate',
        params: { plungeRate: v.value, max: maxZ },
      })
  })
  f.spindleSpeed.map((v) => {
    const min = machine.spindle.minSpeed.mapOr(0, (q) => q.canonical)
    const max = machine.spindle.maxSpeed.canonical
    if (v.value < min - EPS || v.value > max + EPS)
      out.push({
        field: 'spindleSpeed',
        rule: 'spindleRange',
        message: 'spindle speed is outside the spindle range (GRBL clamps silently)',
        params: { spindleSpeed: v.value, min, max },
      })
  })
  return out
}
