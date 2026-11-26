/**
 * The operation tool field at work: resolving a design tool for the DFM rules and the fit table,
 * the auto choice (keep if it fits → best fitting library tool → largest fitting generalized tool
 * of the standard series) and the candidates list. Pure: the library arrives as items.
 * General shapes (v0.3 K4) are measured with the 2D port (`shapeMeasure`): fit by the region's
 * width and inside corners, and fitting tools that leave no rest material rank first.
 * Corners and rest material that lie wholly in the face's waste (offcut and frame of through
 * profiles, D4) do not count, as for the DFM checks (`faceWaste`).
 * Doc: docs/modes/design-v0.2.md#auto-choice, docs/modes/design-v0.2.md#commands-and-queries-v02,
 * docs/modes/design-v0.3.md#dfm-checks-for-shapes, docs/modes/design-llm-first.md#rule-as-built-d4-slice-lf3
 */
import { None, Some, type Option } from '../../shared/result'
import { TOOL_MATCH_TOLERANCE, type DfmTool, type OperationTool } from '../geometry/dfm'
import { localStock, type Direction } from '../geometry/face'
import type { Region2dPort } from '../geometry/2d/port'
import { DEFAULT_LINE_CUTTER } from '../geometry/line'
import {
  CHAMFER_ANGLE_TOLERANCE,
  isAnalyticOperation,
  type LineCutter,
  type OperationGeometry,
  type PartGeometryInput,
  type StockGeometry,
} from '../geometry/model'
import { FIT_SLACK, shapeMeasure, type ShapeMeasure } from '../geometry/shape-measure'
import { shankClears, toolFit, type ToolUnfit } from '../geometry/tool-fit'
import { faceWaste, type FaceWaste } from '../geometry/waste'
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
    fluteLength: tool.fluteLength.canonical,
    ...(tool.shankDiameter.isSome() && { shankDiameter: tool.shankDiameter.unwrap().canonical }),
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
  /**
   * The waste of the operation's face (D4, `faceWaste`): corners and rest material wholly in it
   * do not count for fit and ranking; absent = nothing is waste.
   */
  readonly waste?: FaceWaste
}

/**
 * The waste of an operation's face in a part (`faceWaste`, built on first use per direction), for
 * `ChoiceInput.waste`: docs/modes/design-llm-first.md#rule-as-built-d4-slice-lf3.
 */
export function partWaste(
  input: PartGeometryInput,
  port: Region2dPort | undefined,
): (op: OperationGeometry) => FaceWaste | undefined {
  const cache = new Map<Direction, FaceWaste | undefined>()
  return (op) => {
    const d = op.direction ?? '+z'
    if (!cache.has(d)) cache.set(d, faceWaste(input.operations, d, input.stock, port))
    return cache.get(d)
  }
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
  // a pocket on the stock edge is measured with its open sides (DF61)
  return isAnalyticOperation(g) ? undefined : shapeMeasure(input.region2d, g, localOf(input))
}

/** The failed fit rule of a tool for the operation, or undefined when it fits. */
export function fitOf(tool: DfmTool, input: ChoiceInput): ToolUnfit | undefined {
  const own = toolFit(
    tool,
    input.geometry,
    localOf(input),
    metricOf(input.units),
    measureOf(input),
    input.waste,
  )
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
  // DF108: every roughing tool of a pattern leaves rest (the pattern's pocket cuts it)
  const g = input.geometry
  if ((g.kind === 'pocket' || g.kind === 'profile') && g.roughing === true) return false
  if (m === undefined || !isEndMillType(tool.type) || !('shape' in g)) return false
  const r = tool.diameter / 2 - FIT_SLACK
  const [cu, cv] = g.shape.center
  // pieces within the tool radius of waste only do not count (D4, as `dfm.restMaterial`)
  return m.rest(r).some((p) => !(input.waste?.covers([p.at[0] + cu, p.at[1] + cv], r) ?? false))
}

/**
 * Diameters within this share of a size's largest are one size (DF55): 6 mm and 1/4″ are 5.5 %
 * apart, the widest metric/inch pair of the standard series; 6.22 and 6.31 mm are one 1/4″ size.
 */
export const SIZE_SHARE = 0.06

/**
 * The size class of each diameter (mm), 0 = the largest: sorted from the largest, a diameter
 * starts a new class when it is more than `SIZE_SHARE` below its class's largest (transitive,
 * so it can rank a sort).
 */
export function sizeClasses(diameters: readonly number[]): Map<number, number> {
  const out = new Map<number, number>()
  let cls = -1
  let top = Number.POSITIVE_INFINITY
  for (const d of [...new Set(diameters)].sort((a, b) => b - a)) {
    if (d < top * (1 - SIZE_SHARE)) {
      cls++
      top = d
    }
    out.set(d, cls)
  }
  return out
}

/** How far a library tool reaches (mm): its stickout, else its flute length. */
export const toolReach = (tool: Tool): number =>
  tool.stickout.mapOr(tool.fluteLength.canonical, (s) => s.canonical)

/**
 * "stickout 31 mm" / "flute length 25 mm": the reach as a candidate's reason (DF55); with a
 * stickout, a wall-following cut (pocket, profile, hole) whose walls need the flutes adds
 * "flute length 50 mm" (DF89).
 */
function reachReasons(tool: Tool, input: ChoiceInput): string[] {
  const n = (v: number) => Number(v.toFixed(3))
  const flutes = `flute length ${n(tool.fluteLength.canonical)} mm`
  if (tool.stickout.isNone()) return [flutes]
  const walls = input.geometry.kind !== 'facing' && input.geometry.kind !== 'chamfer'
  return [
    `stickout ${n(tool.stickout.unwrap().canonical)} mm`,
    ...(walls && !shankClears(dfmTool(tool)) ? [flutes] : []),
  ]
}

/**
 * The library tools that fit, ranked (design-v0.2.md § Auto choice): leaves no rest material
 * (general shapes) → has a preset for the stock's material class → largest size (`sizeClasses`:
 * fewer passes) → shortest reach (stickout, else flute length; every fitting tool reaches, the
 * shortest is the stiffest, DF55) → larger diameter → library id. Fitting includes the flute rule
 * (DF89): a tool whose flutes do not cut the walls' depth is never auto-chosen.
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
      ...reachReasons(tool, input),
    ]
    out.push({ item, tool, hasPreset, leavesRest: rest, reasons })
  }
  const size = sizeClasses(out.map((c) => c.tool.diameter.canonical))
  const cls = (c: LibraryCandidate) => size.get(c.tool.diameter.canonical) ?? 0
  // a Line's default tool is a V-bit (engraved-patterns.md § Tools): chamfer mills first
  const vBit = (c: LibraryCandidate) =>
    input.op.kind === 'line' && c.tool.type === 'chamferMill' ? 0 : 1
  return out.sort(
    (a, b) =>
      vBit(a) - vBit(b) ||
      Number(a.leavesRest) - Number(b.leavesRest) ||
      Number(b.hasPreset) - Number(a.hasPreset) ||
      cls(a) - cls(b) ||
      toolReach(a.tool) - toolReach(b.tool) ||
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
 * The generalized tools the auto choice tries, in its order: a chamfer's standard chamfer mills
 * at its angle (largest first: it plunges), a Line's at 60°; a pointed hole's drill of its diameter; then end mills
 * of the standard sizes, largest first (bull nose with RE = `floorRadius`, only sizes with
 * RE < DC/2).
 */
function generalizedCandidates(input: ChoiceInput): GeneralizedTool[] {
  const { op, units } = input
  const plain = (q: Quantity) => plainLength(q.exact, units)
  const out: GeneralizedTool[] = []
  if (op.kind === 'chamfer' || op.kind === 'line') {
    // a Line's generalized tool is a 60° V-bit (engraved-patterns.md § Tools)
    const angle =
      op.kind === 'line'
        ? Quantity.parse('60°', { kind: 'angle', defaultUnit: 'deg' }).unwrap()
        : Quantity.create({
            kind: 'angle',
            source: `${Number(op.angle.canonical.toFixed(4))}°`,
            defaultUnit: 'deg',
            exact: op.angle.exact,
            tolerance: None,
          }).unwrap()
    for (const size of [...CHAMFER_MILL_STANDARD.sizes[units]].reverse()) {
      const diameter = Quantity.parse(size, { kind: 'length', defaultUnit: 'mm' }).unwrap()
      out.push({
        kind: 'generalized',
        type: 'chamferMill',
        diameter,
        cornerRadius: None,
        angle: Some(angle),
      })
    }
    return out
  }
  if (op.kind === 'drilling' && op.bottom !== 'flat')
    out.push({
      kind: 'generalized',
      type: 'drill',
      diameter: plain(op.diameter),
      cornerRadius: None,
      angle: None,
    })
  const bullNose = op.kind === 'pocket' && op.floorRadius.canonical > 0
  const type: ToolType = bullNose ? 'bullNoseEndMill' : 'flatEndMill'
  const cornerRadius: Option<Quantity> = bullNose ? Some(plain(op.floorRadius)) : None
  const sizes = STANDARD_SIZES[units]
  for (let i = sizes.length - 1; i >= 0; i--) {
    const diameter = Quantity.parse(sizes[i]!, { kind: 'length', defaultUnit: 'mm' }).unwrap()
    // a bull nose needs RE < DC/2
    if (bullNose && cornerRadius.unwrap().canonical >= diameter.canonical / 2) continue
    out.push({ kind: 'generalized', type, diameter, cornerRadius, angle: None })
  }
  return out
}

/**
 * The generalized tool the auto choice would pick: the largest standard size that fits (bull
 * nose with RE = `floorRadius`; drill with DC = the hole's diameter), for a general shape the
 * largest that fits and leaves no rest material if one does. None if nothing fits.
 */
export function generalizedChoice(input: ChoiceInput): Option<GeneralizedTool> {
  let fallback: Option<GeneralizedTool> = None
  for (const t of generalizedCandidates(input)) {
    if (fitOf(generalizedDfmTool(t), input) !== undefined) continue
    // a chamfer mill and a drill: the first that fits
    if (t.type === 'chamferMill' || t.type === 'drill') return Some(t)
    if (!leavesRest(generalizedDfmTool(t), input)) return Some(t)
    if (fallback.isNone()) fallback = Some(t)
  }
  return fallback
}

/** Why no tool at all fits an operation (DF52): the blocking rule and the tool it was found with. */
export interface NoFit {
  readonly unfit: ToolUnfit
  /** The smallest generalized tool the auto choice tries ("1 mm flat end mill"). */
  readonly tool: GeneralizedTool
}

/**
 * `dfm.noFittingTool`'s cause (design-v0.2.md § Tool choice fixes, DF52): undefined when a tool
 * of `tools` (the library, as the DFM sees it) or a generalized tool of the standard sizes fits;
 * else the failed rule of the smallest generalized tool the auto choice tries (the most lenient
 * one), so the text names what blocks every tool. A bull nose with RE ≥ every DC/2 is judged with
 * the smallest flat end mill (its floor-radius rule).
 */
export function noFittingTool(input: ChoiceInput, tools: readonly DfmTool[]): NoFit | undefined {
  if (tools.some((t) => fitOf(t, input) === undefined)) return undefined
  if (generalizedChoice(input).isSome()) return undefined
  const tried = generalizedCandidates(input)
  const smallest: GeneralizedTool =
    tried.length > 0
      ? tried[tried.length - 1]!
      : {
          kind: 'generalized',
          type: 'flatEndMill',
          diameter: Quantity.parse(STANDARD_SIZES[input.units][0]!, {
            kind: 'length',
            defaultUnit: 'mm',
          }).unwrap(),
          cornerRadius: None,
          angle: None,
        }
  const unfit = fitOf(generalizedDfmTool(smallest), input)
  return unfit === undefined ? undefined : { unfit, tool: smallest }
}

/**
 * The slot width a new profile takes instead of the default (DF51, design-v0.2.md § Tool choice
 * fixes), as a source in the project units: None when a library tool fits the profile as given
 * (`input.geometry`, with the default slot); else the narrowest library flat end mill wider than
 * the slot that fits with the slot as wide as its Ø rounded up in the project units
 * (`roundUpLength`); None when none does.
 */
export function defaultSlotWidth(input: ChoiceInput): Option<string> {
  const g = input.geometry
  if (g.kind !== 'profile') return None
  if (fittingLibraryTools(input).length > 0) return None
  const wider = input.library
    .flatMap((item) => (item.values instanceof Tool ? [{ item, tool: item.values }] : []))
    .filter((c) => c.tool.type === 'flatEndMill' && c.tool.diameter.canonical > g.slotWidth)
    .sort(
      (a, b) =>
        a.tool.diameter.canonical - b.tool.diameter.canonical ||
        toolReach(a.tool) - toolReach(b.tool) ||
        a.item.id.localeCompare(b.item.id),
    )
  for (const { tool } of wider) {
    const width = roundUpLength(tool.diameter.canonical, input.units)
    const widened: ChoiceInput = { ...input, geometry: { ...g, slotWidth: width } }
    if (fitOf(dfmTool(tool), widened) === undefined)
      return Some(lengthSourceUp(tool.diameter.canonical, input.units))
  }
  return None
}

/** Input steps per mm of a length rounded for the project units: 0.01 mm, 0.001″. */
const STEPS_PER_MM: Record<UnitSystem, number> = { mm: 100, inch: 1000 / 25.4 }

/**
 * A length (mm) rounded up to the project units' step (0.01 mm, 0.001″), in mm; as the
 * renderer's "Widen slot to …" rounds (messages/dfm.ts `lengthSource` 'up').
 */
export function roundUpLength(mm: number, units: UnitSystem): number {
  // a tiny slack, so 6.2200000001 stays 6.22
  return Math.ceil(mm * STEPS_PER_MM[units] - 1e-6) / STEPS_PER_MM[units]
}

/** `roundUpLength` as a source in the project units: "6.22 mm", `0.245"`. */
export function lengthSourceUp(mm: number, units: UnitSystem): string {
  if (units === 'inch') return `${Math.ceil((mm / 25.4) * 1000 - 1e-6) / 1000}"`
  return `${Math.ceil(mm * 100 - 1e-6) / 100} mm`
}

/**
 * Whether the operation's tool is a specific tool whose library item is no longer among the
 * readable library tools (removed, or it does not load): X2 F6, design-v0.2.md § Library changes
 * and opening. Its snapshot still describes the tool.
 */
export function orphanTool(input: ChoiceInput): boolean {
  if (input.op.tool.isNone()) return false
  const t = input.op.tool.unwrap()
  if (t.kind !== 'specific') return false
  const snap = Object.hasOwn(input.snapshots, t.snapshotId)
    ? input.snapshots[t.snapshotId]
    : undefined
  const itemId = snap !== undefined && snap.kind === 'tool' ? snap.libraryItemId : undefined
  return itemId !== undefined && !input.library.some((i) => i.id === itemId)
}

/**
 * The auto choice for one unlocked operation (design-v0.2.md § Auto choice): keep a current tool
 * that fits (a generalized one, or one removed from the library, only while no library tool
 * fits: DF54, X2 F6); otherwise the first fitting library tool; otherwise the largest fitting
 * generalized tool; nothing fits: `none` (the caller keeps the current tool).
 */
export function chooseTool(input: ChoiceInput): ToolChoice {
  const current = input.op.tool.andThen((t) => resolveDesignTool(t, input.snapshots))
  const fits = current.isSome() && fitOf(current.unwrap(), input) === undefined
  // DF54: a fitting generalized tool is kept only while no library tool fits; X2 F6: so is a
  // library tool removed from the library
  const generalized = input.op.tool.mapOr(false, (t) => t.kind === 'generalized')
  if (fits && !generalized && !orphanTool(input)) return { kind: 'keep' }
  const library = fittingLibraryTools(input)
  if (library.length > 0) return { kind: 'library', candidate: library[0]! }
  if (fits) return { kind: 'keep' }
  const g = generalizedChoice(input)
  return g.isSome() ? { kind: 'generalized', tool: g.unwrap() } : { kind: 'none' }
}

/**
 * The tool a Line's groove takes (engraved-patterns.md § Line operation): its tool field's chamfer
 * mill (V-bit), ball or flat end mill; else (auto with nothing chosen, another type, a snapshot
 * that does not resolve) the default 60° V-bit.
 */
export function lineCutter(op: Operation, snapshots?: ProjectDoc['snapshots']): LineCutter {
  if (op.tool.isNone()) return DEFAULT_LINE_CUTTER
  const t = resolveDesignTool(op.tool.unwrap(), snapshots ?? {})
  if (t.isNone()) return DEFAULT_LINE_CUTTER
  const tool = t.unwrap()
  if (tool.type === 'chamferMill' && tool.angle !== undefined)
    return {
      kind: 'vBit',
      diameter: tool.diameter,
      angle: tool.angle,
      tipDiameter: tool.tipDiameter ?? 0,
    }
  if (tool.type === 'ballEndMill') return { kind: 'ball', diameter: tool.diameter }
  if (tool.type === 'flatEndMill') return { kind: 'flat', diameter: tool.diameter }
  return DEFAULT_LINE_CUTTER
}
