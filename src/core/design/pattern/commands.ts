/**
 * `design.pattern.add` / `.update` (patterns P1, P2, P3: `chamfer`, P4: `through`, DF108:
 * `roughing`): the pattern kind's arguments and how they
 * build a pattern. Kept terse for `tools/list` (llm-api.md § Implementation): `update` lists its
 * geometry args as sketches ("As add").
 * Doc: docs/modes/patterns.md#agent-api, docs/modes/patterns.md#implementation-p1,
 * docs/modes/patterns.md#implementation-p2, docs/modes/patterns.md#implementation-p3,
 * docs/modes/patterns.md#implementation-p4, docs/modes/patterns.md#roughing-df108
 */
import { z } from 'zod'
import { None, Some, type Option } from '../../../shared/result'
import type { Quantity } from '../../quantity/quantity'
import { listedAs } from '../../commands/json-schema'
import { PointArg, Src } from '../commands'
import { featureKindCommands, type FeatureCommandSpec } from '../feature-commands'
import { DEFAULTS, type RoughingMargins } from '../operation'
import { RoughingArg, roughingFromArg, type RoughingArgs } from '../roughing'
import { PATTERN_LATTICES, POLYGON_ACROSS, ShapeIdSchema } from '../shape.dto'
import {
  isEmptyMargins,
  patternSpec,
  type Pattern,
  type PatternBoundary,
  type PatternChamfer,
  type PatternCell,
  type PatternMargin,
  type PatternSpacing,
} from './pattern'

/** Each cell kind's required sizes (one flat schema keeps `tools/list` small, like workholding). */
const CELL_NEEDS = {
  circle: ['diameter'],
  rectangle: ['length', 'width'],
  obround: ['length', 'width'],
  polygon: ['sides', 'diameter'],
  shape: ['shapeId'],
} as const
const CellArg = z
  .object({
    kind: z.enum(['circle', 'rectangle', 'obround', 'polygon', 'shape']),
    diameter: Src.optional(),
    length: Src.optional(),
    width: Src.optional(),
    sides: Src.optional(),
    across: z.enum(POLYGON_ACROSS).optional(),
    cornerRadius: Src.optional(),
    round: z.boolean().optional(),
    shapeId: ShapeIdSchema.optional(),
    rotation: Src.optional(),
  })
  .superRefine((c, ctx) => {
    for (const k of CELL_NEEDS[c.kind])
      if (c[k] === undefined)
        ctx.addIssue({ code: 'custom', path: [k], message: `A ${c.kind} cell needs ${k}` })
  })
  .describe(
    'circle: diameter; rectangle: length, width, cornerRadius? (or "round"), round?; obround: length, width; polygon: sides, diameter, across?, cornerRadius?; shape: shapeId (a closed shape, centred by its box). Centred on each node, turned by rotation. Default circle 8 mm / 5/16"',
  )

const params = {
  cell: CellArg,
  lattice: z
    .enum(PATTERN_LATTICES)
    .describe(
      'staggered: odd rows shifted half a pitch; hex: rows 60° apart; polar: rings. Default staggered',
    ),
  spacing: z
    .union([z.object({ gap: Src }), z.object({ pitch: PointArg })])
    .describe(
      'gap: web between cell boxes (polar: between circumcircles; default 2 mm / 1/16"), or pitch [along rows, between rows]',
    ),
  alternate: z.enum(['none', 'flip']).describe('flip: every other cell turned 180°'),
  angle: Src.describe('Turns the whole lattice about origin; default 0°'),
  origin: PointArg.nullable().describe('A node; null = centre of the area'),
  boundary: z
    .object({ shapeId: z.string(), center: PointArg, rotation: Src.optional() })
    .nullable()
    .describe(
      'Closed shape (keep-outs: its subtract items), box centre at center; null = face (on a pattern floor: its cells)',
    ),
  margin: z
    .union([Src, PointArg])
    .describe('Uncut border inside the boundary, or [u, v]; default 5 mm / 3/16"'),
  fit: z.enum(['whole', 'clip']).describe('clip: cut cells at the border (slivers dropped)'),
  invert: z.boolean().describe('Cells stand as islands'),
  depth: Src.describe('Below on; default 1 mm / 1/32"'),
  through: z.boolean().describe('Cells cut through the stock'),
  roughing: RoughingArg.describe(
    'Bigger tool clears cells first (<id>_roughing); {wall, floor} as pocket',
  ),
  chamfer: z
    .object({
      width: Src.optional(),
      angle: Src.optional(),
      side: z.enum(['top', 'bottom', 'both']).optional(),
    })
    .strict()
    .nullable()
    .describe(
      'Edge chamfer round every cell; default 0.5 mm, 90°, top (bottom: through); null = none',
    ),
}

type Args = Partial<z.output<z.ZodObject<typeof params>>>
type CellArgs = z.output<typeof CellArg>

const spec: FeatureCommandSpec<typeof params, Pattern> = {
  ...patternSpec,
  params,
  required: [],
  // the heatsink recipe (pattern-presets.md § Agent API, Q210: no preset argument)
  addSummary:
    'Add a pattern feature at the end of the part; it creates its operations. Heatsink fins: cell rectangle (length = face, width = slot, rotation 90°), square lattice, gap = fin, margin [wall, 0]; pins: invert.',
  // listed as sketches: the full args are add's (tools/list budget, P2)
  updateParams: {
    cell: listedAs('object', 'design.pattern.add cell'),
    spacing: listedAs('object', 'design.pattern.add spacing'),
    origin: z.unknown().describe('As design.pattern.add origin'),
    boundary: z.unknown().describe('As design.pattern.add boundary'),
    chamfer: z.unknown().describe('As design.pattern.add chamfer'),
    roughing: z.unknown().describe('As design.pattern.add roughing'),
  },
  /** Fields not given keep their previous value (add: the patterns.md defaults). */
  build(a: Args, prev, { f, id, name, on }): Pattern {
    const units = f.units
    const cell = (c: CellArgs | undefined): PatternCell => {
      if (c === undefined && prev !== undefined) return prev.cell
      const rot = f.q('cell.rotation', 'angle', c?.rotation ?? '0')
      // the sizes the kind needs are there (CellArg's refinement)
      const need = (v: string | undefined): string => v ?? ''
      switch (c?.kind) {
        case undefined:
        case 'circle':
          return {
            kind: 'circle',
            rotation: rot,
            diameter: f.q('cell.diameter', 'length', c?.diameter ?? DEFAULTS.patternCell[units]),
          }
        case 'rectangle': {
          const length = f.q('cell.length', 'length', need(c.length))
          const width = f.q('cell.width', 'length', need(c.width))
          const p = prev?.cell
          // DF120: a Round cell keeps Round (following its sizes) unless the edit changes it
          const before =
            p?.kind === 'rectangle' && (c.cornerRadius !== undefined || p.round === true)
              ? { ...p, round: p.round === true }
              : undefined
          const corner = f.roundCorner(
            'cell.cornerRadius',
            { length, width },
            c.cornerRadius,
            c.round,
            before,
            () => f.q('cell.cornerRadius', 'length', '0'),
          )
          return { kind: 'rectangle', rotation: rot, length, width, ...corner }
        }
        case 'obround':
          return {
            kind: 'obround',
            rotation: rot,
            length: f.q('cell.length', 'length', need(c.length)),
            width: f.q('cell.width', 'length', need(c.width)),
          }
        case 'polygon':
          return {
            kind: 'polygon',
            rotation: rot,
            sides: f.q('cell.sides', 'scalar', need(c.sides)),
            diameter: f.q('cell.diameter', 'length', need(c.diameter)),
            across: c.across ?? 'corners',
            cornerRadius: f.q('cell.cornerRadius', 'length', c.cornerRadius ?? '0'),
          }
        case 'shape':
          return { kind: 'shape', rotation: rot, shapeId: need(c.shapeId) }
      }
    }
    const spacing = (): PatternSpacing => {
      const s = a.spacing
      if (s === undefined)
        return (
          prev?.spacing ?? {
            kind: 'gap',
            gap: f.q('spacing.gap', 'length', DEFAULTS.patternGap[units]),
          }
        )
      if ('gap' in s) return { kind: 'gap', gap: f.q('spacing.gap', 'length', s.gap) }
      return {
        kind: 'pitch',
        pitch: [
          f.q('spacing.pitch.0', 'length', s.pitch[0]),
          f.q('spacing.pitch.1', 'length', s.pitch[1]),
        ],
      }
    }
    const origin: Option<readonly [Quantity, Quantity]> =
      a.origin === undefined
        ? (prev?.origin ?? None)
        : a.origin === null
          ? None
          : Some([
              f.q('origin.0', 'length', a.origin[0]),
              f.q('origin.1', 'length', a.origin[1]),
            ] as const)
    const boundary = (): Option<PatternBoundary> => {
      const b = a.boundary
      if (b === undefined) return prev?.boundary ?? None
      if (b === null) return None
      return Some({
        shapeId: b.shapeId,
        center: [
          f.q('boundary.center.0', 'length', b.center[0]),
          f.q('boundary.center.1', 'length', b.center[1]),
        ] as const,
        rotation: f.q('boundary.rotation', 'angle', b.rotation ?? '0'),
      })
    }
    const chamfer = (): Option<PatternChamfer> => {
      const c = a.chamfer
      if (c === undefined) return prev?.chamfer ?? None
      if (c === null) return None
      const old = prev?.chamfer.isSome() === true ? prev.chamfer.unwrap() : undefined
      return Some({
        width: f.pick('chamfer.width', 'length', c.width, old?.width, 'chamferWidth'),
        angle: f.pick('chamfer.angle', 'angle', c.angle, old?.angle, 'chamferAngle'),
        side: c.side ?? old?.side ?? 'top',
      })
    }
    // H1: `[u, v]` (docs/modes/pattern-presets.md#model-changes); a value not given keeps the old
    const margin = (): PatternMargin => {
      const m = a.margin
      if (Array.isArray(m))
        return [f.q('margin.0', 'length', m[0]), f.q('margin.1', 'length', m[1])] as const
      if (m === undefined && prev !== undefined) return prev.margin
      return f.pick('margin', 'length', m, undefined, 'patternMargin')
    }
    return {
      kind: 'pattern',
      id,
      name,
      on,
      cell: cell(a.cell),
      lattice: a.lattice ?? prev?.lattice ?? 'staggered',
      angle:
        a.angle !== undefined
          ? f.q('angle', 'angle', a.angle)
          : (prev?.angle ?? f.q('angle', 'angle', '0')),
      origin,
      spacing: spacing(),
      alternate: a.alternate ?? prev?.alternate ?? 'none',
      boundary: boundary(),
      margin: margin(),
      fit: a.fit ?? prev?.fit ?? 'whole',
      invert: a.invert ?? prev?.invert ?? false,
      depth: f.pick('depth', 'length', a.depth, prev?.depth, 'patternDepth'),
      through: a.through ?? prev?.through ?? false,
      // DF122: true / { wall, floor } / false (docs/modes/roughing.md#patterns)
      ...patternRoughing(a.roughing, prev, (path, src) => f.q(path, 'length', src)),
      chamfer: chamfer(),
    }
  },
}

/** DF122: the pattern's `roughing` and `roughingLeave` after the arg (roughing.ts rules). */
function patternRoughing(
  arg: RoughingArgs | undefined,
  prev: Pattern | undefined,
  parse: (path: string, source: string) => Quantity,
): { roughing: boolean; roughingLeave?: RoughingMargins } {
  const before = prev?.roughing === true ? (prev.roughingLeave ?? {}) : undefined
  const after = roughingFromArg(arg, before, parse)
  if (after === undefined) return { roughing: false }
  return isEmptyMargins(after) ? { roughing: true } : { roughing: true, roughingLeave: after }
}

/** `design.pattern.add` / `.update`; the kind itself is built in (feature.ts). */
export const PATTERN_COMMANDS = featureKindCommands(spec).unwrap()
