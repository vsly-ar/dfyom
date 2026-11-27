/**
 * `design.engraving.add` / `.update` (engraved-patterns.md E3): the engraved pattern kind's
 * arguments and how they build one. Kept lean for `tools/list` (E1–E3 share ≤ 3.0 K, EP-H): the
 * preset ids are in the primer, not an enum; `boundary` and `depth` are listed as sketches of
 * `design.pattern.add` and `design.line.add` (validated in full, the doc's first listed cut: the
 * depth union described once); `update` sketches every structured arg. E4: the lattice is one
 * `layout` arg ('single' or Pattern's lattice fields), listed as a sketch of `design.pattern.add`'s
 * (the tools/list budget), and `rotation: 'radial'` turns polar tiles to face out.
 * Doc: docs/modes/engraved-patterns.md#agent-api, docs/modes/engraved-patterns.md#implementation-e3,
 * docs/modes/engraved-patterns.md#implementation-e4
 */
import { z } from 'zod'
import { None, Some, type Option } from '../../../shared/result'
import type { Quantity } from '../../quantity/quantity'
import { LineDepthArg, lineDepthOf, PointArg, Src } from '../commands'
import { featureKindCommands, type FeatureCommandSpec } from '../feature-commands'
import type { Point } from '../operation'
import type { PatternBoundary } from '../pattern/pattern'
import { ENGRAVING_LATTICES, ShapeIdSchema } from '../shape.dto'
import {
  defaultFit,
  defaultLayout,
  engravingSpec,
  type Engraving,
  type EngravingLayout,
  type EngravingMotif,
} from './engraving'

/** The motif a new engraved pattern takes (E4: the Waves tile, clipped to the face). */
export const DEFAULT_ENGRAVING_PRESET = 'waves'

/** The `rotation` value that turns polar tiles to face away from the origin (E4). */
const RADIAL = 'radial'

/** E4: 'single', or Pattern's lattice fields (a gap may be 0: the tiles join). */
const LayoutArg = z.union([
  z.literal('single'),
  z
    .object({
      lattice: z.enum(ENGRAVING_LATTICES),
      spacing: z.union([z.object({ gap: Src }), z.object({ pitch: PointArg })]).optional(),
      angle: Src.optional(),
      origin: PointArg.nullable().optional(),
      alternate: z.enum(['none', 'flip']).optional(),
    })
    .strict(),
])
const LAYOUT_SKETCH =
  "As design.pattern.add lattice, spacing (gap ≥ 0, default 0), angle, origin, alternate in one object {lattice, …}, or 'single'; default the preset's"

const BoundaryArg = z
  .object({ shapeId: ShapeIdSchema, center: PointArg, rotation: Src.optional() })
  .nullable()

const params = {
  motif: z
    .union([
      z.object({ preset: z.string().min(1).max(64) }),
      z.object({ shapeIds: z.array(ShapeIdSchema).min(1).max(50) }),
    ])
    .describe('preset id (primer), or shapes with levels; default waves'),
  center: PointArg.nullable().describe('Motif centre; null = area centre'),
  size: Src.nullable().describe('Motif width; null = its own'),
  rotation: Src.describe('Default 0°; radial: polar tiles face out'),
  layout: LayoutArg,
  boundary: BoundaryArg,
  margin: Src.describe('Default 3 mm'),
  fit: z
    .enum(['whole', 'boundary', 'clip'])
    .describe('boundary: single scaled to fit (round default); clip: lines cut (tiles default)'),
  depth: LineDepthArg,
}

type Args = Partial<z.output<z.ZodObject<typeof params>>>

const spec: FeatureCommandSpec<typeof params, Engraving> = {
  ...engravingSpec,
  params,
  required: [],
  // `dryRun: true` returns the result without changing the part (engraved-patterns.md § Agent API)
  dryRun: true,
  addParams: {
    layout: z.unknown().describe(LAYOUT_SKETCH),
    boundary: z.unknown().describe('As design.pattern.add boundary'),
    depth: z.unknown().describe('As design.line.add depth; default {min 0.2, max 1 mm}'),
  },
  updateParams: {
    motif: z.unknown().describe('As design.engraving.add motif'),
    center: z.unknown().describe('As design.engraving.add center'),
    layout: z.unknown().describe('As design.engraving.add layout'),
    boundary: z.unknown().describe('As design.pattern.add boundary'),
    depth: z.unknown().describe('As design.line.add depth'),
  },
  /** Fields not given keep their previous value (add: the engraved-patterns.md defaults). */
  build(a: Args, prev, { f, id, name, on }): Engraving {
    const motif: EngravingMotif =
      a.motif === undefined
        ? (prev?.motif ?? { kind: 'preset', preset: DEFAULT_ENGRAVING_PRESET })
        : 'preset' in a.motif
          ? { kind: 'preset', preset: a.motif.preset }
          : { kind: 'shapes', shapeIds: [...a.motif.shapeIds] }
    const center: Option<Point> =
      a.center === undefined
        ? (prev?.center ?? None)
        : a.center === null
          ? None
          : Some([f.q('center.0', 'length', a.center[0]), f.q('center.1', 'length', a.center[1])])
    const size: Option<Quantity> =
      a.size === undefined
        ? (prev?.size ?? None)
        : a.size === null
          ? None
          : Some(f.q('size', 'length', a.size))
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
    // a new motif takes its own default layout, size and fit unless given (a tile preset tiles)
    const motifChanged =
      a.motif !== undefined && JSON.stringify(motif) !== JSON.stringify(prev?.motif)
    const zero = {
      gap: f.q('layout.spacing.gap', 'length', '0'),
      angle: f.q('layout.angle', 'angle', '0'),
    }
    const layout = ((): EngravingLayout => {
      const l = a.layout
      if (l === undefined)
        return prev !== undefined && !motifChanged ? prev.layout : defaultLayout(motif, zero)
      if (l === 'single') return { kind: 'single' }
      const was = prev?.layout.kind === 'lattice' ? prev.layout : undefined
      const sp = l.spacing
      return {
        kind: 'lattice',
        lattice: l.lattice,
        spacing:
          sp === undefined
            ? (was?.spacing ?? { kind: 'gap', gap: zero.gap })
            : 'gap' in sp
              ? { kind: 'gap', gap: f.q('layout.spacing.gap', 'length', sp.gap) }
              : {
                  kind: 'pitch',
                  pitch: [
                    f.q('layout.spacing.pitch.0', 'length', sp.pitch[0]),
                    f.q('layout.spacing.pitch.1', 'length', sp.pitch[1]),
                  ],
                },
        angle:
          l.angle === undefined
            ? (was?.angle ?? zero.angle)
            : f.q('layout.angle', 'angle', l.angle),
        origin:
          l.origin === undefined
            ? (was?.origin ?? None)
            : l.origin === null
              ? None
              : Some([
                  f.q('layout.origin.0', 'length', l.origin[0]),
                  f.q('layout.origin.1', 'length', l.origin[1]),
                ]),
        alternate: l.alternate ?? was?.alternate ?? 'none',
      }
    })()
    const radial = a.rotation !== undefined ? a.rotation.trim() === RADIAL : (prev?.radial ?? false)
    const polar = layout.kind === 'lattice' && layout.lattice === 'polar'
    return {
      kind: 'engraving',
      id,
      name,
      on,
      motif,
      center,
      size: motifChanged && a.size === undefined ? None : size,
      rotation:
        a.rotation !== undefined && !radial
          ? f.q('rotation', 'angle', a.rotation)
          : a.rotation !== undefined
            ? f.q('rotation', 'angle', '0')
            : (prev?.rotation ?? f.q('rotation', 'angle', '0')),
      layout,
      // radial is kept only while the lattice is polar (a lattice change drops it)
      radial: radial && (polar || a.rotation !== undefined),
      boundary: boundary(),
      margin: f.pick('margin', 'length', a.margin, prev?.margin, 'engravingMargin'),
      fit:
        a.fit ??
        (prev !== undefined && !motifChanged && a.layout === undefined
          ? prev.fit === 'boundary' && layout.kind === 'lattice'
            ? 'clip'
            : prev.fit
          : defaultFit(motif, layout)),
      depth: lineDepthOf(f, a.depth, prev?.depth, () => ({
        kind: 'levels',
        min: f.pick('depth.min', 'length', undefined, undefined, 'lineLevelMin'),
        max: f.pick('depth.max', 'length', undefined, undefined, 'lineLevelMax'),
      })),
    }
  },
}

/** `design.engraving.add` / `.update`; the kind itself is built in (feature.ts). */
export const ENGRAVING_COMMANDS = featureKindCommands(spec).unwrap()
