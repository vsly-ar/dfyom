/**
 * Feeds-and-speeds formulas F1–F9 as pure functions.
 * Doc: docs/architecture/feeds-speeds.md#formulas (sources [S1], [S2], [MH], [MD], [K1], [HT1], [AD]).
 *
 * Float64 on purpose: the formulas need π, square roots and trigonometry, which the exact
 * rational quantity layer cannot represent, and the results are suggestions, not entered values.
 * Units are canonical: mm, m/min (vc), rpm, mm/min, mm³/min, W·s/mm³ (u), kW (Pc), W (machine).
 */

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

/** F7 `Pc = Q · u / 60 000` (kW; u in W·s/mm³). */
export const cuttingPower = (Q: number, u: number): number => (Q * u) / 60_000

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
