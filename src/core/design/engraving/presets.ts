/**
 * The engraved-pattern presets (engraved-patterns.md § Presets, EP-G): the shipped SVG files of
 * this folder, as text (`preset-svgs.ts`, written by scripts/engraving-presets.mjs: core also
 * loads without a bundler, in e2e), with their kind and natural size. A
 * shipped file never changes (a project stores the preset id and the resolution reads the file); a
 * new design gets a new id. Display names and descriptions are the renderer's messages.
 * `presetLines` imports a preset once (the SVG importer, levels from stroke darkness and
 * `data-level`) into its lines in the motif frame (mm, y up), cached per id.
 * Doc: docs/modes/engraved-patterns.md#presets, docs/modes/engraved-patterns.md#implementation-e3
 */
import { fail, Ok, type AppResult } from '../../../shared/result'
import { elementLength, type Element } from '../../geometry/2d/model'
import { importSvg, type SvgImportWarning } from '../../import/svg/import'
import { PRESET_SVGS } from './preset-svgs'

/** `tile`: made to repeat on a lattice (E4); `single`: one motif; `round`: one round motif. */
export type EngravingPresetKind = 'tile' | 'single' | 'round'

export interface EngravingPreset {
  readonly id: string
  readonly kind: EngravingPresetKind
  /** The SVG's size (mm): its `width` × `height`. */
  readonly size: readonly [number, number]
  readonly svg: string
}

const svg = (id: string): string => PRESET_SVGS[id] ?? ''

/** In the Presets dialog's order: tiles, motifs, round. */
export const ENGRAVING_PRESETS: readonly EngravingPreset[] = [
  { id: 'waves', kind: 'tile', size: [20, 10], svg: svg('waves') },
  { id: 'chevrons', kind: 'tile', size: [20, 10], svg: svg('chevrons') },
  { id: 'crosshatch', kind: 'tile', size: [10, 10], svg: svg('crosshatch') },
  { id: 'scales', kind: 'tile', size: [12, 6], svg: svg('scales') },
  { id: 'seigaiha', kind: 'tile', size: [20, 10], svg: svg('seigaiha') },
  { id: 'basket-weave', kind: 'tile', size: [16, 16], svg: svg('basket-weave') },
  { id: 'greek-key', kind: 'tile', size: [20, 12], svg: svg('greek-key') },
  { id: 'wood-grain', kind: 'tile', size: [40, 20], svg: svg('wood-grain') },
  { id: 'vine', kind: 'single', size: [60, 26], svg: svg('vine') },
  { id: 'rosette', kind: 'round', size: [80, 80], svg: svg('rosette') },
  { id: 'sunburst', kind: 'round', size: [80, 80], svg: svg('sunburst') },
  { id: 'ripples', kind: 'round', size: [80, 80], svg: svg('ripples') },
  { id: 'mandala', kind: 'round', size: [80, 80], svg: svg('mandala') },
]

export const ENGRAVING_PRESET_IDS: readonly string[] = ENGRAVING_PRESETS.map((p) => p.id)

export const engravingPreset = (id: string): EngravingPreset | undefined =>
  ENGRAVING_PRESETS.find((p) => p.id === id)

/**
 * One line of a motif: a closed loop (one level) or an open path with its level profile by
 * arc-length fraction (`u` ascending 0..1); `level` absent = 1 (deepest).
 */
export interface MotifLine {
  readonly elements: readonly Element[]
  readonly closed: boolean
  readonly levels?: { readonly u: readonly number[]; readonly level: readonly number[] }
}

export interface PresetLines {
  readonly lines: readonly MotifLine[]
  readonly warnings: readonly SvgImportWarning[]
}

const cache = new Map<string, AppResult<PresetLines>>()

/** Per-vertex levels of an open path (vertex i = start of element i, last = the end) by arc length. */
function vertexProfile(
  elements: readonly Element[],
  lv: number | readonly number[],
): NonNullable<MotifLine['levels']> {
  if (typeof lv === 'number') return { u: [0, 1], level: [lv, lv] }
  const s: number[] = [0]
  let acc = 0
  for (const e of elements) s.push((acc += elementLength(e)))
  if (!(acc > 0) || lv.length !== s.length) return { u: [0, 1], level: [lv[0]!, lv.at(-1)!] }
  return { u: s.map((x) => x / acc), level: [...lv] }
}

/**
 * The preset's lines in its motif frame (mm, y up, the SVG's own coordinates flipped by the
 * importer), cached per id; an unknown id is `input.malformed` (`unknownPreset`).
 */
export function presetLines(id: string): AppResult<PresetLines> {
  const hit = cache.get(id)
  if (hit !== undefined) return hit
  const preset = engravingPreset(id)
  if (preset === undefined)
    return fail('input.malformed', `no engraving preset ${id}`, {
      issues: [
        {
          path: ['motif', 'preset'],
          rule: 'unknownPreset',
          message: `no such preset; one of ${ENGRAVING_PRESET_IDS.join(', ')}`,
        },
      ],
      where: 'presetLines',
    })
  const r = importSvg(preset.svg, { unit: 'mm', split: 'element' }).map((imp): PresetLines => {
    const lines: MotifLine[] = []
    for (const shape of imp.shapes)
      for (const item of shape.items) {
        if (item.kind === 'loop')
          lines.push({
            elements: item.loop.elements,
            closed: true,
            ...(item.level === undefined || item.level === 1
              ? {}
              : { levels: { u: [0, 1], level: [item.level, item.level] } }),
          })
        else
          lines.push({
            elements: item.path.elements,
            closed: false,
            ...(item.levels === undefined
              ? {}
              : { levels: vertexProfile(item.path.elements, item.levels) }),
          })
      }
    return { lines, warnings: imp.report.warnings }
  })
  const out = r.isOk() ? Ok(r.unwrap()) : r
  cache.set(id, out)
  return out
}
