/**
 * `design.pattern.add` / `.update` (patterns P1, P2): the pattern kind's arguments and how they
 * build a pattern. Kept terse for `tools/list` (llm-api.md § Implementation): `update` lists its
 * geometry args as sketches ("As add").
 * Doc: docs/modes/patterns.md#agent-api, docs/modes/patterns.md#implementation-p1,
 * docs/modes/patterns.md#implementation-p2
 */
import { z } from 'zod'
import { None, Some, type Option } from '../../../shared/result'
import type { Quantity } from '../../quantity/quantity'
import { listedAs } from '../../commands/json-schema'
import { PointArg, Src } from '../commands'
import { featureKindCommands, type FeatureCommandSpec } from '../feature-commands'
import { DEFAULTS } from '../operation'
import { PATTERN_LATTICES, POLYGON_ACROSS, ShapeIdSchema } from '../shape.dto'
import {
  patternSpec,
  type Pattern,
  type PatternBoundary,
  type PatternCell,
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
    shapeId: ShapeIdSchema.optional(),
    rotation: Src.optional(),
  })
  .superRefine((c, ctx) => {
    for (const k of CELL_NEEDS[c.kind])
      if (c[k] === undefined)
        ctx.addIssue({ code: 'custom', path: [k], message: `A ${c.kind} cell needs ${k}` })
  })
  .describe(
    'circle: diameter; rectangle: length, width, cornerRadius?; obround: length, width; polygon: sides, diameter, across?, cornerRadius?; shape: shapeId (a closed shape, centred by its box). Centred on each node, turned by rotation. Default circle 8 mm / 5/16"',
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
  angle: Src.describe('Turns the whole lattice about origin; default 0°'),
  origin: PointArg.nullable().describe('A node; null = centre of the area'),
  boundary: z
    .object({ shapeId: z.string(), center: PointArg, rotation: Src.optional() })
    .nullable()
    .describe('Closed shape (keep-outs: its subtract items), box centre at center; null = face'),
  margin: Src.describe('Uncut border inside the boundary; default 5 mm / 3/16"'),
  fit: z.enum(['whole', 'clip']).describe('clip: cut cells at the border (slivers dropped)'),
  invert: z.boolean().describe('Cells stand as islands'),
  depth: Src.describe('Below on; default 1 mm / 1/32"'),
}

type Args = Partial<z.output<z.ZodObject<typeof params>>>
type CellArgs = z.output<typeof CellArg>

const spec: FeatureCommandSpec<typeof params, Pattern> = {
  ...patternSpec,
  params,
  required: [],
  // listed as sketches: the full args are add's (tools/list budget, P2)
  updateParams: {
    cell: listedAs('object', 'design.pattern.add cell'),
    spacing: listedAs('object', 'design.pattern.add spacing'),
    origin: z.unknown().describe('As design.pattern.add origin'),
    boundary: z.unknown().describe('As design.pattern.add boundary'),
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
        case 'rectangle':
          return {
            kind: 'rectangle',
            rotation: rot,
            length: f.q('cell.length', 'length', need(c.length)),
            width: f.q('cell.width', 'length', need(c.width)),
            cornerRadius: f.q('cell.cornerRadius', 'length', c.cornerRadius ?? '0'),
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
    const len = (
      key: 'margin' | 'depth',
      old: Quantity | undefined,
      def: 'patternMargin' | 'patternDepth',
    ) => f.pick(key, 'length', a[key], old, def)
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
      boundary: boundary(),
      margin: len('margin', prev?.margin, 'patternMargin'),
      fit: a.fit ?? prev?.fit ?? 'whole',
      invert: a.invert ?? prev?.invert ?? false,
      depth: len('depth', prev?.depth, 'patternDepth'),
    }
  },
}

/** `design.pattern.add` / `.update`; the kind itself is built in (feature.ts). */
export const PATTERN_COMMANDS = featureKindCommands(spec).unwrap()
