// Adjust steps of a value field (DF104): one ladder table keyed by step kind (what the field
// measures), the preselected step (kind default lowered to the value), scaling to the stock and
// machine limits, integer ladders. Pure and presentation-only (not core). Ladders are decimal
// source strings in the field's display unit, so stepping keeps exact rationals (`stepRational`).
// Doc: docs/conventions/inspector-layout.md#field-step-model-df104 (rules 1–8, the step kinds
// table and the per-field assignment table are the source of truth).

/** What a value field measures, for its steps (inspector-layout.md § Step kinds). */
export type StepKind =
  | 'depth'
  | 'stepdown'
  | 'xy'
  | 'small'
  | 'fit'
  | 'tolerance'
  | 'angle'
  | 'rotation'
  | 'count'
  | 'feed'
  | 'rpm'
  | 'percent'
  | 'scale'
  | 'machine'

export type UnitSystem = 'metric' | 'imperial'

/** Where a kind's cap comes from: steps above half of it are hidden (rule 5). */
export type CapSource = 'thickness' | 'side' | 'maxFeed' | 'maxRpm' | 'max'

export interface StepLadder {
  readonly metric: readonly string[]
  readonly imperial: readonly string[]
  readonly default: { readonly metric: string; readonly imperial: string }
  readonly cap?: CapSource
  /** Integer field: integer steps only, no Alt (×0.1) on ↑/↓ (rule 6). */
  readonly integer?: boolean
}

const same = (steps: readonly string[], d: string) =>
  ({ metric: steps, imperial: steps, default: { metric: d, imperial: d } }) as const

/** The single ladder table (rule 1); keep in step with the doc's Step kinds table. */
export const STEP_LADDERS: Readonly<Record<StepKind, StepLadder>> = {
  depth: {
    metric: ['0.01', '0.1', '0.5', '1', '5', '10'],
    imperial: ['0.001', '0.01', '0.05', '0.1', '0.5', '1'],
    default: { metric: '0.1', imperial: '0.01' },
    cap: 'thickness',
  },
  stepdown: {
    metric: ['0.01', '0.05', '0.1', '0.5', '1'],
    imperial: ['0.001', '0.005', '0.01', '0.05'],
    default: { metric: '0.1', imperial: '0.01' },
    cap: 'thickness',
  },
  xy: {
    metric: ['0.1', '0.5', '1', '5', '10', '50'],
    imperial: ['0.01', '0.05', '0.1', '0.5', '1', '5'],
    default: { metric: '1', imperial: '0.1' },
    cap: 'side',
  },
  small: {
    metric: ['0.01', '0.1', '0.5', '1', '5'],
    imperial: ['0.001', '0.01', '0.05', '0.1', '0.5'],
    default: { metric: '0.1', imperial: '0.01' },
    cap: 'side',
  },
  fit: {
    metric: ['0.005', '0.01', '0.05', '0.1'],
    imperial: ['0.0005', '0.001', '0.005'],
    default: { metric: '0.01', imperial: '0.001' },
  },
  tolerance: {
    metric: ['0.001', '0.005', '0.01', '0.05', '0.1'],
    imperial: ['0.0001', '0.0005', '0.001', '0.005'],
    default: { metric: '0.01', imperial: '0.001' },
  },
  angle: same(['0.1', '1', '5', '15'], '1'),
  rotation: same(['1', '5', '15', '45', '90'], '15'),
  count: { ...same(['1', '2', '5', '10'], '1'), cap: 'max', integer: true },
  feed: {
    metric: ['10', '50', '100', '500', '1000'],
    imperial: ['1', '5', '10', '50'],
    default: { metric: '100', imperial: '10' },
    cap: 'maxFeed',
  },
  rpm: { ...same(['100', '500', '1000', '5000'], '1000'), cap: 'maxRpm' },
  percent: same(['1', '5', '10', '25'], '5'),
  scale: same(['0.001', '0.01', '0.1', '1'], '0.01'),
  machine: same(['0.1', '1', '10', '100', '1000'], '10'),
}

/**
 * The limits steps scale to (rule 5), in canonical units (mm, mm/min, rpm); absent = no cap.
 * Inspectors provide them for the part and machine they show (`StepScaleProvider`).
 */
export interface StepScale {
  /** Stock thickness, mm. */
  readonly thickness?: number | undefined
  /** Largest stock side, mm. */
  readonly side?: number | undefined
  /** The machine's maximum feed, mm/min. */
  readonly maxFeed?: number | undefined
  /** The machine's maximum spindle speed, rpm. */
  readonly maxRpm?: number | undefined
}

interface Measure {
  readonly canonical: number
}

/** The caps of a stock (canonical mm quantities); undefined without one. */
export function stockStepScale(
  stock: { length: Measure; width: Measure; thickness: Measure } | undefined,
  machine?: { maxFeed?: number | undefined; maxRpm?: number | undefined },
): StepScale | undefined {
  if (stock === undefined && machine === undefined) return undefined
  return {
    ...(stock === undefined
      ? {}
      : {
          thickness: stock.thickness.canonical,
          side: Math.max(stock.length.canonical, stock.width.canonical),
        }),
    ...machine,
  }
}

export interface StepsInput {
  /** The field's current magnitude in its display unit; undefined = empty or unreadable. */
  readonly value?: number | undefined
  readonly unitSystem: UnitSystem
  readonly scale?: StepScale | undefined
  /** The field's maximum (count fields), in its display unit. */
  readonly max?: number | undefined
  /** A step the user chose earlier this session for this field (rule 4). */
  readonly remembered?: string | undefined
}

export interface Steps {
  /** The ladder after scaling: 3–6 steps, smallest first. */
  readonly steps: readonly string[]
  /** The preselected step (always one of `steps`). */
  readonly initial: string
  readonly integer: boolean
}

const MIN_STEPS = 3
const MAX_STEPS = 6
const MM_PER_INCH = 25.4

/** Steps and the preselected step of a field (rules 3–6). */
export function stepsFor(kind: StepKind, input: StepsInput): Steps {
  const ladder = STEP_LADDERS[kind]
  const all = ladder[input.unitSystem]
  const cap = capOf(ladder.cap, input)
  const fitting = cap === undefined ? all : all.filter((s) => Number(s) <= cap / 2)
  const steps = (fitting.length >= MIN_STEPS ? fitting : all.slice(0, MIN_STEPS)).slice(
    0,
    MAX_STEPS,
  )
  const integer = ladder.integer === true
  if (input.remembered !== undefined && steps.includes(input.remembered))
    return { steps, initial: input.remembered, integer }
  const kindDefault = ladder.default[input.unitSystem]
  let target = Number(kindDefault)
  const v = input.value === undefined ? 0 : Math.abs(input.value)
  if (Number.isFinite(v) && v > 0 && v / 2 < target) target = v / 2
  const initial = steps.filter((s) => Number(s) <= target).at(-1) ?? steps[0] ?? kindDefault
  return { steps, initial, integer }
}

function capOf(source: CapSource | undefined, input: StepsInput): number | undefined {
  const per = input.unitSystem === 'imperial' ? MM_PER_INCH : 1
  const s = input.scale
  switch (source) {
    case 'thickness':
      return s?.thickness === undefined ? undefined : s.thickness / per
    case 'side':
      return s?.side === undefined ? undefined : s.side / per
    case 'maxFeed':
      return s?.maxFeed === undefined ? undefined : s.maxFeed / per
    case 'maxRpm':
      return s?.maxRpm
    case 'max':
      // the ladder stops at the field's maximum: steps up to half of it (rule 6)
      return input.max
    default:
      return undefined
  }
}

/** The display unit's system: inch units take the imperial ladder. */
export function unitSystemOf(unit: string): UnitSystem {
  return unit === 'in' || unit === 'ft' || unit === 'in/min' ? 'imperial' : 'metric'
}

/** A step's label in the panel: `.1`, `1`, `10` (rule 7). */
export const stepLabel = (step: string): string => step.replace(/^0\./, '.')
