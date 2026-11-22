/**
 * The operation tool field at work: resolving a design tool for the DFM rules and the fit table,
 * the auto choice (keep if it fits → best fitting library tool → largest fitting generalized tool
 * of the standard series) and the candidates list. Pure: the library arrives as items.
 * Doc: docs/modes/design-v0.2.md#auto-choice, docs/modes/design-v0.2.md#commands-and-queries-v02
 */
import { None, Some, type Option } from '../../shared/result'
import type { DfmTool, OperationTool } from '../geometry/dfm'
import { localStock } from '../geometry/face'
import type { OperationGeometry, PartGeometryInput, StockGeometry } from '../geometry/model'
import { toolFit, type ToolUnfit } from '../geometry/tool-fit'
import type { MaterialClass } from '../library/item'
import type { LibraryItem } from '../library/library-item'
import { Snapshot } from '../library/snapshot'
import { Tool } from '../library/tool'
import type { ToolType } from '../library/tool.dto'
import type { ProjectDoc, UnitSystem } from '../project/document'
import { Quantity } from '../quantity/quantity'
import type { Operation } from './operation'
import {
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
    reach: tool.stickout.mapOr(tool.fluteLength.canonical, (s) => s.canonical),
  }
}

/** The library tool held by a tool snapshot of the document; None if missing or not a tool. */
export function snapshotTool(snapshots: ProjectDoc['snapshots'], id: string): Option<Tool> {
  const dto = Object.hasOwn(snapshots, id) ? snapshots[id] : undefined
  if (dto?.kind !== 'tool') return None
  const s = Snapshot.fromDTO(dto)
  return s.isOk() && s.unwrap().values instanceof Tool ? Some(s.unwrap().values as Tool) : None
}

/** A generalized tool as the fit and DFM rules see it: no lengths, so no reach. */
export function generalizedDfmTool(t: GeneralizedTool): DfmTool {
  return {
    type: t.type,
    diameter: t.diameter.canonical,
    ...(t.cornerRadius.isSome() && { cornerRadius: t.cornerRadius.unwrap().canonical }),
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
}

/** One fitting library tool, in auto-choice order. */
export interface LibraryCandidate {
  readonly item: LibraryItem
  readonly tool: Tool
  readonly hasPreset: boolean
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

/** The failed fit rule of a tool for the operation, or undefined when it fits. */
export function fitOf(tool: DfmTool, input: ChoiceInput): ToolUnfit | undefined {
  return toolFit(tool, input.geometry, localOf(input), metricOf(input.units))
}

/**
 * The library tools that fit, ranked: has a preset for the stock's material class → largest
 * diameter (fewer passes) → library id.
 */
export function fittingLibraryTools(input: ChoiceInput): LibraryCandidate[] {
  const out: LibraryCandidate[] = []
  for (const item of input.library) {
    const tool = item.values
    if (!(tool instanceof Tool) || fitOf(dfmTool(tool), input) !== undefined) continue
    const hasPreset = tool.presets.some((p) =>
      p.materialClass.mapOr(false, (c) => c === input.materialClass),
    )
    const reasons = [
      ...(hasPreset ? [`has a preset for ${input.materialClass}`] : []),
      `diameter ${tool.diameter.canonical} mm`,
    ]
    out.push({ item, tool, hasPreset, reasons })
  }
  return out.sort(
    (a, b) =>
      Number(b.hasPreset) - Number(a.hasPreset) ||
      b.tool.diameter.canonical - a.tool.diameter.canonical ||
      a.item.id.localeCompare(b.item.id),
  )
}

/**
 * The generalized tool the auto choice would pick: the largest standard size that fits (bull
 * nose with RE = `floorRadius`; drill with DC = the hole's diameter). None if nothing fits.
 */
export function generalizedChoice(input: ChoiceInput): Option<GeneralizedTool> {
  const { op, units } = input
  const plain = (q: Quantity) => plainLength(q.exact, units)
  const fits = (t: GeneralizedTool) => fitOf(generalizedDfmTool(t), input) === undefined
  if (op.kind === 'drilling' && op.bottom !== 'flat') {
    const drill: GeneralizedTool = {
      kind: 'generalized',
      type: 'drill',
      diameter: plain(op.diameter),
      cornerRadius: None,
    }
    if (fits(drill)) return Some(drill)
  }
  const bullNose = op.kind === 'pocket' && op.floorRadius.canonical > 0
  const type: ToolType = bullNose ? 'bullNoseEndMill' : 'flatEndMill'
  const cornerRadius: Option<Quantity> = bullNose ? Some(plain(op.floorRadius)) : None
  const sizes = STANDARD_SIZES[units]
  for (let i = sizes.length - 1; i >= 0; i--) {
    const diameter = Quantity.parse(sizes[i]!, { kind: 'length', defaultUnit: 'mm' }).unwrap()
    const t: GeneralizedTool = { kind: 'generalized', type, diameter, cornerRadius }
    // a bull nose needs RE < DC/2
    if (bullNose && cornerRadius.unwrap().canonical >= diameter.canonical / 2) continue
    if (fits(t)) return Some(t)
  }
  return None
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
