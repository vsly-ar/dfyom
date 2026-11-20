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

/** "front", "right", … for stock side surface ids. */
const SIDE: Readonly<Record<string, string>> = {
  'stock.side[0]': 'front',
  'stock.side[1]': 'right',
  'stock.side[2]': 'back',
  'stock.side[3]': 'left',
}

const list = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

type Render = (
  p: DfmWarning['params'],
  L: (mm: unknown) => string,
  name: (id: string) => string,
) => string

const TEXT: Readonly<Record<DfmWarningCode, Render>> = {
  'dfm.loosePiece': (p) =>
    p['offcut'] === true
      ? 'An offcut is not held and comes loose. Add tabs or make them thicker.'
      : 'A piece of the part is not held and comes loose. Check the cut that separates it.',
  'dfm.retainedRemoved': (p, _L, name) => {
    const by = typeof p['by'] === 'string' ? name(p['by']) : 'Another operation'
    const regions = (p['regions'] as readonly string[] | undefined) ?? []
    return `${by} cuts away ${regions.length > 0 ? list(regions) : 'retained regions'} of this operation. Move one of them.`
  },
  'dfm.surfaceMissing': (p) =>
    `It starts from or refers to ${String(p['surface'])}, which the part no longer has. Pick another surface.`,
  'dfm.facingDeep': (p, L) =>
    `A facing depth of ${L(p['depth'])} removes a lot of material. Check the stock thickness.`,
  'dfm.pocketNoToolFits': (p, L) =>
    `No tool fits: the pocket is ${L(p['narrowest'])} at its narrowest, the smallest end mill in the library ${L(p['toolDiameter'])}.`,
  'dfm.pocketDeepNarrow': (p, L) =>
    `Deep, narrow pocket: ${L(p['depth'])} deep and ${L(p['narrowest'])} at its narrowest. It needs a long tool.`,
  'dfm.cornerSharp': () => 'A sharp inside corner cannot be cut by a round tool.',
  'dfm.cornerTooSmall': (p, L) =>
    `No tool can make this corner: the smallest end mill in the library has a radius of ${L(p['toolRadius'])}.`,
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
}

/** Parameters whose value is a count, not a length (suggestions are plain numbers). */
const COUNT_PARAMETERS = new Set(['tabs.count'])

export type WarningTier = 'soft' | 'hard'

export const dfmMessages = {
  /** The warning's sentence in the project unit system (fallback: the core's English text). */
  text(w: DfmWarning, units: UnitSystem, name: (operationId: string) => string): string {
    const render = TEXT[w.code]
    const L = (mm: unknown) => {
      const n = num(mm)
      return Number.isFinite(n) ? lengthSource(n, units) : '?'
    }
    return render === undefined ? w.message : render(w.params, L, name)
  },
  tier: (w: DfmWarning): WarningTier => (w.severity === 'info' ? 'soft' : 'hard'),
  /**
   * The value a suggestion applies, as a source for the parameter, rounded so it satisfies the
   * suggestion; undefined when it cannot be applied to one field.
   */
  suggestionSource(w: DfmWarning, units: UnitSystem): string | undefined {
    const s = w.suggestion
    if (s === undefined || w.parameter === undefined) return undefined
    if (COUNT_PARAMETERS.has(w.parameter))
      return String(s.relation === 'atLeast' ? Math.ceil(s.value) : Math.floor(s.value))
    if (w.parameter === 'shape' || w.parameter === 'center' || w.parameter === 'tabs')
      return undefined
    return lengthSource(s.value, units, s.relation === 'atLeast' ? 'up' : 'down')
  },
  apply: (relation: 'atLeast' | 'atMost', source: string): string =>
    `Apply ${relation === 'atLeast' ? '≥' : '≤'} ${source}`,
  listTitle: 'Warnings',
  none: 'No warnings.',
  checksPending: 'Geometry checks pending.',
  dismiss: 'Dismiss',
  dismissed: (n: number) => `${n} dismissed`,
  show: 'Show',
  hide: 'Hide',
  count: (n: number) => (n === 1 ? '1 warning' : `${n} warnings`),
  severity: { soft: 'Note', hard: 'Warning' } satisfies Record<WarningTier, string>,
} as const
