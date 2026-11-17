/**
 * Quantity kinds and units with exact factors to the canonical unit.
 * Doc: docs/architecture/quantities.md#kinds-and-units
 */
import { Option } from '../../shared/result'
import { Rational } from './rational'

export const QUANTITY_KINDS = [
  'length',
  'angle',
  'feedRate',
  'spindleSpeed',
  'power',
  'scalar',
] as const
export type QuantityKind = (typeof QUANTITY_KINDS)[number]

/** Persisted unit ids. `1` is the dimensionless unit of `scalar` (a bare number). */
export const UNIT_IDS = [
  'mm',
  'cm',
  'm',
  'um',
  'in',
  'ft',
  'deg',
  'mm/min',
  'in/min',
  'rpm',
  'W',
  'kW',
  'hp',
  '1',
  '%',
] as const
export type UnitId = (typeof UNIT_IDS)[number]

export interface UnitInfo {
  readonly kind: QuantityKind
  /** Exact factor: 1 unit = factor × canonical unit. */
  readonly factor: Rational
  /** Accepted spellings; alphabetic ones are matched case-insensitively (stored lower-case). */
  readonly spellings: readonly string[]
}

/** Constant factor; a zero denominator here is a bug, so it throws. */
function r(num: bigint, den = 1n): Rational {
  const q = Rational.create(num, den)
  if (q.isErr()) throw q.unwrapErr()
  return q.unwrap()
}

export const UNITS: Readonly<Record<UnitId, UnitInfo>> = {
  mm: { kind: 'length', factor: r(1n), spellings: ['mm'] },
  cm: { kind: 'length', factor: r(10n), spellings: ['cm'] },
  m: { kind: 'length', factor: r(1000n), spellings: ['m'] },
  um: { kind: 'length', factor: r(1n, 1000n), spellings: ['um', 'µm'] },
  in: { kind: 'length', factor: r(127n, 5n), spellings: ['in', 'inch', '"', '″'] },
  ft: { kind: 'length', factor: r(1524n, 5n), spellings: ['ft', "'", '′'] },
  deg: { kind: 'angle', factor: r(1n), spellings: ['deg', '°'] },
  'mm/min': { kind: 'feedRate', factor: r(1n), spellings: ['mm/min'] },
  'in/min': { kind: 'feedRate', factor: r(127n, 5n), spellings: ['in/min', 'ipm'] },
  rpm: { kind: 'spindleSpeed', factor: r(1n), spellings: ['rpm'] },
  W: { kind: 'power', factor: r(1n), spellings: ['w'] },
  kW: { kind: 'power', factor: r(1000n), spellings: ['kw'] },
  /** Mechanical horsepower: 550 ft·lbf/s = 745.69987158227022 W (exact decimal). */
  hp: { kind: 'power', factor: r(74569987158227022n, 100000000000000n), spellings: ['hp'] },
  '1': { kind: 'scalar', factor: r(1n), spellings: [] },
  '%': { kind: 'scalar', factor: r(1n, 100n), spellings: ['%'] },
}

const BY_SPELLING: ReadonlyMap<string, UnitId> = new Map(
  UNIT_IDS.flatMap((id) => UNITS[id].spellings.map((s) => [s, id] as const)),
)

/** Unit for a spelling as typed (case-insensitive for letters); None if unknown. */
export function unitFromSpelling(spelling: string): Option<UnitId> {
  return Option.nonNull(BY_SPELLING.get(spelling.toLowerCase()))
}

/** All spellings accepted for a kind (for error `expected` params). */
export function spellingsOf(kind: QuantityKind): string[] {
  return UNIT_IDS.filter((id) => UNITS[id].kind === kind).flatMap((id) => UNITS[id].spellings)
}
