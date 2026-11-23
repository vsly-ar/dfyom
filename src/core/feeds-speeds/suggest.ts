/**
 * `suggestCutting`: spindle speed, feed rate, plunge rate and stepdown for one operation, with
 * the derivation of every number and the warnings. Total and pure.
 * Doc: docs/architecture/feeds-speeds.md (Inputs and outputs, Engagement, Hobby-machine realism)
 *
 * Float64 throughout (see formulas.ts); values are in canonical units (rpm, mm/min, mm).
 */
import { None, Option, Some } from '../../shared/result'
import { MATERIAL_CLASS_WORDS, type MaterialClass } from '../library/item'
import type { Machine } from '../library/machine'
import type { Rigidity } from '../library/machine.dto'
import type { Tool } from '../library/tool'
import { TOOL_TYPE_LABEL } from '../design/tool'
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
  chamferEffectiveDiameter,
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
 * Lengths in mm. `stepover.ae` is the strategy's stepover, `helix.ap` the helix pitch. The
 * stepdown is the calculator's unless locked (`CuttingInput.locked.ap`).
 */
export type Engagement =
  | { readonly kind: 'slot' }
  | { readonly kind: 'stepover'; readonly ae: number }
  | { readonly kind: 'helix'; readonly ap: number }
  | { readonly kind: 'drill' }
  /** A chamfer mill cutting `depth` mm below its tip (F10: speed and chip load at De). */
  | { readonly kind: 'chamfer'; readonly depth: number }

/** The engagement's fixed axial depth: the helix pitch or the chamfer depth; else undefined. */
export const fixedAp = (e: Engagement): number | undefined =>
  e.kind === 'helix' ? e.ap : e.kind === 'chamfer' ? e.depth : undefined

/**
 * Locked values: fixed inputs the calculator recommends every other field around, in canonical
 * units (rpm, mm/min, mm). `ap` is a locked stepdown (milling, not helix), `ae` a locked facing
 * stepover (`stepover` engagement only). Doc: docs/architecture/feeds-speeds.md#locked-inputs
 */
export interface LockedInputs {
  readonly n?: number
  readonly vf?: number
  readonly ap?: number
  readonly ae?: number
}

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
  /** Locked inputs; omitted = none. */
  readonly locked?: LockedInputs
}

export type StepId =
  | 'data'
  | 'rigidity'
  | 'fluteLength'
  | 'power'
  | 'rpmClamp'
  | 'feedClamp'
  | 'cap'
  | 'locked'
  | 'F1'
  | 'F2'
  | 'F3'
  | 'F4'
  | 'F5'
  | 'F8'
  | 'F9'
  | 'F10'
  | 'fzScale'

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
  | 'feeds.chipLoadHigh'
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
  const found = contextOf(input, data)
  if ('noData' in found) return found.noData
  const { engagement } = input
  return engagement.kind === 'drill' ? drill(found.ctx) : mill(found.ctx, engagement)
}

/** The `feeds.noData` warning when the calculator has no data for this input, else None. */
export function noDataFor(
  input: CuttingInput,
  data: readonly MaterialRow[] = MATERIAL_DATA,
): Option<CuttingWarning> {
  const found = contextOf(input, data)
  return 'noData' in found ? Option.nonNull(found.noData.warnings[0]) : None
}

/** Tool materials in words for visible text (DF44): never the enum key. */
const TOOL_MATERIAL_WORDS = { carbide: 'carbide', hss: 'HSS', other: 'other' } as const

type Lookup = { readonly ctx: Ctx } | { readonly noData: CuttingSuggestion }

function contextOf(input: CuttingInput, data: readonly MaterialRow[]): Lookup {
  const { tool, materialClass, engagement } = input
  const isDrill = tool.type === 'drill'
  const none = (reason: string, params: Record<string, number | string>): Lookup => ({
    noData: noData(reason, params),
  })
  const isChamfer = tool.type === 'chamferMill'
  if (isDrill !== (engagement.kind === 'drill') || isChamfer !== (engagement.kind === 'chamfer'))
    return none(`a ${engagement.kind} cut does not fit a ${TOOL_TYPE_LABEL[tool.type]}`, {
      engagement: engagement.kind,
      toolType: tool.type,
    })
  if (materialClass === 'other') return none('no data for the material class "other"', {})
  const toolMaterial = tool.toolMaterial.unwrapOr('other')
  if (toolMaterial === 'other')
    return none('tool material is not set (carbide or HSS needed)', { toolMaterial })
  const row = findRow(data, materialClass, toolMaterial)
  if (row === undefined)
    return none(
      `no data for ${TOOL_MATERIAL_WORDS[toolMaterial]} in ${MATERIAL_CLASS_WORDS[materialClass]}`,
      {
        materialClass,
        toolMaterial,
      },
    )
  const speed = speedOf(row)
  if (speed === undefined)
    return none(
      `no speed data for ${TOOL_MATERIAL_WORDS[toolMaterial]} in ${MATERIAL_CLASS_WORDS[materialClass]}`,
      { materialClass },
    )
  // a chamfer mill is treated as a flat end mill of its effective diameter at the depth (F10)
  const chamfer = engagement.kind === 'chamfer' ? chamferStep(tool, engagement.depth) : undefined
  const D = chamfer?.result ?? tool.diameter.canonical
  if (!isDrill && chamfer === undefined && D > 0 && D < MIN_END_MILL_DIAMETER)
    return none(`end mills under ${MIN_END_MILL_DIAMETER} mm need entered values`, {
      diameter: D,
    })
  // below the smallest charted diameter (a chamfer's De: 1/8"; an end mill: 1/16"), that chart's
  // fz scaled by the diameter (fzScale; feeds-speeds.md#small-end-mills-hardening-df39)
  const chartD = chamfer !== undefined ? CHART_MIN_DIAMETER : SMALL_CHART_DIAMETER
  const scaled = !isDrill && D > 0 && D < chartD
  const band = bandOf(row, scaled ? chartD : D)
  const chart = band === undefined ? undefined : isDrill ? band.fn : band.fz
  if (band === undefined || chart === undefined)
    return none(`no ${isDrill ? 'fn' : 'fz'} data for a ${D} mm tool`, { diameter: D })
  const factor = D / chartD
  const fzScale = scaled ? { chart, factor, chartDiameter: chartD } : undefined
  const range = fzScale === undefined ? chart : { min: chart.min * factor, max: chart.max * factor }
  const rigidity = input.machine.mapOr(DEFAULT_RIGIDITY, (m) => m.rigidity)
  const locked = input.locked ?? {}
  return {
    ctx: {
      input,
      row,
      speed,
      band,
      range,
      rigidity,
      D,
      locked,
      ...(chamfer && { chamfer }),
      ...(fzScale && { fzScale }),
    },
  }
}

/**
 * The smallest charted tool diameter (1/8″, the ≤ 6 mm band's representative,
 * docs/architecture/feeds-speeds.md#chamfer-mills-v04): a chamfer whose De is smaller takes that
 * chip load × De / 3.175 (chip load proportional to the effective diameter).
 */
export const CHART_MIN_DIAMETER = 3.175
/**
 * The smallest charted end-mill diameter (1/16", the ≤ 3 mm band's representative in the router
 * rows): an end mill below it takes that chip load × D / 1.5875 (hardening DF39).
 */
export const SMALL_CHART_DIAMETER = 1.5875
/** End mills below this diameter (mm) get no calculator data: slender tools break (DF39). */
export const MIN_END_MILL_DIAMETER = 1

/** F10: the chamfer mill's effective diameter at `depth` below its tip. */
function chamferStep(tool: Tool, depth: number): DerivationStep {
  const DC = tool.diameter.canonical
  const dt = tool.tipDiameterMm
  const angle = tool.angle.mapOr(90, (q) => q.canonical)
  return {
    step: 'F10',
    formula: 'De = dt + 2·depth·tan(α/2), ≤ DC',
    inputs: { dt, depth, angle, DC },
    result: chamferEffectiveDiameter(dt, depth, angle, DC),
    unit: 'mm',
  }
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
  /** Tool diameter, or a chamfer mill's effective diameter De (F10). */
  readonly D: number
  readonly locked: LockedInputs
  /** Chamfer engagement: the F10 step that gave `D`. */
  readonly chamfer?: DerivationStep
  /**
   * D (a chamfer's De) below the smallest charted diameter: the chart's `fz` range and the factor
   * D / chartDiameter (3.175 for a chamfer's De, 1.5875 for an end mill).
   */
  readonly fzScale?: {
    readonly chart: Range
    readonly factor: number
    readonly chartDiameter: number
  }
}

type MillEngagement = Exclude<Engagement, { kind: 'drill' }>

function mill(c: Ctx, e: MillEngagement): CuttingSuggestion {
  const { tool } = c.input
  const factors = RIGIDITY_FACTORS[c.rigidity]
  // Pocket and profile engage as a slot whatever the stepover; facing uses a locked stepover.
  const ae = e.kind === 'stepover' ? Math.min(c.locked.ae ?? e.ae, c.D) : c.D
  // A fixed stepdown (locked, the helix pitch or the chamfer depth) is used, not suggested.
  const fixed = fixedAp(e) ?? c.locked.ap
  if (fixed !== undefined) return millAt(c, ae, fixed, None).suggestion

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
  let result = millAt(c, ae, ap, Some(apSteps))
  if (!result.exceeded) return result.suggestion
  const first = result.pc
  for (let i = 0; i < MAX_POWER_ITERATIONS && result.exceeded; i++) {
    ap = ap * (result.pAvail / result.pc) * 0.999
    result = millAt(c, ae, ap, Some(apSteps))
  }
  const reduced: DerivationStep = {
    step: 'power',
    formula: 'ap reduced until Pc ≤ Pavail',
    inputs: { PcBefore: first, Pavail: result.pAvail },
    result: ap,
    unit: 'mm',
  }
  return millAt(c, ae, ap, Some([...apSteps, reduced]), true).suggestion
}

interface MillResult {
  readonly suggestion: CuttingSuggestion
  readonly pc: number
  readonly pAvail: number
  readonly exceeded: boolean
}

/**
 * One milling evaluation at stepdown `ap` (`apSteps` Some = calculator-owned). Locked `n`/`vf`
 * replace their recommendation (docs/architecture/feeds-speeds.md#locked-inputs). With a fixed
 * stepdown, a power excess reduces an unlocked feed (n kept, fz drops); a locked one only warns.
 */
function millAt(
  c: Ctx,
  ae: number,
  ap: number,
  apSteps: Option<DerivationStep[]>,
  powerReduced = false,
): MillResult {
  const { tool, machine, engagement } = c.input
  const { D, row, locked: L } = c
  const warnings: CuttingWarning[] = []
  const pos = RIGIDITY_FACTORS[c.rigidity].rangePos
  const RE = tool.effectiveCornerRadius.toNumber()
  const z = tool.fluteCount.canonical

  // Chip load: F3 × F5, capped.
  const fz = pick(c.range, pos)
  const radial = rctf(ae, D)
  const axial = actf(RE, ap)
  const k = chipThinning(radial, axial)
  const fzSteps: DerivationStep[] = [
    // a chart rpm skips F1, so the chamfer's De (it picked the fz band) shows here
    ...(c.chamfer !== undefined && c.speed.field === 'n' ? [c.chamfer] : []),
    ...(c.fzScale === undefined
      ? [dataStep(row, 'fz', fz, 'mm', c.range)]
      : [
          dataStep(row, 'fz', pick(c.fzScale.chart, pos), 'mm', c.fzScale.chart),
          {
            step: 'fzScale' as const,
            formula:
              c.chamfer === undefined
                ? `fz = fz(${c.fzScale.chartDiameter} mm) · D / ${c.fzScale.chartDiameter}`
                : `fz = fz(${c.fzScale.chartDiameter} mm) · De / ${c.fzScale.chartDiameter}`,
            inputs:
              c.chamfer === undefined
                ? { fz: pick(c.fzScale.chart, pos), D, factor: c.fzScale.factor }
                : { fz: pick(c.fzScale.chart, pos), De: D, factor: c.fzScale.factor },
            result: fz,
            unit: 'mm',
          },
        ]),
    {
      step: 'F3',
      formula: 'RCTF = 1 / (2·√((ae/D)·(1 − ae/D))) if ae < D/2, else 1',
      inputs: { ae, D, engagement: engagement.kind },
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

  // Spindle speed: locked; or following a locked feed (data chip load); or F4 → F1 → clamp.
  const dCalc = effectiveDiameter(D, RE, ap)
  let n: number
  let nSteps: DerivationStep[]
  if (L.n !== undefined) {
    n = L.n
    nSteps = [lockedStep('n', L.n, 'rpm')]
  } else if (L.vf !== undefined) {
    const n0 = L.vf / (z * fzProg)
    nSteps = [
      {
        step: 'F2',
        formula: 'n = vf / (z · fz · RCTF · ACTF)',
        inputs: { vf: L.vf, z, fz, factor: k },
        result: n0,
        unit: 'rpm',
      },
    ]
    n = clampToSpindle(n0, machine, nSteps)
  } else {
    const f4: DerivationStep | undefined =
      c.chamfer ??
      (RE > 0
        ? {
            step: 'F4',
            formula: 'De = D − 2·RE + 2·√(ap·(2·RE − ap)) if ap < RE, else D',
            inputs: { D, RE, ap },
            result: dCalc,
            unit: 'mm',
          }
        : undefined)
    const speed = dataSpeed(c, pos, dCalc, f4)
    nSteps = speed.steps
    n = clampRpm(speed.n0, machine, nSteps, warnings)
  }

  // Feed rate: locked; or F2 → clamp (an unlocked n is lowered to keep fz while ≥ minSpeed).
  let vf: number
  let vfSteps: DerivationStep[]
  if (L.vf !== undefined) {
    vf = L.vf
    vfSteps = [lockedStep('vf', L.vf, 'mm/min')]
  } else {
    const vf0 = feedRate(n, z, fzProg)
    vfSteps = [
      {
        step: 'F2',
        formula: 'vf = n · z · fz · RCTF · ACTF',
        inputs: { n, z, fz, factor: k },
        result: vf0,
        unit: 'mm/min',
      },
    ]
    vf = vf0
    if (machine.isSome() && vf0 > machine.unwrap().maxFeedXY) {
      const m = machine.unwrap()
      vf = m.maxFeedXY
      const n0 = n
      if (L.n === undefined) {
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
      } else {
        vfSteps.push({
          step: 'feedClamp',
          formula: 'vf = min(maxFeedRate.x, .y); n locked, fz drops',
          inputs: { vf: vf0, maxFeedXY: m.maxFeedXY },
          result: vf,
          unit: 'mm/min',
        })
      }
      warnings.push(
        feedClampedWarning('Feed rate limited to the machine maximum (X/Y)', false, {
          vf0,
          vf,
          max: m.maxFeedXY,
          n0,
          n,
          perRev: z,
          locked: L.n !== undefined,
        }),
      )
    }
  }

  // Power: F6, F7 against Pavail; with a fixed stepdown an unlocked feed absorbs an excess.
  const power = machine.andThen((m) => m.power)
  const pAvail = power.isSome()
    ? availablePower(power.unwrap(), n, machine.unwrap().maxSpeed)
    : Infinity
  let Q = materialRemovalRate(ae, ap, vf)
  let pc = cuttingPower(Q, row.u)
  let exceeded = pc > pAvail * (1 + EPS)
  let feedReduced = false
  if (exceeded && apSteps.isNone() && L.vf === undefined) {
    const before = vf
    vf = vf * (pAvail / pc) * 0.999
    vfSteps.push({
      step: 'power',
      formula: 'vf reduced until Pc ≤ Pavail (n kept)',
      inputs: { vf: before, PcBefore: pc, Pavail: pAvail },
      result: vf,
      unit: 'mm/min',
    })
    Q = materialRemovalRate(ae, ap, vf)
    pc = cuttingPower(Q, row.u)
    exceeded = false
    feedReduced = true
  }

  const fzActual = vf / (n * z * k)
  warnings.push(...chipLoadWarnings(fzActual, c.range, false))

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

  let spindleLoad: Option<number> = None
  if (power.isSome()) spindleLoad = Some((pc / pAvail) * 100)
  else
    warnings.push({
      code: 'feeds.powerSkipped',
      severity: 'info',
      message: 'Machine spindle power is not set, so the power check is skipped.',
      params: {},
    })
  if (exceeded || powerReduced || feedReduced)
    warnings.push(
      warn(
        'feeds.powerExceeded',
        powerReduced
          ? 'Cutting power exceeds the spindle: suggested stepdown reduced to fit.'
          : feedReduced
            ? 'Cutting power exceeds the spindle: suggested feed rate reduced to fit.'
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
  const { D, row, locked: L } = c
  const warnings: CuttingWarning[] = []
  const pos = RIGIDITY_FACTORS[c.rigidity].rangePos
  const fn = pick(c.range, pos)
  let n: number
  let nSteps: DerivationStep[]
  if (L.n !== undefined) {
    n = L.n
    nSteps = [lockedStep('n', L.n, 'rpm')]
  } else if (L.vf !== undefined) {
    const n0 = L.vf / fn
    nSteps = [
      dataStep(row, 'fn', fn, 'mm/rev', c.range),
      { step: 'F8', formula: 'n = vf / fn', inputs: { vf: L.vf, fn }, result: n0, unit: 'rpm' },
    ]
    n = clampToSpindle(n0, machine, nSteps)
  } else {
    const speed = dataSpeed(c, pos, D, undefined)
    nSteps = speed.steps
    n = clampRpm(speed.n0, machine, nSteps, warnings)
  }
  let vf: number
  let vfSteps: DerivationStep[]
  if (L.vf !== undefined) {
    vf = L.vf
    vfSteps = [lockedStep('vf', L.vf, 'mm/min')]
  } else {
    const vf0 = drillFeed(fn, n)
    vfSteps = [
      dataStep(row, 'fn', fn, 'mm/rev', c.range),
      { step: 'F8', formula: 'vf = fn · n', inputs: { fn, n }, result: vf0, unit: 'mm/min' },
    ]
    vf = vf0
    if (machine.isSome() && vf0 > machine.unwrap().maxFeedZ) {
      const m = machine.unwrap()
      vf = m.maxFeedZ
      const n0 = n
      if (L.n === undefined) {
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
      } else {
        vfSteps.push({
          step: 'feedClamp',
          formula: 'vf = maxFeedRate.z; n locked, fn drops',
          inputs: { vf: vf0, maxFeedZ: m.maxFeedZ },
          result: vf,
          unit: 'mm/min',
        })
      }
      warnings.push(
        feedClampedWarning('Drilling feed limited to the machine maximum (Z)', true, {
          vf0,
          vf,
          max: m.maxFeedZ,
          n0,
          n,
          perRev: 1,
          locked: L.n !== undefined,
        }),
      )
    }
  }
  const fnActual = vf / n
  warnings.push(...chipLoadWarnings(fnActual, c.range, true))
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

/** `feeds.rubbing` below the data range, `feeds.chipLoadHigh` above it. */
function chipLoadWarnings(actual: number, range: Range, isDrill: boolean): CuttingWarning[] {
  if (actual < range.min * (1 - EPS))
    return [
      isDrill
        ? warn('feeds.rubbing', 'Feed per revolution is below the data minimum: the drill rubs.', {
            feedPerRev: actual,
            minimum: range.min,
          })
        : warn(
            'feeds.rubbing',
            'Chips are thinner than the data minimum: the tool rubs and heats.',
            {
              chipLoad: actual,
              minimum: range.min,
            },
          ),
    ]
  if (actual > range.max * (1 + EPS))
    return [
      isDrill
        ? warn(
            'feeds.chipLoadHigh',
            'Feed per revolution is above the data maximum: the drill may break.',
            { feedPerRev: actual, maximum: range.max },
          )
        : warn(
            'feeds.chipLoadHigh',
            'Chips are thicker than the data maximum: the tool may break or chatter.',
            { chipLoad: actual, maximum: range.max },
          ),
    ]
  return []
}

/** The values that will be run (canonical units); `ap`/`ae` omitted when not milling. */
export interface CuttingValues {
  readonly n: number
  readonly vf: number
  readonly ap?: number
  readonly ae?: number
}

/** A final-value warning on the field to change. */
export interface CheckWarning extends CuttingWarning {
  readonly field: 'feedRate' | 'stepdown'
}

/**
 * Final-value check (docs/architecture/feeds-speeds.md#final-value-check): chip load against
 * the data range and cutting power, on the values that will be used, entered ones included.
 * `input.locked` is ignored. No data → no warnings (the calculator reports `feeds.noData`).
 * Spindle range and feed limits are the plan's machine checks (`plan.machine`).
 */
export function checkCutting(
  input: CuttingInput,
  values: CuttingValues,
  data: readonly MaterialRow[] = MATERIAL_DATA,
): readonly CheckWarning[] {
  const found = contextOf(input, data)
  if ('noData' in found || !(values.n > 0) || !(values.vf > 0)) return []
  const c = found.ctx
  const { tool, machine, engagement: e } = input
  const on =
    (field: CheckWarning['field']) =>
    (w: CuttingWarning): CheckWarning => ({ ...w, field })
  if (e.kind === 'drill')
    return chipLoadWarnings(values.vf / values.n, c.range, true).map(on('feedRate'))
  const D = c.D
  const ae = e.kind === 'stepover' ? Math.min(values.ae ?? e.ae, D) : D
  const ap = fixedAp(e) ?? values.ap
  const RE = tool.effectiveCornerRadius.toNumber()
  const z = tool.fluteCount.canonical
  const k = chipThinning(rctf(ae, D), ap === undefined ? 1 : actf(RE, ap))
  const out: CheckWarning[] = chipLoadWarnings(values.vf / (values.n * z * k), c.range, false).map(
    on('feedRate'),
  )
  const power = machine.andThen((m) => m.power)
  if (ap !== undefined && power.isSome()) {
    const pAvail = availablePower(power.unwrap(), values.n, machine.unwrap().maxSpeed)
    const pc = cuttingPower(materialRemovalRate(ae, ap, values.vf), c.row.u)
    if (pc > pAvail * (1 + EPS))
      out.push({
        ...warn(
          'feeds.powerExceeded',
          'Cutting power exceeds the spindle: reduce stepdown, stepover or feed.',
          { cuttingPower: pc, availablePower: pAvail },
        ),
        field: fixedAp(e) === undefined ? 'stepdown' : 'feedRate',
      })
  }
  return out
}

/**
 * The derived display values (surface speed, chip load after chip thinning, Q, Pc, spindle load)
 * at the values that will be used, entered ones included, as `checkCutting` sees them
 * (docs/architecture/feeds-speeds.md#final-value-check). None without data or without positive
 * `n` and `vf`. Q and Pc need a stepdown (milling only); spindle load the machine's power.
 */
export function cuttingAt(
  input: CuttingInput,
  values: CuttingValues,
  data: readonly MaterialRow[] = MATERIAL_DATA,
): Option<CuttingDisplay> {
  const found = contextOf(input, data)
  if ('noData' in found || !(values.n > 0) || !(values.vf > 0)) return None
  const c = found.ctx
  const { tool, machine, engagement: e } = input
  const D = c.D
  if (e.kind === 'drill')
    return Some({
      dCalc: D,
      vc: surfaceSpeed(values.n, D),
      fz: values.vf / values.n,
      chipThinning: 1,
      Q: None,
      Pc: None,
      spindleLoad: None,
    })
  const ae = e.kind === 'stepover' ? Math.min(values.ae ?? e.ae, D) : D
  const ap = fixedAp(e) ?? values.ap
  const RE = tool.effectiveCornerRadius.toNumber()
  const z = tool.fluteCount.canonical
  const k = chipThinning(rctf(ae, D), ap === undefined ? 1 : actf(RE, ap))
  const dCalc = ap === undefined ? D : effectiveDiameter(D, RE, ap)
  const Q: Option<number> = ap === undefined ? None : Some(materialRemovalRate(ae, ap, values.vf))
  const Pc: Option<number> = Q.map((q) => cuttingPower(q, c.row.u))
  const spindleLoad: Option<number> = machine.andThen((m) =>
    Pc.andThen((pc) => m.power.map((p) => (pc / availablePower(p, values.n, m.maxSpeed)) * 100)),
  )
  return Some({
    dCalc,
    vc: surfaceSpeed(values.n, dCalc),
    fz: values.vf / (values.n * z * k),
    chipThinning: k,
    Q,
    Pc,
    spindleLoad,
  })
}

const lockedStep = (field: 'n' | 'vf', value: number, unit: string): DerivationStep => ({
  step: 'locked',
  formula: `${field} locked by the user`,
  inputs: { [field]: value },
  result: value,
  unit,
})

/** Clamp to the spindle range without the calculator's rpm warnings (a locked feed's n). */
function clampToSpindle(
  n0: number,
  machine: Option<MachineLimits>,
  steps: DerivationStep[],
): number {
  if (machine.isNone()) return n0
  const { minSpeed, maxSpeed } = machine.unwrap()
  const n = Math.min(maxSpeed, Math.max(minSpeed, n0))
  if (n !== n0)
    steps.push(
      clampStep('rpmClamp', 'minSpeed ≤ n ≤ maxSpeed', { n: n0, minSpeed, maxSpeed }, n, 'rpm'),
    )
  return n
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

/**
 * `feeds.feedClamped` of a feed the machine caps (hardening DF56): says whether the spindle speed
 * came down with the feed and kept the chip load, stopped at the machine minimum or is locked,
 * and by how much the chip load drops then. `perRev`: flutes (milling) or 1 (drilling, `fn`).
 * Doc: docs/architecture/feeds-speeds.md#feed-clamp-and-chip-load-hardening-df56
 */
function feedClampedWarning(
  lead: string,
  isDrill: boolean,
  c: {
    readonly vf0: number
    readonly vf: number
    readonly max: number
    readonly n0: number
    readonly n: number
    readonly perRev: number
    readonly locked: boolean
  },
): CuttingWarning {
  const before = c.vf0 / (c.n0 * c.perRev)
  const after = c.vf / (c.n * c.perRev)
  const drop = Math.max(0, (1 - after / before) * 100)
  const what = isDrill ? 'feed per revolution' : 'chip load'
  const kept = drop < 0.5
  const ending = kept
    ? `spindle speed lowered with it, so the ${what} stays`
    : c.locked
      ? `the spindle speed is locked, so the ${what} drops by ${Math.round(drop)} %`
      : `the spindle speed stops at the machine minimum, so the ${what} drops by ${Math.round(drop)} %`
  return warn('feeds.feedClamped', `${lead}; ${ending}.`, {
    suggested: c.vf0,
    maxFeedRate: c.max,
    spindleSpeed: c.n,
    suggestedSpindleSpeed: c.n0,
    chipLoad: after,
    suggestedChipLoad: before,
    chipLoadDrop: kept ? 0 : drop,
  })
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
