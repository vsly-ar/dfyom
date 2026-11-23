// DFM warning catalogue (task 3.6): text re-rendered from `code` + `params` with values in the
// project unit system; the core's English `message` (mm) is the fallback. Core `info` → soft
// warning, `warning` → hard warning (ui.md decision 21). Doc: docs/conventions/ui.md#warnings-and-dfm,
// docs/modes/design.md#dfm-checks, codes: src/core/geometry/model.ts (DFM_WARNING_CODES)
import type { DfmWarning, DfmWarningCode } from '../../../core/geometry/model'
import type { UnitSystem } from '../../../core/project/document'

/** Decimals of a length in DFM text and suggestions. */
const DECIMALS: Record<UnitSystem, number> = { mm: 2, inch: 3 }

function round(value: number, decimals: number, mode: 'nearest' | 'up' | 'down'): number {
  const f = 10 ** decimals
  const v = value * f
  // a tiny slack, so 3.2000000001 is not rounded up to 3.21
  const r =
    mode === 'up' ? Math.ceil(v - 1e-6) : mode === 'down' ? Math.floor(v + 1e-6) : Math.round(v)
  return r / f
}

/** A length (mm) as a source in the project unit system: "3.2 mm", `0.126"`. */
export function lengthSource(
  mm: number,
  units: UnitSystem,
  mode: 'nearest' | 'up' | 'down' = 'nearest',
): string {
  if (units === 'mm') return `${round(mm, DECIMALS.mm, mode)} mm`
  return `${round(mm / 25.4, DECIMALS.inch, mode)}"`
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN)

/** "front", "right", … for stock face surface ids. */
const SIDE: Readonly<Record<string, string>> = {
  'stock.top': 'top',
  'stock.bottom': 'bottom',
  'stock.side[0]': 'front',
  'stock.side[1]': 'right',
  'stock.side[2]': 'back',
  'stock.side[3]': 'left',
}

const list = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

/**
 * A retained region of `dfm.retainedRemoved` by name ("the floor fillet", "tab 2"), never its key
 * (`floorFillet`, `tab[1]`; src/core/geometry/operations.ts) (DF43).
 */
const regionName = (key: string): string => {
  const tab = /^tab\[(\d+)\]$/.exec(key)
  if (tab) return `tab ${Number(tab[1]) + 1}`
  return key === 'floorFillet' ? 'the floor fillet' : 'a retained region'
}

/** A Clones warning's instance numbers: "3, 7 and 12". */
const numbers = (p: DfmWarning['params']): string =>
  list(((p['numbers'] as readonly number[] | undefined) ?? []).map(String))

/**
 * Readable names of the ids a finding's params carry (DF43: visible text never shows an id):
 * `item` an operation or feature id, `surface` a surface id ("Pocket 1 floor").
 */
export interface DfmNames {
  readonly item: (id: string) => string
  readonly surface: (id: string) => string
}

type Render = (p: DfmWarning['params'], L: (mm: unknown) => string, name: DfmNames) => string

const TEXT: Readonly<Record<DfmWarningCode, Render>> = {
  'dfm.loosePiece': (p) =>
    p['offcut'] === true
      ? 'An offcut is not held and comes loose. Add tabs or make them thicker.'
      : 'A piece of the part is not held and comes loose. Check the cut that separates it.',
  'dfm.retainedRemoved': (p, _L, name) => {
    const by = typeof p['by'] === 'string' ? name.item(p['by']) : 'Another operation'
    const regions = ((p['regions'] as readonly string[] | undefined) ?? []).map(regionName)
    return `${by} cuts away ${regions.length > 0 ? list(regions) : 'retained regions'} of this operation. Move one of them.`
  },
  'dfm.surfaceMissing': (p, _L, name) =>
    `It starts from or refers to ${typeof p['surface'] === 'string' ? name.surface(p['surface']) : 'a surface'}, which the part no longer has. Pick another surface.`,
  'dfm.facingDeep': (p, L) =>
    `A facing depth of ${L(p['depth'])} removes a lot of material. Check the stock thickness.`,
  'dfm.pocketNoToolFits': (p, L) =>
    `No tool fits: the pocket is ${L(p['narrowest'])} at its narrowest, the smallest end mill in the library ${L(p['toolDiameter'])}.`,
  'dfm.pocketDeepNarrow': (p, L) =>
    `Deep, narrow pocket: ${L(p['depth'])} deep and ${L(p['narrowest'])} at its narrowest. It needs a long tool.`,
  // v0.3 shapes: one warning per corner up to 10, then one with `more` (design-v0.3.md § DFM)
  'dfm.cornerSharp': (p) =>
    typeof p['more'] === 'number'
      ? `${num(p['more'])} more inside corners are too sharp for a round tool.`
      : 'A sharp inside corner cannot be cut by a round tool.',
  'dfm.cornerTooSmall': (p, L) =>
    typeof p['more'] === 'number'
      ? `${num(p['more'])} more inside corners are tighter than the smallest end mill in the library (radius ${L(p['toolRadius'])}).`
      : `No tool can make this corner: the smallest end mill in the library has a radius of ${L(p['toolRadius'])}.`,
  'dfm.floorRadiusNoTool': (p, L) =>
    `The library has no bull-nose end mill with a corner radius of ${L(p['floorRadius'])} and no ball end mill with a radius of ${L(p['floorRadius'])} or less.`,
  'dfm.holeOutsideStock': () => 'The hole lies partly outside the stock.',
  'dfm.holeNoTool': (p, L) =>
    `The library has no drill of Ø${L(p['diameter'])} and no end mill smaller than it to bore the hole.`,
  'dfm.holeDeep': (p, L) =>
    `The hole is ${L(p['depth'])} deep at Ø${L(p['diameter'])}. It needs pecking or a long drill.`,
  'dfm.slotLeavesStock': (p, L) =>
    `The slot leaves the stock on every side (stock margin ${L(p['margin'])}, slot width ${L(p['slotWidth'])}), so the tabs hold nothing.`,
  'dfm.slotOpensStock': (p, L) =>
    `The slot runs out of the stock at the ${list(((p['sides'] as readonly string[] | undefined) ?? []).map((s) => SIDE[s] ?? s))} (stock margin ${L(p['margin'])}). The frame still holds the tabs on the other sides.`,
  'dfm.slotNoTool': (p, L) =>
    `The slot width ${L(p['slotWidth'])} is smaller than the smallest end mill in the library (${L(p['toolDiameter'])}).`,
  'dfm.tabsNone': () => 'No tabs: the piece comes loose at the last pass.',
  'dfm.tabsUnused': () =>
    'The slot covers the whole opening, so it is cut out completely and the tabs are not built.',
  'dfm.tabsThin': (p, L) =>
    p['thickness'] !== undefined
      ? `Tabs ${L(p['thickness'])} thick are too thin to hold the piece.`
      : `Tabs ${L(p['width'])} wide are too narrow to hold the piece.`,
  // v0.4 TB1 (design-v0.4.md § Tabs relocate off free sides)
  'dfm.tabsRelocated': (p) =>
    `${num(p['moved'])} of ${num(p['count'])} tabs moved off sides where the slot leaves no stock beyond the cut.`,
  'dfm.tabsNoHold': (p) =>
    Array.isArray(p['indices'])
      ? `${num(p['count']) - num(p['held'])} of ${num(p['count'])} tabs lie where the slot leaves no stock beyond the cut, so they hold nothing. Move them to a side with stock.`
      : `Only ${num(p['held'])} of ${num(p['count'])} tabs fit where stock remains beyond the slot. The others hold nothing: use fewer tabs or a larger stock.`,
  'dfm.reach': (p, L) =>
    `No tool in the library reaches ${L(p['depth'])} deep from the stock face (longest ${L(p['reach'])}).`,
  'dfm.setups': (p) =>
    `The part needs ${num(p['count'])} setups (${list((p['directions'] as readonly string[] | undefined) ?? [])}).`,
  // the operation's own tool (v0.2, shown at the tool field: task F5)
  'dfm.toolUnfit': (p, L) =>
    toolUnfitText(p, L) + (p['locked'] === true ? ' Unlock it or pick another tool.' : ''),
  'dfm.toolNotInLibrary': (p) => `Plan needs a ${String(p['tool'])}: add one to the library.`,
  // no tool fits at all (hardening DF52): the blocking rule, worded for the smallest standard tool
  'dfm.noFittingTool': (p, L) =>
    `No tool fits this operation, not even the smallest standard one. ${toolUnfitText(p, L)}`,
  // v0.3 shapes (design-v0.3.md § DFM checks for shapes)
  'dfm.restMaterial': (p) =>
    num(p['pieces']) > 1
      ? `The ${String(p['tool'])} leaves material uncut in ${num(p['pieces'])} places narrower than the tool.`
      : `The ${String(p['tool'])} leaves material uncut in a neck narrower than the tool.`,
  'dfm.shapeOutsideFace': (p, L) =>
    `The shape reaches ${L(p['by'])} outside the stock face at the ${list(((p['sides'] as readonly string[] | undefined) ?? []).map((s) => SIDE[s] ?? s))}.`,
  'dfm.shapeHeavy': (p) =>
    `This shape has ${num(p['chords'])} segments after flattening, so the part updates more slowly.`,
  'dfm.holeCustomSize': (p, L) => {
    const v = (x: unknown) => (p['field'] === 'csAngle' ? `${num(x)}°` : L(x))
    return `${HOLE_FIELD[String(p['field'])] ?? 'A size'} ${v(p['value'])} differs from the ${typeof p['fastener'] === 'string' ? `${p['fastener']} ` : ''}table value ${v(p['table'])} (custom).`
  },
  'dfm.countersinkStepped': (p, L) =>
    `Stepped countersink: ${num(p['terraces'])} steps of ${L(p['stepdown'])} cut by the hole's end mill. The screw head seats on the step corners and hides the steps.`,
  // v0.4 Clones (features.md § Checks and DFM)
  'dfm.cloneOutsideStock': (p) =>
    `${num(p['count'])} clones lie outside the stock (${numbers(p)}): skip them or shorten a row.`,
  'dfm.cloneDuplicate': (p) =>
    `${num(p['count'])} positions sit on an earlier instance and are left out (${numbers(p)}).`,
  'dfm.cloneOverlap': (p) => `Instances ${numbers(p)} overlap.`,
  'dfm.clonesHeavy': (p) =>
    `${num(p['operations'])} cloned operations: the part updates more slowly.`,
  // v0.4 chamfer (design-v0.4.md § Chamfer operation)
  'dfm.chamferTooDeep': (p, L, name) => {
    const edge = name.item(String(p['edgeOf']))
    return p['floor'] === 1
      ? `The chamfer is ${L(p['depth'])} deep and cuts through the ${L(p['edgeDepth'])} floor above ${edge}.`
      : `The chamfer is ${L(p['depth'])} deep, deeper than ${edge} (${L(p['edgeDepth'])}).`
  },
  'dfm.chamferNoTool': (p, L) =>
    p['stepped'] === 1
      ? `The library has no flat end mill smaller than Ø${L(p['edgeDiameter'])} for the stepped countersink.`
      : `The library has no ${num(p['angle'])}° chamfer mill that cuts Ø${L(p['edgeDiameter'])} to Ø${L(p['diameter'])}.`,
}

/** Hole feature size fields in `dfm.holeCustomSize`. */
const HOLE_FIELD: Readonly<Record<string, string>> = {
  diameter: 'Hole Ø',
  cbDiameter: 'Counterbore Ø',
  cbDepth: 'Counterbore depth',
  csDiameter: 'Countersink Ø',
  csAngle: 'Countersink angle',
}

/** What a tool type rule asks for (`params.needs` of `dfm.toolUnfit`). */
const NEEDS: Readonly<Record<string, string>> = {
  flatEndMill: 'a flat end mill',
  endMill: 'a flat or bull-nose end mill',
  drillOrFlat: 'a drill or a flat end mill',
}

/**
 * `dfm.toolUnfit` by its failed fit rule, from the rule's values (mm) in the project units
 * (design-v0.2.md § DFM with the tool; values: src/core/geometry/tool-fit.ts `ToolUnfit.values`).
 */
function toolUnfitText(p: DfmWarning['params'], L: (mm: unknown) => string): string {
  const tool = String(p['tool'])
  const has = (k: string) => typeof p[k] === 'number'
  switch (p['rule']) {
    case 'cornerRadius':
      if (has('cornerRadius'))
        return `Corner radius ${L(p['cornerRadius'])} is smaller than the radius of the ${tool} (${L(p['toolRadius'])}).`
      break
    case 'width':
      if (has('size'))
        return p['feature'] === 'slot'
          ? `The ${tool} is wider than the slot (${L(p['size'])}).`
          : `The ${tool} is wider than the pocket at its narrowest (${L(p['size'])}).`
      break
    case 'floorRadius':
      if (has('floorRadius'))
        return num(p['floorRadius']) > 0
          ? `Floor radius ${L(p['floorRadius'])} needs a bull-nose end mill with corner radius ${L(p['floorRadius'])}; the ${tool} does not have it.`
          : `The ${tool} leaves a ${L(p['toolCornerRadius'])} fillet on the floor; the floor radius is 0.`
      break
    case 'diameter':
      if (has('holeDiameter'))
        return p['boring'] === true
          ? `Helical boring of the Ø ${L(p['holeDiameter'])} hole needs an end mill between Ø ${L(num(p['holeDiameter']) / 2)} and Ø ${L(p['holeDiameter'])}; the ${tool} is not.`
          : `The ${tool} does not match the Ø ${L(p['holeDiameter'])} hole.`
      if (has('edgeDiameter'))
        return `A stepped countersink needs an end mill smaller than the Ø ${L(p['edgeDiameter'])} hole; the ${tool} is not.`
      break
    case 'type': {
      const needs = String(p['needs'])
      if (needs === 'notDrill') return 'A drill cannot make a flat bottom: use a flat end mill.'
      if (needs === 'drill') return 'An end mill cannot make a drill-point bottom: use a drill.'
      if (NEEDS[needs] !== undefined)
        return `The ${tool} cannot make this operation: it needs ${NEEDS[needs]}.`
      break
    }
    case 'reach':
      if (has('reach'))
        return `The ${tool} reaches ${L(p['reach'])}; the operation is ${L(p['depth'])} deep.`
      break
  }
  return `The ${tool} does not fit.`
}

/** Parameters whose value is a count, not a length (suggestions are plain numbers). */
const COUNT_PARAMETERS = new Set(['tabs.count'])

/** DFM warnings are soft or hard; the error tier is for plan errors (task 3.7). */
export type WarningTier = 'soft' | 'hard' | 'error'

export const dfmMessages = {
  /** The warning's sentence in the project unit system (fallback: the core's English text). */
  text(w: DfmWarning, units: UnitSystem, name: DfmNames): string {
    const render = TEXT[w.code]
    const L = (mm: unknown) => {
      const n = num(mm)
      return Number.isFinite(n) ? lengthSource(n, units) : '?'
    }
    return render === undefined ? w.message : render(w.params, L, name)
  },
  tier: (w: DfmWarning): 'soft' | 'hard' => (w.severity === 'info' ? 'soft' : 'hard'),
  /**
   * The value a suggestion applies, as a source for the parameter, rounded so it satisfies the
   * suggestion; undefined when it cannot be applied to one field.
   */
  suggestionSource(w: DfmWarning, units: UnitSystem): string | undefined {
    const s = w.suggestion
    if (s === undefined || w.parameter === undefined) return undefined
    if (COUNT_PARAMETERS.has(w.parameter))
      return String(s.relation === 'atLeast' ? Math.ceil(s.value) : Math.floor(s.value))
    // `tool`: the size the operation would need, not a value of the field (F5 offers tools)
    if (
      w.parameter === 'shape' ||
      w.parameter === 'center' ||
      w.parameter === 'tabs' ||
      w.parameter === 'tool'
    )
      return undefined
    return lengthSource(s.value, units, s.relation === 'atLeast' ? 'up' : 'down')
  },
  /** Fix button: "Use ≥ 3.2 mm" ("Apply" names only project Apply, apply.md#keyboard). */
  useValue: (relation: 'atLeast' | 'atMost', source: string): string =>
    `Use ${relation === 'atLeast' ? '≥' : '≤'} ${source}`,
  listTitle: 'Warnings',
  none: 'No warnings.',
  checksPending: 'Geometry checks pending.',
  dismiss: 'Dismiss',
  dismissed: (n: number) => `${n} dismissed`,
  show: 'Show',
  hide: 'Hide',
  count: (n: number) => (n === 1 ? '1 warning' : `${n} warnings`),
  severity: { soft: 'Note', hard: 'Warning', error: 'Error' } satisfies Record<WarningTier, string>,
} as const
