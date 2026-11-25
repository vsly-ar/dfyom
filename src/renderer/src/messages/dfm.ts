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
  // DF50: an earlier setup cleared material under the slot from the opposite face
  'dfm.tabsThick': (p, L) =>
    `Tabs ${L(p['thickness'])} thick reach the stock face: an earlier setup leaves only ${L(p['material'])} of material under the slot. Make them thinner.`,
  // DF90: tabs are measured up from the slot's bottom, not from a face
  'dfm.tabsTall': (p, L) =>
    `Tabs ${L(p['thickness'])} thick are over half the ${L(p['material'])} of material the slot cuts. Tab thickness is measured up from the bottom of the slot: make them thinner.`,
  // v0.4 TB1 (design-v0.4.md § Tabs relocate off free sides)
  'dfm.tabsRelocated': (p) =>
    `${num(p['moved'])} of ${num(p['count'])} tabs moved off sides where the slot leaves no stock beyond the cut.`,
  'design.split': (p, L, name) => splitText(p, L, name),
  'dfm.tabsNoHold': (p) =>
    Array.isArray(p['indices'])
      ? `${num(p['count']) - num(p['held'])} of ${num(p['count'])} tabs lie where the slot leaves no stock beyond the cut, so they hold nothing. Move them to a side with stock.`
      : `Only ${num(p['held'])} of ${num(p['count'])} tabs fit where stock remains beyond the slot. The others hold nothing: use fewer tabs or a larger stock.`,
  'dfm.reach': (p, L) =>
    typeof p['fluteLength'] === 'number'
      ? `No tool in the library cuts walls ${L(p['depth'])} deep with its flutes (longest flute length ${L(p['fluteLength'])}, ${L(p['margin'])} kept spare). Below the flutes the shank rubs the wall: add a tool with longer flutes or a reduced shank.`
      : `No tool in the library reaches ${L(p['depth'])} deep from the stock face (longest ${L(p['reach'])}).`,
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
    p['wholly'] === true
      ? 'The shape lies outside the stock face, so the pocket cuts nothing.'
      : `The shape reaches ${L(p['by'])} outside the stock face at the ${list(((p['sides'] as readonly string[] | undefined) ?? []).map((s) => SIDE[s] ?? s))}: an open-sided pocket.`,
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
  // patterns P1 (patterns.md § DFM)
  'dfm.patternEmpty': () =>
    'No cell fits the face less the margin: make the cell or the margin smaller.',
  'dfm.patternHeavy': (p) =>
    p['cells'] === undefined
      ? `The pattern's outlines have ${num(p['chords'])} segments: the part updates more slowly.`
      : `${num(p['cells'])} cells: the part updates more slowly.`,
  'dfm.patternThinWeb': (p, L) =>
    p['island'] === true
      ? `An island is only ${L(p['web'])} wide (under ${L(p['limit'])}): it may break off. Make the cell larger.`
      : `The web between cells is only ${L(p['web'])} (under ${L(p['limit'])}): it may break. ${
          p['gap'] === undefined ? 'Widen the pitch.' : `Use a gap of at least ${L(p['gap'])}.`
        }`,
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
      : // an edge chamfer along a general edge (edge-chamfers.md E1)
        p['width'] !== undefined
        ? `The library has no ${num(p['angle'])}° chamfer mill with a cutting edge for a ${L(p['width'])} bevel.`
        : `The library has no ${num(p['angle'])}° chamfer mill that cuts Ø${L(p['edgeDiameter'])} to Ø${L(p['diameter'])}.`,
  // edge chamfers E3 (edge-chamfers.md § DFM findings)
  'dfm.chamferMeets': (p, L) =>
    `The bevels meet on a ${L(p['wall'])} wall: its top becomes a ridge. Use a width of at most ${L(num(p['wall']) / 2)}.`,
  'dfm.chamferIncomplete': (p, L, name) =>
    `The ${L(p['tipDiameter'])} tip of the ${String(p['tool'])} does not fit where the air beside ${name.item(String(p['edgeOf']))} is narrower: ${L(p['length'])} of its edge is not chamfered fully.`,
  'dfm.chamferTabs': (p, L, name) =>
    `The bottom bevel stops ${L(p['gap'])} short across each of the ${String(p['count'])} tabs of ${name.item(String(p['edgeOf']))}, so they keep holding the part. Finish those stretches by hand when you remove the tabs.`,
}

/** Why a split cuts a feature (`params.reason` of `design.split` rule `cutsFeature`). */
const CUTS: Readonly<Record<string, string>> = {
  line: 'A split line crosses it: it goes to the piece holding its centre and the other piece misses its part.',
  on: 'It starts on a face a piece does not have, so that piece leaves it out.',
  open: 'It is an open path crossed by a split line, so the piece leaves it out.',
  fillet: 'A split level cuts its floor fillet, which neither piece can make.',
  cone: 'A split level cuts its cone, which neither piece can make.',
  sideFace: 'It is on a side face: pieces do not take side-face operations yet.',
  chamferKey:
    'Its bevel runs past the split line along the outline and nicks a key: use a narrower chamfer or move the key.',
}

/**
 * `design.split` by its rule (split parts 4a, docs/modes/split-parts.md#dfm-near-a-split); lengths
 * in the project units, pieces by number.
 */
function splitText(p: DfmWarning['params'], L: (mm: unknown) => string, name: DfmNames): string {
  const op = typeof p['operationId'] === 'string' ? name.item(p['operationId']) : 'An operation'
  const size = (v: unknown) =>
    Array.isArray(v) ? (v as number[]).map((x) => L(x)).join(' × ') : '?'
  const piece = `Piece ${num(p['piece'])}`
  const line = `the line at ${String(p['axis']).toUpperCase()} ${L(p['at'])}`
  switch (p['rule']) {
    case 'noOutline':
      return 'The part has no through outline profile, so the pieces are cut along the stock edges. Add the outline first.'
    case 'cutsFeature':
      return `${op}: ${CUTS[String(p['reason'])] ?? 'a split cuts it.'}`
    case 'featureNear': {
      const at = [
        ...((p['nearX'] as number[] | undefined) ?? []).map((x) => `the line at X ${L(x)}`),
        ...((p['nearY'] as number[] | undefined) ?? []).map((y) => `the line at Y ${L(y)}`),
        ...((p['nearZ'] as number[] | undefined) ?? []).map((z) => `the level at Z ${L(z)}`),
      ]
      return `${op} lies within ${L(p['limit'])} of ${at.length > 0 ? list(at) : 'a split'}: a thin wall at the joint. Move the split.`
    }
    case 'thinJoint': {
      if (p['what'] === 'fingerWidth')
        return `The fingers on ${line} are ${L(p['width'])} wide, less than ${L(p['limit'])} (3 × the outline tool's Ø): weak fingers. Use a smaller outline tool or a thicker part.`
      if (p['what'] === 'keyNeck')
        return `The key neck on ${line} is ${L(p['width'])} wide, less than ${L(p['limit'])} (3 × the outline tool's Ø): a weak key. Move the split.`
      const where = typeof p['level'] === 'number' ? `the level at Z ${L(p['level'])}` : line
      return typeof p['dowel'] === 'number'
        ? `The glue face at ${where} is ${L(p['width'])} wide at its narrowest, less than ${L(p['limit'])}: Ø${L(p['dowel'])} dowels fit only where it is wider.`
        : `The glue face at ${where} is ${L(p['width'])} wide at its narrowest, less than ${L(p['limit'])}: a weak butt joint. Move the split.`
    }
    // design review U9: these three fell back to "A split finding on this part."
    case 'keyFit': {
      const ab = Array.isArray(p['pieces']) ? (p['pieces'] as number[]).map(num) : []
      const pair = `pieces ${ab[0] ?? '?'} and ${ab[1] ?? '?'}`
      const r = Array.isArray(p['run']) ? (p['run'] as number[]).map(num) : [Number.NaN, Number.NaN]
      const run = `${p['axis'] === 'x' ? 'Y' : 'X'} ${L(r[0])}–${L(r[1])}`
      // fingers and half laps (split parts 4d)
      if (p['joint'] === 'halfLap')
        return `No half lap on ${line} between ${pair}: a feature or the part edge lies within the ${L(p['lap'])} lap or one tool Ø (${L(p['tool'])}) of it. A butt joint there; move the split or the feature.`
      if (p['joint'] === 'finger') {
        if (p['reason'] === 'near')
          return `No fingers on ${line} between ${pair} at ${run}: a feature or the part edge is within one tool Ø (${L(p['tool'])}) of a finger. A butt joint there; move the split or the feature.`
        if (p['reason'] === 'tool')
          return `The run of ${L(r[1]! - r[0]!)} on ${line} between ${pair} holds fingers only for a tool of Ø${L(p['maxTool'])} or smaller (the outline's is Ø${L(p['tool'])}): a butt joint there.`
        return `The run of ${L(r[1]! - r[0]!)} on ${line} between ${pair} is too short for fingers: a butt joint there.`
      }
      if (p['reason'] === 'near')
        return `No key on ${line} between ${pair} at ${run}: a feature or the part edge is within one tool Ø (${L(p['tool'])}) of every place.`
      if (p['reason'] === 'tool')
        return `The run of ${L(r[1]! - r[0]!)} on ${line} between ${pair} holds a key only for a tool of Ø${L(p['maxTool'])} or smaller (the outline's is Ø${L(p['tool'])}): no key there.`
      return `The run of ${L(r[1]! - r[0]!)} on ${line} between ${pair} is too short for a key: a butt joint there.`
    }
    case 'dowelFit': {
      const level = `level ${num(p['level']) + 1}`
      if (p['reason'] === 'outside')
        return `Dowel hole ${num(p['hole'])} is on no glue face of ${level}: it is left out.`
      if (p['reason'] === 'depth')
        return `The dowel holes at ${level} are ${L(p['depth'])} deep, more than the pieces there hold: they are cut shallower.`
      const ab = Array.isArray(p['pieces']) ? (p['pieces'] as number[]).map(num) : []
      const n = num(p['count'])
      return `The glue face at ${level} between pieces ${ab[0] ?? '?'} and ${ab[1] ?? '?'} has ${n} dowel${n === 1 ? '' : 's'}: 2 or more keep the pieces from turning.`
    }
    case 'dowelNear':
      return num(p['wall']) <= 0
        ? `Dowel hole ${num(p['hole'])} breaks into a feature or out of the glue face at level ${num(p['level']) + 1}. Place the dowels again or move the hole.`
        : `Dowel hole ${num(p['hole'])} leaves ${L(p['wall'])} of wall, less than ${L(p['limit'])}, to an edge or a feature. Move the hole.`
    case 'sliver':
      return `${piece} is a sliver: ${L(p['narrow'])} at its narrowest, ${Math.round(num(p['share']) * 1000) / 10} % of the part. Move or remove a split.`
    case 'noStock':
      return `${piece}: its blank ${size(p['blank'])} fits no library stock; ${String(p['nearest'])} is ${L(p['short'])} short. It uses its own blank.`
    case 'outsideTravel':
      return `${piece}: its blank ${size(p['blank'])} is larger than the travel of ${list(((p['machines'] as string[] | undefined) ?? []).map(String))}. Add a split.`
    case 'fitsWhole':
      return `The whole part (${size(p['size'])} with margins) fits ${String(p['stock'])} and the machine: the split may be unnecessary.`
  }
  return 'A split finding on this part.'
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
    // DF89: the walls are deeper than the flutes and the shank is not narrower than the cutter
    case 'flutes':
      if (has('fluteLength'))
        return `The ${tool} has ${L(p['fluteLength'])} flutes; the walls are ${L(p['depth'])} deep (${L(p['margin'])} kept spare) and its shank ${has('shankDiameter') ? `(Ø ${L(p['shankDiameter'])}) is not narrower than the cutter` : 'Ø is not in the library'}, so the shank would rub the wall. Use a tool with longer flutes.`
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
