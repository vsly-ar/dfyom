/**
 * `suggestCutting`: spindle speed, feed rate, plunge rate and stepdown for one operation, with
 * the derivation of every number and the warnings. Total and pure.
 * Doc: docs/architecture/feeds-speeds.md (Inputs and outputs, Engagement, Hobby-machine realism)
 *
 * Float64 throughout (see formulas.ts); values are in canonical units (rpm, mm/min, mm).
 */
import { None, Some, type Option } from '../../shared/result'
import type { MaterialClass } from '../library/item'
import type { Machine } from '../library/machine'
import type { Rigidity } from '../library/machine.dto'
import type { Tool } from '../library/tool'
import {
  bandOf,
  DEFAULT_RIGIDITY,
  findRow,
  MATERIAL_DATA,
  pick,
  RIGIDITY_FACTORS,
  speedOf,
  type BandData,
  type MaterialRow,
  type Range,
} from './data'
import {
  actf,
  availablePower,
  CHIP_THINNING_CAP,
  chipThinning,
  cuttingPower,
  drillFeed,
  effectiveDiameter,
  feedRate,
  materialRemovalRate,
  plungeRate,
  rctf,
  spindleSpeed,
  surfaceSpeed,
} from './formulas'

/**
 * How the tool engages the material (docs/architecture/feeds-speeds.md#engagement-per-strategy).
 * Lengths in mm. `ap` is the resolved stepdown (override or preset); omitted for `slot` and
 * `stepover`, the calculator suggests it. `helix.ap` is the helix pitch.
 */
export type Engagement =
  | { readonly kind: 'slot'; readonly ap?: number }
  | { readonly kind: 'stepover'; readonly ae: number; readonly ap?: number }
  | { readonly kind: 'helix'; readonly ap: number }
  | { readonly kind: 'drill' }

/** Machine values the calculator uses, in canonical units (rpm, mm/min, W). */
export interface MachineLimits {
  readonly minSpeed: number
  readonly maxSpeed: number
  /** `min(maxFeedRate.x, maxFeedRate.y)`. */
  readonly maxFeedXY: number
  readonly maxFeedZ: number
  readonly power: Option<number>
  readonly rigidity: Rigidity
}

export function machineLimits(m: Machine): MachineLimits {
  return {
    minSpeed: m.spindle.minSpeed.mapOr(0, (q) => q.canonical),
    maxSpeed: m.spindle.maxSpeed.canonical,
    maxFeedXY: Math.min(m.maxFeedRate.x.canonical, m.maxFeedRate.y.canonical),
    maxFeedZ: m.maxFeedRate.z.canonical,
    power: m.spindle.power.map((q) => q.canonical),
    rigidity: m.rigidity.unwrapOr(DEFAULT_RIGIDITY),
  }
}

export interface CuttingInput {
  readonly tool: Tool
  readonly materialClass: MaterialClass
  readonly engagement: Engagement
  readonly machine: Option<MachineLimits>
}

export type StepId =
  | 'data'
  | 'rigidity'
  | 'fluteLength'
  | 'power'
  | 'rpmClamp'
  | 'feedClamp'
  | 'cap'
  | 'F1'
  | 'F2'
  | 'F3'
  | 'F4'
  | 'F5'
  | 'F8'
  | 'F9'

/** One step of an explanation: rendered as a formula/tooltip, returned verbatim to agents. */
export interface DerivationStep {
  readonly step: StepId
  /** Formula or rule as text, e.g. `n = vc·1000 / (π·Dcalc)`. */
  readonly formula: string
  readonly inputs: Readonly<Record<string, number | string>>
  readonly result: number
  readonly unit: string
  /** Citations of the data row (`data` steps only). */
  readonly sources?: readonly string[]
}

export interface Suggested {
  readonly value: number
  readonly unit: 'rpm' | 'mm/min' | 'mm'
  readonly derivation: readonly DerivationStep[]
}

export type CuttingWarningCode =
  | 'feeds.rpmAboveMachine'
  | 'feeds.rpmBelowMachine'
  | 'feeds.feedClamped'
  | 'feeds.rubbing'
  | 'feeds.powerExceeded'
  | 'feeds.powerSkipped'
  | 'feeds.noData'

export interface CuttingWarning {
  readonly code: CuttingWarningCode
  readonly severity: 'warning' | 'info'
  readonly message: string
  readonly params: Readonly<Record<string, number | string>>
}

/** Derived display values (not suggested fields). */
export interface CuttingDisplay {
  /** Diameter used for F1 (De below the corner radius, else D), mm. */
  readonly dCalc: number
  /** Actual surface speed after clamping, m/min. */
  readonly vc: number
  /** Actual chip load after clamping (fz, mm; drills: fn, mm/rev). */
  readonly fz: number
  /** F3 × F5 (capped); 1 for drills. */
  readonly chipThinning: number
  /** F6 material removal rate, mm³/min (milling only). */
  readonly Q: Option<number>
  /** F7 cutting power, kW (milling only). */
  readonly Pc: Option<number>
  /** Pc / Pavail in %, when the machine power is known. */
  readonly spindleLoad: Option<number>
}

export interface CuttingSuggestion {
  readonly spindleSpeed: Option<Suggested>
  readonly feedRate: Option<Suggested>
  readonly plungeRate: Option<Suggested>
  readonly stepdown: Option<Suggested>
  /** Always None in v0.1: stepover is left to the strategy fallback. */
  readonly stepover: Option<Suggested>
  readonly display: Option<CuttingDisplay>
  readonly warnings: readonly CuttingWarning[]
}

/** Power reduction iterations; Pc is near-linear in ap, so 1–3 suffice in practice. */
const MAX_POWER_ITERATIONS = 30
/** Float slack for "below the data minimum" after clamping arithmetic. */
const EPS = 1e-9

/** Suggest feeds and speeds. `data` is the material table (tests pass a fixture). */
export function suggestCutting(
  input: CuttingInput,
  data: readonly MaterialRow[] = MATERIAL_DATA,
): CuttingSuggestion {
  const { tool, materialClass, engagement } = input
  const isDrill = tool.type === 'drill'
  if (isDrill !== (engagement.kind === 'drill'))
    return noData(`engagement "${engagement.kind}" does not fit a ${tool.type}`, {
      engagement: engagement.kind,
      toolType: tool.type,
    })
  if (materialClass === 'other') return noData('no data for material class "other"', {})
  const toolMaterial = tool.toolMaterial.unwrapOr('other')
  if (toolMaterial === 'other')
    return noData('tool material is not set (carbide or HSS needed)', { toolMaterial })
  const row = findRow(data, materialClass, toolMaterial)
  if (row === undefined)
    return noData(`no data for ${toolMaterial} in ${materialClass}`, {
      materialClass,
      toolMaterial,
    })
  const speed = speedOf(row)
  if (speed === undefined)
    return noData(`no speed data for ${toolMaterial} in ${materialClass}`, { materialClass })
  const D = tool.diameter.canonical
  const band = bandOf(row, D)
  const range = band === undefined ? undefined : isDrill ? band.fn : band.fz
  if (band === undefined || range === undefined)
    return noData(`no ${isDrill ? 'fn' : 'fz'} data for a ${D} mm tool`, { diameter: D })

  const rigidity = input.machine.mapOr(DEFAULT_RIGIDITY, (m) => m.rigidity)
  const c: Ctx = { input, row, speed, band, range, rigidity, D }
  return engagement.kind === 'drill' ? drill(c) : mill(c, engagement)
}

interface Ctx {
  readonly input: CuttingInput
  readonly row: MaterialRow
  /** Row speed: surface speed `vc` (F1) or chart spindle speed `n`. */
  readonly speed: { readonly field: 'vc' | 'n'; readonly range: Range }
  readonly band: BandData
  /** `fz` (end mill) or `fn` (drill) range of the band. */
  readonly range: Range
  readonly rigidity: Rigidity
  readonly D: number
}

type MillEngagement = Exclude<Engagement, { kind: 'drill' }>

function mill(c: Ctx, e: MillEngagement): CuttingSuggestion {
  const { tool } = c.input
  const factors = RIGIDITY_FACTORS[c.rigidity]
  const given = e.ap
  if (given !== undefined) return millAt(c, e, given, None).suggestion

  // Calculator-owned stepdown: apSlot × D × apFactor, ≤ fluteLength; reduced to fit the power.
  const fluteLength = tool.fluteLength.canonical
  const raw = c.row.apSlot * c.D * factors.apFactor
  const apSteps: DerivationStep[] = [
    dataStep(c.row, 'apSlot', c.row.apSlot, '× D'),
    {
      step: 'rigidity',
      formula: 'ap = apSlot · D · apFactor',
      inputs: { apSlot: c.row.apSlot, D: c.D, apFactor: factors.apFactor, rigidity: c.rigidity },
      result: raw,
      unit: 'mm',
    },
  ]
  let ap = raw
  if (raw > fluteLength) {
    ap = fluteLength
    apSteps.push({
      step: 'fluteLength',
      formula: 'ap ≤ fluteLength',
      inputs: { ap: raw, fluteLength },
      result: ap,
      unit: 'mm',
    })
  }
  let result = millAt(c, e, ap, Some(apSteps))
  if (!result.exceeded) return result.suggestion
  const first = result.pc
  for (let i = 0; i < MAX_POWER_ITERATIONS && result.exceeded; i++) {
    ap = ap * (result.pAvail / result.pc) * 0.999
    result = millAt(c, e, ap, Some(apSteps))
  }
  const reduced: DerivationStep = {
    step: 'power',
    formula: 'ap reduced until Pc ≤ Pavail',
    inputs: { PcBefore: first, Pavail: result.pAvail },
    result: ap,
    unit: 'mm',
  }
  return millAt(c, e, ap, Some([...apSteps, reduced]), true).suggestion
}

interface MillResult {
  readonly suggestion: CuttingSuggestion
  readonly pc: number
  readonly pAvail: number
  readonly exceeded: boolean
}

function millAt(
  c: Ctx,
  e: MillEngagement,
  ap: number,
  apSteps: Option<DerivationStep[]>,
  powerReduced = false,
): MillResult {
  const { tool, machine } = c.input
  const { D, row } = c
  const warnings: CuttingWarning[] = []
  const pos = RIGIDITY_FACTORS[c.rigidity].rangePos
  const RE = tool.effectiveCornerRadius.toNumber()
  const z = tool.fluteCount.canonical

  // Spindle speed: F4 → F1 (or the chart's n) → clamp.
  const dCalc = effectiveDiameter(D, RE, ap)
  const f4: DerivationStep | undefined =
    RE > 0
      ? {
          step: 'F4',
          formula: 'De = D − 2·RE + 2·√(ap·(2·RE − ap)) if ap < RE, else D',
          inputs: { D, RE, ap },
          result: dCalc,
          unit: 'mm',
        }
      : undefined
  const { n0, steps: nSteps } = dataSpeed(c, pos, dCalc, f4)
  let n = clampRpm(n0, machine, nSteps, warnings)

  // Chip load: F3 × F5, capped.
  const ae = e.kind === 'stepover' ? Math.min(e.ae, D) : D
  const fz = pick(c.range, pos)
  const radial = rctf(ae, D)
  const axial = actf(RE, ap)
  const k = chipThinning(radial, axial)
  const fzSteps: DerivationStep[] = [
    dataStep(row, 'fz', fz, 'mm', c.range),
    {
      step: 'F3',
      formula: 'RCTF = 1 / (2·√((ae/D)·(1 − ae/D))) if ae < D/2, else 1',
      inputs: { ae, D, engagement: e.kind },
      result: radial,
      unit: '×',
    },
    {
      step: 'F5',
      formula: 'ACTF = 1 / sin κ, cos κ = (RE − ap)/RE if ap < RE, else 1',
      inputs: { RE, ap },
      result: axial,
      unit: '×',
    },
  ]
  if (radial * axial > CHIP_THINNING_CAP)
    fzSteps.push({
      step: 'cap',
      formula: `RCTF · ACTF ≤ ${CHIP_THINNING_CAP}`,
      inputs: { RCTF: radial, ACTF: axial },
      result: k,
      unit: '×',
    })
  const fzProg = fz * k

  // Feed rate: F2 → clamp (n lowered to keep fz while n ≥ minSpeed).
  const vf0 = feedRate(n, z, fzProg)
  const vfSteps: DerivationStep[] = [
    {
      step: 'F2',
      formula: 'vf = n · z · fz · RCTF · ACTF',
      inputs: { n, z, fz, factor: k },
      result: vf0,
      unit: 'mm/min',
    },
  ]
  let vf = vf0
  if (machine.isSome() && vf0 > machine.unwrap().maxFeedXY) {
    const m = machine.unwrap()
    vf = m.maxFeedXY
    const keep = vf / (z * fzProg)
    n = Math.max(keep, m.minSpeed)
    vfSteps.push({
      step: 'feedClamp',
      formula: 'vf = min(maxFeedRate.x, .y); n = vf / (z · fz_prog), ≥ minSpeed',
      inputs: { vf: vf0, maxFeedXY: m.maxFeedXY, nKeepingFz: keep, minSpeed: m.minSpeed },
      result: vf,
      unit: 'mm/min',
    })
    nSteps.push({
      step: 'feedClamp',
      formula: 'n = vf / (z · fz_prog), ≥ minSpeed',
      inputs: { vf, z, fzProg, minSpeed: m.minSpeed },
      result: n,
      unit: 'rpm',
    })
    warnings.push(
      warn('feeds.feedClamped', 'Feed rate limited to the machine maximum (X/Y).', {
        suggested: vf0,
        maxFeedRate: m.maxFeedXY,
        spindleSpeed: n,
      }),
    )
  }
  const fzActual = vf / (n * z * k)
  if (fzActual < c.range.min * (1 - EPS))
    warnings.push(
      warn('feeds.rubbing', 'Chips are thinner than the data minimum: the tool rubs and heats.', {
        chipLoad: fzActual,
        minimum: c.range.min,
      }),
    )

  // Plunge: F9 → clamp to Z.
  const pr0 = plungeRate(row.kPlunge, vf)
  const prSteps: DerivationStep[] = [
    dataStep(row, 'kPlunge', row.kPlunge, '×'),
    {
      step: 'F9',
      formula: 'plungeRate = kPlunge · vf',
      inputs: { kPlunge: row.kPlunge, vf },
      result: pr0,
      unit: 'mm/min',
    },
  ]
  const pr = clampZ(pr0, machine, prSteps, warnings)

  // Power: F6, F7 against Pavail.
  const Q = materialRemovalRate(ae, ap, vf)
  const pc = cuttingPower(Q, row.u)
  let pAvail = Infinity
  let spindleLoad: Option<number> = None
  const power = machine.andThen((m) => m.power)
  if (power.isSome()) {
    pAvail = availablePower(power.unwrap(), n, machine.unwrap().maxSpeed)
    spindleLoad = Some((pc / pAvail) * 100)
  } else {
    warnings.push({
      code: 'feeds.powerSkipped',
      severity: 'info',
      message: 'Machine spindle power is not set, so the power check is skipped.',
      params: {},
    })
  }
  const exceeded = pc > pAvail * (1 + EPS)
  if (exceeded || powerReduced)
    warnings.push(
      warn(
        'feeds.powerExceeded',
        apSteps.isSome()
          ? 'Cutting power exceeds the spindle: suggested stepdown reduced to fit.'
          : 'Cutting power exceeds the spindle: reduce stepdown or stepover.',
        { cuttingPower: pc, availablePower: pAvail },
      ),
    )

  const feedDerivation = [...nSteps, ...fzSteps, ...vfSteps]
  return {
    pc,
    pAvail,
    exceeded,
    suggestion: {
      spindleSpeed: Some({ value: n, unit: 'rpm', derivation: nSteps }),
      feedRate: Some({ value: vf, unit: 'mm/min', derivation: feedDerivation }),
      plungeRate: Some({ value: pr, unit: 'mm/min', derivation: [...feedDerivation, ...prSteps] }),
      stepdown: apSteps.map((steps) => ({ value: ap, unit: 'mm' as const, derivation: steps })),
      stepover: None,
      display: Some({
        dCalc,
        vc: surfaceSpeed(n, dCalc),
        fz: fzActual,
        chipThinning: k,
        Q: Some(Q),
        Pc: Some(pc),
        spindleLoad,
      }),
      warnings,
    },
  }
}

/** Drilling: F1 with the drill diameter, F8, plungeRate = feedRate; no power check. */
function drill(c: Ctx): CuttingSuggestion {
  const { machine } = c.input
  const { D, row } = c
  const warnings: CuttingWarning[] = []
  const pos = RIGIDITY_FACTORS[c.rigidity].rangePos
  const { n0, steps: nSteps } = dataSpeed(c, pos, D, undefined)
  let n = clampRpm(n0, machine, nSteps, warnings)
  const fn = pick(c.range, pos)
  const vf0 = drillFeed(fn, n)
  const vfSteps: DerivationStep[] = [
    dataStep(row, 'fn', fn, 'mm/rev', c.range),
    { step: 'F8', formula: 'vf = fn · n', inputs: { fn, n }, result: vf0, unit: 'mm/min' },
  ]
  let vf = vf0
  if (machine.isSome() && vf0 > machine.unwrap().maxFeedZ) {
    const m = machine.unwrap()
    vf = m.maxFeedZ
    const keep = vf / fn
    n = Math.max(keep, m.minSpeed)
    vfSteps.push({
      step: 'feedClamp',
      formula: 'vf = maxFeedRate.z; n = vf / fn, ≥ minSpeed',
      inputs: { vf: vf0, maxFeedZ: m.maxFeedZ, nKeepingFn: keep, minSpeed: m.minSpeed },
      result: vf,
      unit: 'mm/min',
    })
    nSteps.push({
      step: 'feedClamp',
      formula: 'n = vf / fn, ≥ minSpeed',
      inputs: { vf, fn, minSpeed: m.minSpeed },
      result: n,
      unit: 'rpm',
    })
    warnings.push(
      warn('feeds.feedClamped', 'Drilling feed limited to the machine maximum (Z).', {
        suggested: vf0,
        maxFeedRate: m.maxFeedZ,
        spindleSpeed: n,
      }),
    )
  }
  const fnActual = vf / n
  if (fnActual < c.range.min * (1 - EPS))
    warnings.push(
      warn('feeds.rubbing', 'Feed per revolution is below the data minimum: the drill rubs.', {
        feedPerRev: fnActual,
        minimum: c.range.min,
      }),
    )
  const derivation = [...nSteps, ...vfSteps]
  const feed: Suggested = { value: vf, unit: 'mm/min', derivation }
  return {
    spindleSpeed: Some({ value: n, unit: 'rpm', derivation: nSteps }),
    feedRate: Some(feed),
    plungeRate: Some(feed),
    stepdown: None,
    stepover: None,
    display: Some({
      dCalc: D,
      vc: surfaceSpeed(n, D),
      fz: fnActual,
      chipThinning: 1,
      Q: None,
      Pc: None,
      spindleLoad: None,
    }),
    warnings,
  }
}

/**
 * Spindle speed before clamping: F1 from the row's `vc` at `dCalc` (after the F4 step, if any),
 * or the chart spindle speed `n` (router-bit charts; F4 then only affects the actual vc shown).
 */
function dataSpeed(
  c: Ctx,
  pos: number,
  dCalc: number,
  f4: DerivationStep | undefined,
): { n0: number; steps: DerivationStep[] } {
  const { field, range } = c.speed
  const value = pick(range, pos)
  if (field === 'n') return { n0: value, steps: [dataStep(c.row, 'n', value, 'rpm', range)] }
  const n0 = spindleSpeed(value, dCalc)
  const steps = [dataStep(c.row, 'vc', value, 'm/min', range)]
  if (f4 !== undefined) steps.push(f4)
  steps.push({
    step: 'F1',
    formula: 'n = vc·1000 / (π·Dcalc)',
    inputs: { vc: value, Dcalc: dCalc },
    result: n0,
    unit: 'rpm',
  })
  return { n0, steps }
}

function clampRpm(
  n0: number,
  machine: Option<MachineLimits>,
  steps: DerivationStep[],
  warnings: CuttingWarning[],
): number {
  if (machine.isNone()) return n0
  const { minSpeed, maxSpeed } = machine.unwrap()
  if (n0 > maxSpeed) {
    steps.push(clampStep('rpmClamp', 'n ≤ spindle.maxSpeed', { n: n0, maxSpeed }, maxSpeed, 'rpm'))
    warnings.push(
      warn(
        'feeds.rpmAboveMachine',
        'Spindle speed above the machine maximum: runs at the maximum with the same chip load (lower surface speed).',
        { suggested: n0, maxSpeed },
      ),
    )
    return maxSpeed
  }
  if (n0 < minSpeed) {
    steps.push(clampStep('rpmClamp', 'n ≥ spindle.minSpeed', { n: n0, minSpeed }, minSpeed, 'rpm'))
    warnings.push(
      warn(
        'feeds.rpmBelowMachine',
        'Spindle speed below the machine minimum: surface speed too high (heat, wear). Consider a smaller tool or fewer flutes.',
        { suggested: n0, minSpeed },
      ),
    )
    return minSpeed
  }
  return n0
}

function clampZ(
  v: number,
  machine: Option<MachineLimits>,
  steps: DerivationStep[],
  warnings: CuttingWarning[],
): number {
  if (machine.isNone() || v <= machine.unwrap().maxFeedZ) return v
  const { maxFeedZ } = machine.unwrap()
  steps.push(
    clampStep('feedClamp', 'plungeRate ≤ maxFeedRate.z', { v, maxFeedZ }, maxFeedZ, 'mm/min'),
  )
  warnings.push(
    warn('feeds.feedClamped', 'Plunge rate limited to the machine maximum (Z).', {
      suggested: v,
      maxFeedRate: maxFeedZ,
    }),
  )
  return maxFeedZ
}

const clampStep = (
  step: StepId,
  formula: string,
  inputs: Record<string, number>,
  result: number,
  unit: string,
): DerivationStep => ({ step, formula, inputs, result, unit })

function dataStep(
  row: MaterialRow,
  field: 'vc' | 'n' | 'fz' | 'fn' | 'apSlot' | 'kPlunge',
  result: number,
  unit: string,
  range?: Range,
): DerivationStep {
  const inputs: Record<string, number | string> = {
    field,
    materialClass: row.materialClass,
    toolMaterial: row.toolMaterial,
  }
  if (range !== undefined) Object.assign(inputs, { min: range.min, max: range.max })
  const estimated = row.estimated?.includes(field) === true
  return {
    step: 'data',
    formula:
      range === undefined
        ? `${field} from the material table`
        : `${field} = min + rangePos · (max − min)`,
    inputs: estimated ? { ...inputs, estimated: 'yes' } : inputs,
    result,
    unit,
    sources: row.sources.filter((s) => s.fields.includes(field)).map((s) => s.ref),
  }
}

const warn = (
  code: CuttingWarningCode,
  message: string,
  params: Record<string, number | string>,
): CuttingWarning => ({ code, severity: 'warning', message, params })

function noData(reason: string, params: Record<string, number | string>): CuttingSuggestion {
  return {
    spindleSpeed: None,
    feedRate: None,
    plungeRate: None,
    stepdown: None,
    stepover: None,
    display: None,
    warnings: [warn('feeds.noData', `No feeds-and-speeds data: ${reason}.`, params)],
  }
}
