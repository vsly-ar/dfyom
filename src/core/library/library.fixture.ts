// Test-only builders for library values. Not app code. Doc: docs/architecture/library.md
import { Quantity } from '../quantity/quantity'
import type { QuantityDTO } from '../quantity/quantity.dto'
import type { QuantityKind, UnitId } from '../quantity/units'

const DEFAULT_UNIT: Record<QuantityKind, UnitId> = {
  length: 'mm',
  angle: 'deg',
  feedRate: 'mm/min',
  spindleSpeed: 'rpm',
  scalar: '1',
}

/** A quantity DTO parsed from what a user would type; throws on a typo (test bug). */
export function qty<K extends QuantityKind>(kind: K, source: string): QuantityDTO & { kind: K } {
  const q = Quantity.parse(source, { kind, defaultUnit: DEFAULT_UNIT[kind] })
  if (q.isErr()) throw q.unwrapErr()
  return q.unwrap().toDTO() as QuantityDTO & { kind: K }
}

export const len = (s: string) => qty('length', s)
export const feed = (s: string) => qty('feedRate', s)
export const rpm = (s: string) => qty('spindleSpeed', s)
export const deg = (s: string) => qty('angle', s)
export const num = (s: string) => qty('scalar', s)

export const stockValues = () => ({
  kind: 'stock' as const,
  name: 'Alu plate 6061',
  shape: 'block' as const,
  length: len('100'),
  width: len('60'),
  thickness: len('10 ±0.1'),
  material: { name: '6061-T6', class: 'aluminum' as const },
})

export const flatEndMillValues = () => ({
  kind: 'tool' as const,
  name: '6 mm 2F flat',
  type: 'flatEndMill' as const,
  diameter: len('6'),
  fluteLength: len('20'),
  overallLength: len('50'),
  fluteCount: num('2'),
  presets: [
    {
      name: 'Alu finish',
      materialClass: 'aluminum' as const,
      spindleSpeed: rpm('18000'),
      feedRate: feed('800'),
      plungeRate: feed('200'),
      stepdown: len('1'),
      stepover: len('3'),
    },
  ],
})

export const machineValues = () => ({
  kind: 'machine' as const,
  name: 'Shapeoko',
  controller: 'grbl' as const,
  travel: { x: len('800'), y: len('800'), z: len('100') },
  maxFeedRate: { x: feed('5000'), y: feed('5000'), z: feed('1000') },
  spindle: { control: 'manual' as const, maxSpeed: rpm('30000') },
  programUnits: 'mm' as const,
  toolChanger: 'none' as const,
})
