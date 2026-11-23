/**
 * The operation tool field at work: resolving a design tool for the DFM rules and the fit table,
 * the auto choice (keep if it fits → best fitting library tool → largest fitting generalized tool
 * of the standard series) and the candidates list. Pure: the library arrives as items.
 * General shapes (v0.3 K4) are measured with the 2D port (`shapeMeasure`): fit by the region's
 * width and inside corners, and fitting tools that leave no rest material rank first.
 * Doc: docs/modes/design-v0.2.md#auto-choice, docs/modes/design-v0.2.md#commands-and-queries-v02,
 * docs/modes/design-v0.3.md#dfm-checks-for-shapes
 */
import { None, Some, type Option } from '../../shared/result'
import type { DfmTool, OperationTool } from '../geometry/dfm'
import { localStock } from '../geometry/face'
import type { Region2dPort } from '../geometry/2d/port'
import {
  isAnalyticOperation,
  type OperationGeometry,
  type PartGeometryInput,
  type StockGeometry,
} from '../geometry/model'
import { FIT_SLACK, shapeMeasure, type ShapeMeasure } from '../geometry/shape-measure'
import { toolFit, type ToolUnfit } from '../geometry/tool-fit'
import type { MaterialClass } from '../library/item'
import type { LibraryItem } from '../library/library-item'
import { snapshotFromRecord } from './frozen-memo'
import { Tool } from '../library/tool'
import { isEndMillType, type ToolType } from '../library/tool.dto'
import type { ProjectDoc, UnitSystem } from '../project/document'
import { Quantity } from '../quantity/quantity'
import type { Operation } from './operation'
import {
  CHAMFER_MILL_STANDARD,
  designToolLabel,
  plainLength,
  STANDARD_SIZES,
  type DesignTool,
  type GeneralizedTool,
} from './tool'

/** A library tool reduced to what the DFM and fit rules need (canonical mm). */
export function dfmTool(tool: Tool): DfmTool {
  return {
    type: tool.type,
    diameter: tool.diameter.canonical,
    ...(tool.cornerRadius.isSome() && { cornerRadius: tool.cornerRadius.unwrap().canonical }),
    ...(tool.angle.isSome() && { angle: tool.angle.unwrap().canonical }),
    ...(tool.type === 'chamferMill' && { tipDiameter: tool.tipDiameterMm }),
    reach: tool.stickout.mapOr(tool.fluteLength.canonical, (s) => s.canonical),
  }
}

/** The library tool held by a tool snapshot of the document; None if missing or not a tool. */
export function snapshotTool(snapshots: ProjectDoc['snapshots'], id: string): Option<Tool> {
  const dto = Object.hasOwn(snapshots, id) ? snapshots[id] : undefined
  if (dto?.kind !== 'tool') return None
  const s = snapshotFromRecord(dto)
  return s.isOk() && s.unwrap().values instanceof Tool ? Some(s.unwrap().values as Tool) : None
}

/** A generalized tool as the fit and DFM rules see it: no lengths, so no reach. */
export function generalizedDfmTool(t: GeneralizedTool): DfmTool {
  return {
    type: t.type,
    diameter: t.diameter.canonical,
    ...(t.cornerRadius.isSome() && { cornerRadius: t.cornerRadius.unwrap().canonical }),
    ...(t.angle.isSome() && { angle: t.angle.unwrap().canonical }),
    // a generalized chamfer mill is pointed
    ...(t.type === 'chamferMill' && { tipDiameter: 0 }),
  }
}

/** The design tool for the rules (None: a specific tool whose snapshot does not load). */
export function resolveDesignTool(
  t: DesignTool,
  snapshots: ProjectDoc['snapshots'],
): Option<DfmTool> {
  if (t.kind === 'generalized') return Some(generalizedDfmTool(t))
  return snapshotTool(snapshots, t.snapshotId).map(dfmTool)
}

/** Each operation's tool for `parameterChecks` (operations without one are left out). */
export function operationTools(
  operations: readonly Operation[],
  snapshots: ProjectDoc['snapshots'],
): Record<string, OperationTool> {
  const out: Record<string, OperationTool> = {}
  for (const op of operations) {
    if (op.tool.isNone()) continue
    const t = op.tool.unwrap()
    const tool = resolveDesignTool(t, snapshots)
    if (tool.isNone()) continue
    const specific = t.kind === 'specific' ? snapshotTool(snapshots, t.snapshotId) : None
    out[op.id] = {
      tool: tool.unwrap(),
      generalized: t.kind === 'generalized',
      locked: op.toolLocked,
      label: designToolLabel(t, specific),
    }
  }
  return out
}

/** What the auto choice works with for one operation. */
export interface ChoiceInput {
  readonly op: Operation
  /** The operation resolved to mm in its face frame, and the part's stock geometry. */
  readonly geometry: OperationGeometry
  readonly stock: PartGeometryInput['stock']
  readonly units: UnitSystem
  readonly materialClass: MaterialClass
  /** The library's readable tool items. */
  readonly library: readonly LibraryItem[]
  readonly snapshots: ProjectDoc['snapshots']
  /** The 2D port for general shapes; absent = their size rules and rest material are skipped. */
  readonly region2d?: Region2dPort
  /**
   * Operations the same tool must also make (F7: the stepped chamfers on a drilling's mouth, so
   * the hole is bored by the end mill that cuts its terraces); absent = none.
   */
  readonly also?: readonly OperationGeometry[]
}

/** One fitting library tool, in auto-choice order. */
export interface LibraryCandidate {
  readonly item: LibraryItem
  readonly tool: Tool
  readonly hasPreset: boolean
  /** It leaves rest material in the operation's general shape (`dfm.restMaterial`). */
  readonly leavesRest: boolean
  readonly reasons: readonly string[]
}

export type ToolChoice =
  | { readonly kind: 'keep' }
  | { readonly kind: 'library'; readonly candidate: LibraryCandidate }
  | { readonly kind: 'generalized'; readonly tool: GeneralizedTool }
  /** Nothing fits at all: the current tool is kept and `dfm.toolUnfit` warns. */
  | { readonly kind: 'none' }

const metricOf = (units: UnitSystem) => (units === 'inch' ? 'inch' : 'metric')

function localOf(input: ChoiceInput): StockGeometry {
  return localStock(input.geometry.direction ?? '+z', input.stock)
}

/** The measures of the operation's general shape (cached per shape); undefined for v0.1 ones. */
export function measureOf(input: ChoiceInput): ShapeMeasure | undefined {
  const g = input.geometry
  if (input.region2d === undefined || (g.kind !== 'pocket' && g.kind !== 'profile'))
    return undefined
  return isAnalyticOperation(g) ? undefined : shapeMeasure(input.region2d, g)
}

/** The failed fit rule of a tool for the operation, or undefined when it fits. */
export function fitOf(tool: DfmTool, input: ChoiceInput): ToolUnfit | undefined {
  const own = toolFit(tool, input.geometry, localOf(input), metricOf(input.units), measureOf(input))
  if (own !== undefined) return own
  for (const g of input.also ?? []) {
    const unfit = toolFit(tool, g, localOf(input), metricOf(input.units))
    if (unfit !== undefined) return unfit
  }
  return undefined
}

/** Whether a fitting tool leaves rest material in the operation's general shape. */
export function leavesRest(tool: DfmTool, input: ChoiceInput): boolean {
  const m = measureOf(input)
  return (
    m !== undefined && isEndMillType(tool.type) && m.rest(tool.diameter / 2 - FIT_SLACK).length > 0
  )
}

/**
 * The library tools that fit, ranked: leaves no rest material (general shapes) → has a preset
 * for the stock's material class → largest diameter (fewer passes) → library id.
 */
export function fittingLibraryTools(input: ChoiceInput): LibraryCandidate[] {
  const out: LibraryCandidate[] = []
  for (const item of input.library) {
    const tool = item.values
    if (!(tool instanceof Tool)) continue
    const t = dfmTool(tool)
    if (fitOf(t, input) !== undefined) continue
    const hasPreset = tool.presets.some((p) =>
      p.materialClass.mapOr(false, (c) => c === input.materialClass),
    )
    const rest = leavesRest(t, input)
    const reasons = [
      ...(rest ? ['leaves rest material'] : []),
      ...(hasPreset ? [`has a preset for ${input.materialClass}`] : []),
      `diameter ${tool.diameter.canonical} mm`,
    ]
    out.push({ item, tool, hasPreset, leavesRest: rest, reasons })
  }
  return out.sort(
    (a, b) =>
      Number(a.leavesRest) - Number(b.leavesRest) ||
      Number(b.hasPreset) - Number(a.hasPreset) ||
      b.tool.diameter.canonical - a.tool.diameter.canonical ||
      a.item.id.localeCompare(b.item.id),
  )
}

/**
 * The generalized tool the auto choice would pick: the largest standard size that fits (bull
 * nose with RE = `floorRadius`; drill with DC = the hole's diameter), for a general shape the
 * largest that fits and leaves no rest material if one does. None if nothing fits.
 */
export function generalizedChoice(input: ChoiceInput): Option<GeneralizedTool> {
  const { op, units } = input
  const plain = (q: Quantity) => plainLength(q.exact, units)
  const fits = (t: GeneralizedTool) => fitOf(generalizedDfmTool(t), input) === undefined
  if (op.kind === 'chamfer') {
    // the standard chamfer mill sizes at the chamfer's own angle (largest first: it plunges)
    const angle = Quantity.create({
      kind: 'angle',
      source: `${Number(op.angle.canonical.toFixed(4))}°`,
      defaultUnit: 'deg',
      exact: op.angle.exact,
      tolerance: None,
    }).unwrap()
    for (const size of [...CHAMFER_MILL_STANDARD.sizes[units]].reverse()) {
      const diameter = Quantity.parse(size, { kind: 'length', defaultUnit: 'mm' }).unwrap()
      const t: GeneralizedTool = {
        kind: 'generalized',
        type: 'chamferMill',
        diameter,
        cornerRadius: None,
        angle: Some(angle),
      }
      if (fits(t)) return Some(t)
    }
    return None
  }
  if (op.kind === 'drilling' && op.bottom !== 'flat') {
    const drill: GeneralizedTool = {
      kind: 'generalized',
      type: 'drill',
      diameter: plain(op.diameter),
      cornerRadius: None,
      angle: None,
    }
    if (fits(drill)) return Some(drill)
  }
  const bullNose = op.kind === 'pocket' && op.floorRadius.canonical > 0
  const type: ToolType = bullNose ? 'bullNoseEndMill' : 'flatEndMill'
  const cornerRadius: Option<Quantity> = bullNose ? Some(plain(op.floorRadius)) : None
  const sizes = STANDARD_SIZES[units]
  let fallback: Option<GeneralizedTool> = None
  for (let i = sizes.length - 1; i >= 0; i--) {
    const diameter = Quantity.parse(sizes[i]!, { kind: 'length', defaultUnit: 'mm' }).unwrap()
    const t: GeneralizedTool = { kind: 'generalized', type, diameter, cornerRadius, angle: None }
    // a bull nose needs RE < DC/2
    if (bullNose && cornerRadius.unwrap().canonical >= diameter.canonical / 2) continue
    if (!fits(t)) continue
    if (!leavesRest(generalizedDfmTool(t), input)) return Some(t)
    if (fallback.isNone()) fallback = Some(t)
  }
  return fallback
}

/**
 * The auto choice for one unlocked operation (design-v0.2.md § Auto choice): keep a current tool
 * that fits; otherwise the first fitting library tool; otherwise the largest fitting generalized
 * tool; nothing fits: `none` (the caller keeps the current tool).
 */
export function chooseTool(input: ChoiceInput): ToolChoice {
  const current = input.op.tool.andThen((t) => resolveDesignTool(t, input.snapshots))
  if (current.isSome() && fitOf(current.unwrap(), input) === undefined) return { kind: 'keep' }
  const library = fittingLibraryTools(input)
  if (library.length > 0) return { kind: 'library', candidate: library[0]! }
  const g = generalizedChoice(input)
  return g.isSome() ? { kind: 'generalized', tool: g.unwrap() } : { kind: 'none' }
}
