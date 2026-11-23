/**
 * The design's tool field as a plan sees it: the field of a plan operation's (first) design
 * operation in the plan's own part, a specific tool resolved in the plan's own copy of the
 * design's tool snapshot (same id, like the stock copy), and whether a library tool matches it.
 * Doc: docs/modes/plan-v0.2.md#tool-resolution-from-the-design-tool-field
 */
import { None, Some, type Option } from '../../shared/result'
import { designToolFromDTO, generalizedLabel } from '../design/tool'
import { CHAMFER_ANGLE_TOLERANCE } from '../geometry/tool-fit'
import type { DesignToolDTO, PartDTO } from '../design/part.dto'
import type { LibraryItem } from '../library/library-item'
import type { Tool } from '../library/tool'
import type { ToolType } from '../library/tool.dto'
import type { LoadedPlan } from './plan'
import type { PlanOperationDTO } from './plan.dto'
import { sameValue } from './validity'

/** Sizes match within this (mm), as the design's fit table (`TOOL_MATCH_TOLERANCE`). */
const MATCH_TOLERANCE = 0.01

/** The design tool field of one design operation: `tool` (absent = none chosen) and the lock. */
export interface DesignToolField {
  readonly tool: DesignToolDTO | undefined
  readonly locked: boolean
}

/** The field of the plan operation's first design operation in `part` (none: not found). */
export function designToolField(part: PartDTO, op: PlanOperationDTO): DesignToolField {
  const found = part.operations.find((o) => o.id === op.designOperationIds[0])
  return { tool: found?.tool, locked: found?.toolLocked === true }
}

/** Whether two tool fields are equal by value (`tool` and the lock). */
export const sameDesignToolField = (a: DesignToolField, b: DesignToolField): boolean =>
  a.locked === b.locked && sameValue(a.tool, b.tool)

/** The design tool reduced to what plan resolution needs (canonical mm). */
export interface PlanDesignTool {
  readonly kind: 'generalized' | 'specific'
  readonly locked: boolean
  readonly type: ToolType
  readonly diameter: number
  /** Bull nose only. */
  readonly cornerRadius?: number
  /** Chamfer mill only: included angle, degrees. */
  readonly angle?: number
  /** "1/4" flat end mill" or the library tool's name. */
  readonly label: string
  /** Specific only: the plan copy (same id as the design's snapshot), its item and its tool. */
  readonly specific?: {
    readonly snapshotId: string
    readonly libraryItemId: string
    readonly tool: Tool
  }
}

/**
 * The design tool of a plan operation, or None when the design has none (a v0.1 project), it
 * does not load, or the plan holds no copy of its specific tool (a plan taken before task E4):
 * then the plan resolves as v0.1.
 */
export function planDesignTool(plan: LoadedPlan, op: PlanOperationDTO): Option<PlanDesignTool> {
  const field = designToolField(plan.dto.design.part, op)
  if (field.tool === undefined) return None
  const dto = field.tool
  if (dto.kind === 'specific') {
    const tool = plan.tools.get(dto.snapshotId)
    const snap = plan.dto.snapshots.find((s) => s.id === dto.snapshotId)
    if (tool === undefined || snap === undefined) return None
    return Some({
      kind: 'specific',
      locked: field.locked,
      type: tool.type,
      diameter: tool.diameter.canonical,
      ...(tool.cornerRadius.isSome() && { cornerRadius: tool.cornerRadius.unwrap().canonical }),
      ...(tool.angle.isSome() && { angle: tool.angle.unwrap().canonical }),
      label: tool.name,
      // tool snapshots always come from the library (only a part's stock may be its own)
      specific: { snapshotId: dto.snapshotId, libraryItemId: snap.libraryItemId ?? '', tool },
    })
  }
  const g = designToolFromDTO(dto)
  if (g.isErr()) return None
  const t = g.unwrap()
  if (t.kind !== 'generalized') return None
  return Some({
    kind: 'generalized',
    locked: field.locked,
    type: t.type,
    diameter: t.diameter.canonical,
    ...(t.cornerRadius.isSome() && { cornerRadius: t.cornerRadius.unwrap().canonical }),
    ...(t.angle.isSome() && { angle: t.angle.unwrap().canonical }),
    label: generalizedLabel(t),
  })
}

/**
 * A library tool matching the design tool's type and diameter (and RE) within 0.01 mm; a chamfer
 * mill also its angle within 0.5° (design-v0.4.md § Chamfer operation).
 */
export function matchesDesign(tool: Tool, d: PlanDesignTool): boolean {
  if (tool.type !== d.type) return false
  if (Math.abs(tool.diameter.canonical - d.diameter) > MATCH_TOLERANCE) return false
  if (tool.type === 'chamferMill') {
    const angle = tool.angle.mapOr(Number.NaN, (q) => q.canonical)
    return Math.abs(angle - (d.angle ?? Number.NaN)) <= CHAMFER_ANGLE_TOLERANCE
  }
  if (tool.type !== 'bullNoseEndMill') return true
  const re = tool.cornerRadius.mapOr(0, (q) => q.canonical)
  return Math.abs(re - (d.cornerRadius ?? 0)) <= MATCH_TOLERANCE
}

/** The library item the design's specific tool was taken from. */
export const isDesignTool = (item: LibraryItem, d: PlanDesignTool): boolean =>
  d.specific !== undefined && item.id === d.specific.libraryItemId
