/**
 * `design.engraving.add` / `.update` (engraved-patterns.md E3): the engraved pattern kind's
 * arguments and how they build one. Kept lean for `tools/list` (E1–E3 share ≤ 3.0 K, EP-H): the
 * preset ids are in the primer, not an enum; `boundary` and `depth` are listed as sketches of
 * `design.pattern.add` and `design.line.add` (validated in full, the doc's first listed cut: the
 * depth union described once); `update` sketches every structured arg. Layout `single` only: the
 * lattice args come with E4, as sketches of `design.pattern.add`'s.
 * Doc: docs/modes/engraved-patterns.md#agent-api, docs/modes/engraved-patterns.md#implementation-e3
 */
import { z } from 'zod'
import { None, Some, type Option } from '../../../shared/result'
import type { Quantity } from '../../quantity/quantity'
import { LineDepthArg, lineDepthOf, PointArg, Src } from '../commands'
import { featureKindCommands, type FeatureCommandSpec } from '../feature-commands'
import type { Point } from '../operation'
import type { PatternBoundary } from '../pattern/pattern'
import { ShapeIdSchema } from '../shape.dto'
import { defaultFit, engravingSpec, type Engraving, type EngravingMotif } from './engraving'

/** The motif a new engraved pattern takes (E3: the round Rosette, fitted; doc default `waves` is E4's). */
export const DEFAULT_ENGRAVING_PRESET = 'rosette'

const BoundaryArg = z
  .object({ shapeId: ShapeIdSchema, center: PointArg, rotation: Src.optional() })
  .nullable()

const params = {
  motif: z
    .union([
      z.object({ preset: z.string().min(1).max(64) }),
      z.object({ shapeIds: z.array(ShapeIdSchema).min(1).max(50) }),
    ])
    .describe('preset id (primer), or shapes with levels; default rosette'),
  center: PointArg.nullable().describe('Motif centre; null = area centre'),
  size: Src.nullable().describe('Motif width; null = its own'),
  rotation: Src.describe('Default 0°'),
  boundary: BoundaryArg,
  margin: Src.describe('Default 3 mm'),
  fit: z.enum(['whole', 'boundary']).describe('boundary: scaled to fit, centred (round: default)'),
  depth: LineDepthArg,
}

type Args = Partial<z.output<z.ZodObject<typeof params>>>

const spec: FeatureCommandSpec<typeof params, Engraving> = {
  ...engravingSpec,
  params,
  required: [],
  addParams: {
    boundary: z.unknown().describe('As design.pattern.add boundary'),
    depth: z.unknown().describe('As design.line.add depth; default {min 0.2, max 1 mm}'),
  },
  updateParams: {
    motif: z.unknown().describe('As design.engraving.add motif'),
    center: z.unknown().describe('As design.engraving.add center'),
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
    // a new motif takes its own default fit unless one is given (a round preset fits)
    const motifChanged =
      a.motif !== undefined && JSON.stringify(motif) !== JSON.stringify(prev?.motif)
    return {
      kind: 'engraving',
      id,
      name,
      on,
      motif,
      center,
      size,
      rotation:
        a.rotation !== undefined
          ? f.q('rotation', 'angle', a.rotation)
          : (prev?.rotation ?? f.q('rotation', 'angle', '0')),
      boundary: boundary(),
      margin: f.pick('margin', 'length', a.margin, prev?.margin, 'engravingMargin'),
      fit: a.fit ?? (prev !== undefined && !motifChanged ? prev.fit : defaultFit(motif)),
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
