/**
 * Feeds-and-speeds formulas F1–F11 as pure functions (F11, the tapered ball's groove width, is
 * `taperedGrooveWidth` in library/tool.ts, shared with the Line's read-out).
 * Doc: docs/architecture/feeds-speeds.md#formulas (sources [S1], [S2], [MH], [MD], [K1], [HT1], [AD]).
 *
 * Float64 on purpose: the formulas need π, square roots and trigonometry, which the exact
 * rational quantity layer cannot represent, and the results are suggestions, not entered values.
 * Units are canonical: mm, m/min (vc), rpm, mm/min, mm³/min, W·s/mm³ (u), kW (Pc), W (machine).
 */
import { taperHeights } from '../library/tool'

/** F3 × F5 never exceeds this factor ([MD]: avoid runaway feeds at tiny engagement). */
export const CHIP_THINNING_CAP = 3

/** Spindle efficiency for the available-power check (router nameplate power is input power). */
export const SPINDLE_EFFICIENCY = 0.8

/** 1 hp/(in³/min) in W·s/mm³, rounded as in the doc (745.7 W · 60 s / 16 387 mm³ = 2.7303). */
export const KP_TO_UNIT_POWER = 2.73

/** F1 `n = vc·1000 / (π·Dcalc)` (rpm; vc in m/min, Dcalc in mm). */
export const spindleSpeed = (vc: number, dCalc: number): number => (vc * 1000) / (Math.PI * dCalc)

/** Inverse of F1: actual surface speed (m/min) at `n`. */
export const surfaceSpeed = (n: number, dCalc: number): number => (Math.PI * dCalc * n) / 1000

/** F2 `vf = n · z · fz_prog` (mm/min). */
export const feedRate = (n: number, z: number, fzProg: number): number => n * z * fzProg

/** F3 radial chip-thinning factor: `1 / (2·√((ae/D)(1 − ae/D)))` below `ae = D/2`, else 1. */
export function rctf(ae: number, D: number): number {
  if (ae >= D / 2) return 1
  const r = ae / D
  return 1 / (2 * Math.sqrt(r * (1 - r)))
}

/** F4 effective (cutting) diameter at depth `ap` for corner radius `RE` (0 = flat end mill). */
export function effectiveDiameter(D: number, RE: number, ap: number): number {
  if (RE <= 0 || ap >= RE) return D
  return D - 2 * RE + 2 * Math.sqrt(ap * (2 * RE - ap))
}

/**
 * F10 effective diameter of a chamfer mill / V-bit at depth `depth` below its tip:
 * `De = dt + 2·depth·tan(α/2)`, at most DC (the cone ends there). `angle` is the included angle α
 * in degrees. Doc: docs/architecture/feeds-speeds.md#chamfer-mills-v04.
 */
export function chamferEffectiveDiameter(
  tip: number,
  depth: number,
  angle: number,
  D: number,
): number {
  const de = tip + 2 * Math.max(0, depth) * Math.tan(((angle / 2) * Math.PI) / 180)
  return Math.min(D, de)
}

/** The depth below the tip at which a chamfer mill cuts its full diameter DC. */
export const chamferFullDepth = (tip: number, angle: number, D: number): number =>
  (D - tip) / 2 / Math.tan(((angle / 2) * Math.PI) / 180)

/**
 * The tapered ball end mill's suggested stepdown: the largest `ap` with ap ≤ k · De(ap), De the
 * groove width at ap (`taperedGrooveWidth`) and k = apSlot × apFactor; closed form per piece of
 * De (the large end Ø, the cone, the ball). `angle` is per side, degrees.
 * Doc: docs/architecture/feeds-speeds.md#tapered-ball-end-mills-hardening-df124.
 */
export function taperedStepdown(tip: number, angle: number, D: number, k: number): number {
  if (!(k > 0) || !(tip > 0)) return 0
  const { tangent, largeEnd } = taperHeights(tip, angle, D)
  // beyond the cone: De = DC
  if (k * D >= largeEnd) return k * D
  // on the cone: De = A + B·ap
  const r = tip / 2
  const theta = (angle * Math.PI) / 180
  const A = (2 * r) / Math.cos(theta) - 2 * r * Math.tan(theta)
  const B = 2 * Math.tan(theta)
  if (k * B < 1) {
    const ap = (k * A) / (1 - k * B)
    if (ap > tangent) return Math.min(ap, largeEnd)
  }
  // on the ball: ap = k · 2√(ap (2r − ap))
  return Math.min(tangent, (8 * k * k * r) / (1 + 4 * k * k))
}

/** F5 axial chip-thinning factor `1 / sin κ`, `cos κ = (RE − ap)/RE`; 1 for flat or `ap ≥ RE`. */
export function actf(RE: number, ap: number): number {
  if (RE <= 0 || ap >= RE) return 1
  const cos = (RE - ap) / RE
  return 1 / Math.sqrt(1 - cos * cos)
}

/** F3 × F5, capped at ×3. */
export const chipThinning = (radial: number, axial: number): number =>
  Math.min(CHIP_THINNING_CAP, radial * axial)

/** F6 `Q = ae · ap · vf` (mm³/min). */
export const materialRemovalRate = (ae: number, ap: number, vf: number): number => ae * ap * vf

/**
 * F12 material removal rate of a plunged chamfer (hardening DF141): the cone fed along its axis
 * into an edge (hole) of Ø `d` removes the annulus between `d` and the cone's Ø `De` at the face per
 * mm of feed, `Q = π/4 · (De² − d²) · vp` (mm³/min; d = 0 into solid material). The same geometry
 * as Sandvik's drilling MRR for enlarging a pre-drilled hole. Its chip is `h = vp / (n · z) ·
 * sin(α/2)` (`plungedChip`). Doc: docs/architecture/feeds-speeds.md#plunged-chamfers-hardening-df141
 */
export const plungedRemovalRate = (De: number, d: number, vp: number): number =>
  (Math.PI / 4) * Math.max(0, De * De - d * d) * vp

/**
 * F12 chip thickness of a cone of included angle `angle` (degrees) fed `vp` along its axis:
 * `h = vp / (n · z) · sin(α/2)` (Sandvik `hex = fz · sin κr`, the edge at α/2 to the feed).
 */
export const plungedChip = (vp: number, n: number, z: number, angle: number): number =>
  (vp / (n * z)) * Math.sin(((angle / 2) * Math.PI) / 180)

/** F7 `Pc = Q · u / 60 000` (kW; u in W·s/mm³). */
export const cuttingPower = (Q: number, u: number): number => (Q * u) / 60_000

/**
 * Machinery's Handbook feed factor `C` for the power constant (DF131): thin chips take more energy
 * per mm³. Fitted to the handbook's milling table (1.60 at .001″ per tooth, 1.40 at .002″, ≈ 1.0
 * at .012″): `C = (0.3048 / fz)^0.19`, at least 1, at most `FEED_FACTOR_CAP`; `fz` in mm (the
 * chip after thinning). Doc: docs/architecture/feeds-speeds.md#hobby-metal-cutting-hardening-df131
 */
export function feedFactor(fz: number): number {
  if (!(fz > 0)) return FEED_FACTOR_CAP
  return Math.min(FEED_FACTOR_CAP, Math.max(1, (0.3048 / fz) ** 0.19))
}

/** Upper bound of the feed factor `C` (chips under ≈ .0005″ rub anyway: `feeds.rubbing`). */
export const FEED_FACTOR_CAP = 2

/** Machinery's Handbook tool-wear factor `W` for end milling (1.1 sharp – 1.3 worn; DF131). */
export const TOOL_WEAR_FACTOR = 1.25

/**
 * Share of the available power a machining-chart (metal) suggestion may use (DF131): the power
 * fit and the final-value check keep `Pc ≤ 0.8 · Pavail`.
 */
export const MACHINING_LOAD_LIMIT = 0.8

/** F7 `u = Kp · 2.73` from Machinery's Handbook unit horsepower `Kp`. */
export const unitPowerFromKp = (kp: number): number => kp * KP_TO_UNIT_POWER

/**
 * Available cutting power (kW): `spindle.power × η × min(1, n / maxSpeed)` – VFD spindles are
 * constant-torque below rated speed (docs/architecture/feeds-speeds.md#hobby-machine-realism).
 */
export const availablePower = (powerW: number, n: number, maxSpeed: number): number =>
  (powerW / 1000) * SPINDLE_EFFICIENCY * Math.min(1, n / maxSpeed)

/** F8 `vf = fn · n` (mm/min). */
export const drillFeed = (fn: number, n: number): number => fn * n

/** F9 `plungeRate = kPlunge · vf` (end mills; heuristic, to be confirmed). */
export const plungeRate = (kPlunge: number, vf: number): number => kPlunge * vf
