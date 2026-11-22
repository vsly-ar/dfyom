// Test-only feature kind `probe` (not app code): a circular pocket with an optional drilling on
// its floor, like a counterbore, so the feature model (F1) is proved end to end before the real
// kinds exist (hole F3, Clones F5). Doc: docs/modes/design-v0.4.md#implementation-f1
import { z } from 'zod'
import { collect, None, Ok, type AppResult } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { quantityFromDTO } from '../library/item'
import { Quantity } from '../quantity/quantity'
import { PointArg, Src } from './commands'
import type { FeatureBase } from './feature'
import { featureKindCommands, type FeatureCommandSpec } from './feature-commands'
import type { FeatureDTO } from './feature.dto'
import { CENTRE_ANCHOR, fieldContext, type Point } from './operation'
import type { QuantityDTO } from '../quantity/quantity.dto'

export interface Probe extends FeatureBase {
  readonly kind: 'probe'
  readonly center: Point
  readonly diameter: Quantity
  readonly depth: Quantity
  readonly drillDiameter: Quantity
  /** false: the `drill` role disappears. */
  readonly drill: boolean
}

const params = {
  center: PointArg,
  diameter: Src,
  depth: Src,
  drillDiameter: Src,
  drill: z.boolean(),
}

const q = (dto: unknown, path: string) => quantityFromDTO(dto as QuantityDTO, path)

export const probeSpec: FeatureCommandSpec<typeof params, Probe> = {
  kind: 'probe',
  idPrefix: 'probe',
  label: 'Probe',
  params,
  required: ['center', 'diameter', 'depth', 'drillDiameter'],
  build: (a, prev, { f, id, name, on }) => ({
    kind: 'probe',
    id,
    name,
    on,
    center:
      a.center !== undefined
        ? [f.q('center.0', 'length', a.center[0]), f.q('center.1', 'length', a.center[1])]
        : prev!.center,
    diameter: f.val('diameter', 'length', a.diameter, prev?.diameter),
    depth: f.val('depth', 'length', a.depth, prev?.depth),
    drillDiameter: f.val('drillDiameter', 'length', a.drillDiameter, prev?.drillDiameter),
    drill: a.drill ?? prev?.drill ?? true,
  }),
  fromDTO(dto: FeatureDTO): AppResult<Probe> {
    const d = dto as FeatureDTO & Record<string, unknown>
    const c = d['center'] as unknown[]
    const fields = [
      q(c[0], 'center'),
      q(c[1], 'center'),
      q(d['diameter'], 'diameter'),
      q(d['depth'], 'depth'),
      q(d['drillDiameter'], 'drillDiameter'),
    ]
    return collect(fields).map(([u, v, diameter, depth, drillDiameter]) => ({
      kind: 'probe',
      id: dto.id,
      name: dto.name,
      on: dto.on,
      center: [u!, v!],
      diameter: diameter!,
      depth: depth!,
      drillDiameter: drillDiameter!,
      drill: d['drill'] !== false,
    }))
  },
  toDTO: (p) => ({
    id: p.id,
    kind: 'probe',
    name: p.name,
    on: p.on,
    center: [p.center[0].toDTO(), p.center[1].toDTO()],
    diameter: p.diameter.toDTO(),
    depth: p.depth.toDTO(),
    drillDiameter: p.drillDiameter.toDTO(),
    ...(p.drill ? {} : { drill: false }),
  }),
  invariants: (p) =>
    p.drillDiameter.canonical < p.diameter.canonical
      ? []
      : [
          {
            path: ['drillDiameter'],
            rule: 'drillInside',
            message: 'must be less than the diameter',
          },
        ],
  expand: (p, ctx) =>
    Ok([
      {
        role: 'pocket',
        operation: {
          kind: 'pocket',
          on: p.on,
          shape: { kind: 'circle', center: p.center, anchor: CENTRE_ANCHOR, diameter: p.diameter },
          depth: p.depth,
          floorRadius: Quantity.parse('0', fieldContext('length', ctx.units)).unwrap(),
        },
      },
      ...(p.drill
        ? [
            {
              role: 'drill',
              operation: {
                kind: 'drilling' as const,
                on: `${ctx.ownedId('pocket')}.floor`,
                center: p.center,
                diameter: p.drillDiameter,
                bottom: 'through' as const,
                depth: None,
                pointAngle: None,
              },
            },
          ]
        : []),
    ]),
}

/** `design.probe.add` / `.update`; registers the kind once per module instance. */
export const PROBE_COMMANDS = expectOk(featureKindCommands(probeSpec))
