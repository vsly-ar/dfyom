/**
 * `design.hole.add` / `.update` (v0.4 F3): the hole kind's arguments and how they build a hole,
 * with the refill from the fastener table. Kept terse for `tools/list` (llm-api.md § Implementation).
 * Doc: docs/modes/design-v0.4.md#parameters, docs/modes/design-v0.4.md#implementation-f3
 */
import { z } from 'zod'
import { None, Some, type Option } from '../../shared/result'
import type { Quantity } from '../quantity/quantity'
import { PointArg, Src } from './commands'
import { FASTENER_FITS } from './fastener/data'
import { featureKindCommands, type FeatureCommandSpec } from './feature-commands'
import {
  FASTENER_SIZES,
  fastenerRow,
  HOLE_PURPOSES,
  HOLE_TYPES,
  holeSpec,
  holeTableSizes,
  type Hole,
  type HoleHead,
  type HoleTableSizes,
} from './hole'
import { DEFAULTS } from './operation'
import { DRILL_BOTTOMS } from './part.dto'

const params = {
  center: PointArg,
  type: z.enum(HOLE_TYPES).describe('Default simple'),
  fastener: z
    .enum(FASTENER_SIZES)
    .nullable()
    .describe(
      'Table size (design.fastener.list); with purpose/fit it refills sizes; null = custom',
    ),
  purpose: z.enum(HOLE_PURPOSES).describe('Default clearance; tapDrill: simple only'),
  fit: z.enum(FASTENER_FITS).describe('ISO 273; default normal'),
  diameter: Src.describe('Default from fastener, else 6 mm / 1/4"'),
  bottom: z.enum(DRILL_BOTTOMS).describe('Default through'),
  depth: Src.describe('From the face; not for through'),
  cbDiameter: Src.describe('counterbore; default from fastener'),
  cbDepth: Src.describe('counterbore; default head height + headSink'),
  headSink: Src.describe('Head below the face, for table defaults; default 0.2 mm'),
}

type Args = Partial<z.output<z.ZodObject<typeof params>>>

const spec: FeatureCommandSpec<typeof params, Hole> = {
  ...holeSpec,
  params,
  required: ['center'],
  /**
   * Choosing `fastener`, `purpose` or `fit` (and the add) refills every size not given in the
   * same command; a head that appears (type change) takes the table's sizes; without a fastener
   * its sizes are required. Explicit sizes always win (design-v0.4.md § Parameters).
   */
  build(a: Args, prev, { f, id, name, on }): Hole {
    const units = f.units
    const type = a.type ?? prev?.head.type ?? 'simple'
    const fastener: Option<string> =
      a.fastener === undefined
        ? (prev?.fastener ?? None)
        : a.fastener === null
          ? None
          : Some(a.fastener)
    const purpose = a.purpose ?? prev?.purpose ?? 'clearance'
    const fit = a.fit ?? prev?.fit ?? 'normal'
    const headSink =
      a.headSink !== undefined
        ? f.q('headSink', 'length', a.headSink)
        : (prev?.headSink ?? f.q('headSink', 'length', DEFAULTS.headSink[units]))
    const refill =
      prev === undefined ||
      a.fastener !== undefined ||
      a.purpose !== undefined ||
      a.fit !== undefined
    const row = fastener.isSome() ? fastenerRow(fastener.unwrap()) : undefined
    let table: HoleTableSizes | undefined
    if (row !== undefined && headSink !== undefined) {
      const t = holeTableSizes(row, purpose, fit, headSink, units)
      table = t.isOk() ? t.unwrap() : undefined
    }
    const size = (
      path: 'diameter' | 'cbDiameter' | 'cbDepth',
      old: Quantity | undefined,
      fallback?: string,
    ): Quantity => {
      const src = a[path]
      if (src !== undefined) return f.q(path, 'length', src)
      if (table !== undefined && (refill || old === undefined)) return table[path]
      if (old !== undefined) return old
      if (fallback !== undefined) return f.q(path, 'length', fallback)
      return f.issue(path, 'required', `is required for a ${type} hole without a fastener`)
    }
    const prevHead = prev?.head
    let head: HoleHead
    if (type === 'counterbore') {
      const old = prevHead?.type === 'counterbore' ? prevHead : undefined
      head = {
        type,
        cbDiameter: size('cbDiameter', old?.cbDiameter),
        cbDepth: size('cbDepth', old?.cbDepth),
      }
    } else {
      for (const k of ['cbDiameter', 'cbDepth'] as const)
        if (a[k] !== undefined) f.issue(k, 'notForType', 'is only used with type counterbore')
      head = { type }
    }
    const bottom = a.bottom ?? prev?.bottom ?? 'through'
    const depth: Option<Quantity> =
      a.depth !== undefined
        ? Some(f.q('depth', 'length', a.depth))
        : bottom === 'through'
          ? None
          : (prev?.depth ?? None)
    return {
      kind: 'hole',
      id,
      name,
      on,
      center:
        a.center !== undefined
          ? [f.q('center.0', 'length', a.center[0]), f.q('center.1', 'length', a.center[1])]
          : prev!.center,
      fastener,
      purpose,
      fit,
      diameter: size('diameter', prev?.diameter, DEFAULTS.holeDiameter[units]),
      bottom,
      depth,
      headSink,
      head,
    }
  },
}

/** `design.hole.add` / `.update`; the kind itself is built in (feature.ts). */
export const HOLE_COMMANDS = featureKindCommands(spec).unwrap()
