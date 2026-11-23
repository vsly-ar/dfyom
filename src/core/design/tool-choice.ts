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
import { TOOL_MATCH_TOLERANCE, type DfmTool, type OperationTool } from '../geometry/dfm'
import { localStock } from '../geometry/face'
import type { Region2dPort } from '../geometry/2d/port'
import {
  CHAMFER_ANGLE_TOLERANCE,
  isAnalyticOperation,
  type OperationGeometry,
  type PartGeometryInput,
  type StockGeometry,
} from '../geometry/model'
import { FIT_SLACK, shapeMeasure, type ShapeMeasure } from '../geometry/shape-measure'
import { toolFit, type ToolUnfit } from '../geometry/tool-fit'
import { MATERIAL_CLASS_WORDS, type MaterialClass } from '../library/item'
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
      ...(hasPreset ? [`has a preset for ${MATERIAL_CLASS_WORDS[input.materialClass]}`] : []),
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

/** One library tool that can make the operation's kind but fails another fit rule. */
export interface LibraryMiss {
  readonly item: LibraryItem
  readonly tool: Tool
  /** The failed fit rule (never `type`). */
  readonly unfit: ToolUnfit
}

/**
 * The library tools of a type that can make the operation (the fit table's `type` row passes)
 * which fail another rule (size, corner, floor radius, reach, chamfer angle …), nearest to
 * `diameter` (mm; the generalized or current tool's) first, then smaller, then library id; by
 * diameter when none is given. The tool field lists them below the fitting ones: picking one is
 * the user's explicit choice (it locks, and `dfm.toolUnfit` says what does not fit).
 */
export function unfitLibraryTools(input: ChoiceInput, diameter?: number): LibraryMiss[] {
  const out: LibraryMiss[] = []
  for (const item of input.library) {
    const tool = item.values
    if (!(tool instanceof Tool)) continue
    const unfit = fitOf(dfmTool(tool), input)
    if (unfit === undefined || unfit.rule === 'type') continue
    out.push({ item, tool, unfit })
  }
  const away = (t: Tool) =>
    diameter === undefined ? t.diameter.canonical : Math.abs(t.diameter.canonical - diameter)
  return out.sort(
    (a, b) =>
      away(a.tool) - away(b.tool) ||
      a.tool.diameter.canonical - b.tool.diameter.canonical ||
      a.item.id.localeCompare(b.item.id),
  )
}

/** How far a near match may be from the generalized tool: 20 % of its diameter. */
export const NEAR_MATCH_SHARE = 0.2

/**
 * The library tool to offer for a generalized tool the library lacks (`dfm.toolNotInLibrary`):
 * none when a tool matches it (type and diameter, RE for a bull nose, within 0.01 mm: the plan
 * takes that one), else a tool of its type within `NEAR_MATCH_SHARE` of its diameter, with the
 * same RE (bull nose, 0.01 mm) or angle (chamfer mill, 0.5°): one that fits the operation first,
 * then the nearest in diameter, then library id. Offered only, never taken automatically: another Ø changes what the operation cuts
 * (a slot is as wide as its tool), so the user picks it (design-v0.2.md § Near match).
 */
export function nearLibraryTool(g: GeneralizedTool, input: ChoiceInput): Option<LibraryItem> {
  const t = generalizedDfmTool(g)
  const near = (a: number | undefined, b: number | undefined, tol = TOOL_MATCH_TOLERANCE) =>
    Math.abs((a ?? 0) - (b ?? 0)) <= tol
  const kin: { item: LibraryItem; d: DfmTool; fits: number }[] = []
  for (const item of input.library) {
    if (!(item.values instanceof Tool)) continue
    const d = dfmTool(item.values)
    if (d.type !== t.type) continue
    if (t.type === 'bullNoseEndMill' && !near(d.cornerRadius, t.cornerRadius)) continue
    if (t.type === 'chamferMill' && !near(d.angle, t.angle, CHAMFER_ANGLE_TOLERANCE)) continue
    if (near(d.diameter, t.diameter)) return None
    if (Math.abs(d.diameter - t.diameter) > NEAR_MATCH_SHARE * t.diameter) continue
    kin.push({ item, d, fits: fitOf(d, input) === undefined ? 0 : 1 })
  }
  kin.sort(
    (a, b) =>
      a.fits - b.fits ||
      Math.abs(a.d.diameter - t.diameter) - Math.abs(b.d.diameter - t.diameter) ||
      a.item.id.localeCompare(b.item.id),
  )
  return kin.length === 0 ? None : Some(kin[0]!.item)
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
