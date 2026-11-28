/**
 * Z headroom estimate (hardening DF68): where the tool tip is in machine Z from the machine's
 * spindle nose to table distance, the spoilboard, the stock thickness of the setup and the
 * stickout, so a program for any sender is checked before it runs: its highest Z (the clearance
 * height: retracts, tool changes, the footer) must stay below the tip at Z home, and its lowest
 * Z must be within the Z travel. Doc: docs/architecture/grbl.md#z-headroom-hardening-df68
 *
 * Pure; values in mm. A live work zero's `softLimit` check (Run) stays authoritative.
 */
import type { Machine } from '../library/machine'
import type { PlanWarning } from './checks'

/** Distance kept below the tip's height at Z home (mm). */
export const Z_HEADROOM_MARGIN = 1

/** One tool as loaded for a setup: same name and stickout = one entry. */
export interface ZHeadroomTool {
  /** The first plan operation with this tool (the finding names it). */
  readonly planOperationId: string
  readonly toolName: string
  /** Stickout below the spindle nose (mm). */
  readonly stickout: number
  /** Lowest program Z of the tool (mm, Z0 = stock top); undefined = not known (no toolpath). */
  readonly zMin?: number
}

export interface ZHeadroomInput {
  readonly setupId: string
  /** The program's highest Z (mm above the stock top): the setup's clearance height. */
  readonly clearance: number
  /** Stock extent along the setup's spindle axis (mm); Z0 is its top face. */
  readonly stockThickness: number
  readonly tools: readonly ZHeadroomTool[]
}

const EPS = 1e-9
const mm = (v: number): string => String(Math.round(v * 10) / 10)

/** The machine fields the estimate needs and the machine copy lacks (library field names). */
export function zHeadroomMissing(machine: Machine): ('noseToTable' | 'spoilboardThickness')[] {
  return [
    ...(machine.noseToTable.isNone() ? ['noseToTable' as const] : []),
    ...(machine.spoilboardThickness.isNone() ? ['spoilboardThickness' as const] : []),
  ]
}

const FIELD_TEXT = {
  noseToTable: 'the spindle nose to table distance',
  spoilboardThickness: 'the spoilboard thickness (0 if none)',
} as const

/**
 * `plan.machine` findings of one setup: `zHeadroom` (warning, per tool) when the clearance height
 * plus the margin is above the tip at Z home, `zReach` (warning, once per setup naming the worst
 * tool, DF150; only with `zMin` and a known spoilboard) when a tool's lowest Z is below the tip at
 * the end of the Z travel. Nothing
 * without `noseToTable`; without the spoilboard the top is checked as if there were none (a
 * spoilboard only lowers the headroom, so a warning then is certain). Callers add
 * `zHeadroomUnknown` once per plan or program.
 */
export function zHeadroomFindings(machine: Machine, input: ZHeadroomInput): PlanWarning[] {
  const out: PlanWarning[] = []
  if (machine.noseToTable.isNone()) return out
  const nose = machine.noseToTable.unwrap().canonical
  const board = machine.spoilboardThickness.mapOr(0, (q) => q.canonical)
  const boardKnown = machine.spoilboardThickness.isSome()
  // GRBL homes Z up: MPos after homing is −pull-off and the travel ends at −travel
  const down = machine.travel.z.canonical - machine.pullOff.mapOr(1, (q) => q.canonical)
  const seen = new Set<string>()
  const short: ZReachShort[] = []
  for (const t of input.tools) {
    const key = `${t.toolName}\u0000${t.stickout}`
    if (seen.has(key)) continue
    seen.add(key)
    // the tool tip's height above the stock top (Z0) with Z homed
    const atHome = nose - board - input.stockThickness - t.stickout
    const needed = input.clearance + Z_HEADROOM_MARGIN
    const base = {
      setupId: input.setupId,
      tool: t.toolName,
      stickout: t.stickout,
      stockThickness: input.stockThickness,
      noseToTable: nose,
      // absent: not entered, checked as 0
      ...(boardKnown ? { spoilboardThickness: board } : {}),
    }
    if (needed > atHome + EPS)
      out.push({
        code: 'plan.machine',
        severity: 'warning',
        planOperationId: t.planOperationId,
        field: 'setup.clearanceHeight',
        rule: 'zHeadroom',
        message:
          `${t.toolName} at ${mm(t.stickout)} mm stickout: the clearance height ${mm(input.clearance)} mm ` +
          `needs ${mm(needed)} mm above the stock top, the machine has ${mm(atHome)} mm with Z homed ` +
          `(short by ${mm(needed - atHome)} mm): retracts and tool changes would hit the Z+ limit. ` +
          `Lower the clearance height, use a shorter stickout` +
          (boardKnown ? '' : ', or enter the spoilboard thickness (checked as if there were none)'),
        params: { ...base, clearanceHeight: input.clearance, needed, available: atHome },
      })
    if (t.zMin === undefined || !boardKnown) continue
    const lowest = atHome - down
    if (t.zMin < lowest - EPS) short.push({ t, base, lowest, by: lowest - t.zMin })
  }
  const reach = zReachFinding(short)
  return reach === undefined ? out : [...out, reach]
}

interface ZReachShort {
  readonly t: ZHeadroomTool
  readonly base: Readonly<Record<string, number | string>>
  readonly lowest: number
  readonly by: number
}

/** How to check the profile when the estimate and the machine disagree (DF150). */
export const Z_REACH_MEASURE =
  'If this machine does cut there, the machine profile is off: with Z homed, measure from the ' +
  'spindle nose (the collet nut face) down to the bare table under the spoilboard and enter it as ' +
  'the spindle nose to table distance; check the Z travel ($132) and the spoilboard thickness too'

/**
 * One `zReach` per setup (DF150), not per tool: the worst tool names it (`params` as before, plus
 * `toolsShort` and `shortMin`, the smallest shortfall). The math is right; a profile with a wrong
 * `noseToTable` makes every tool short by about the same, so the message says what to measure.
 */
function zReachFinding(short: readonly ZReachShort[]): PlanWarning | undefined {
  if (short.length === 0) return undefined
  const worst = short.reduce((a, b) => (b.by > a.by + EPS ? b : a))
  const shortMin = Math.min(...short.map((s) => s.by))
  const { t, lowest, by } = worst
  const head =
    short.length === 1
      ? `${t.toolName} at ${mm(t.stickout)} mm stickout`
      : `${short.length} tools cannot reach their lowest Z; ${t.toolName} at ${mm(t.stickout)} mm stickout`
  return {
    code: 'plan.machine',
    severity: 'warning',
    planOperationId: t.planOperationId,
    field: 'stickout',
    rule: 'zReach',
    message:
      `${head}: the program goes down to Z${mm(t.zMin!)} mm, the Z travel ends at Z${mm(lowest)} mm ` +
      `(short by ${mm(by)} mm${short.length === 1 ? '' : `, the others by at least ${mm(shortMin)} mm`}). ` +
      `Use a longer stickout or raise the stock on a thicker spoilboard. ${Z_REACH_MEASURE}`,
    params: { ...worst.base, zMin: t.zMin!, lowest, toolsShort: short.length, shortMin },
  }
}

/**
 * `zHeadroomUnknown` (info, `params.missing`: the missing library fields, comma-separated) when
 * the machine lacks a field of the estimate, else undefined.
 */
export function zHeadroomUnknown(machine: Machine): PlanWarning | undefined {
  const missing = zHeadroomMissing(machine)
  if (missing.length === 0) return undefined
  const partly = !missing.includes('noseToTable')
  return {
    code: 'plan.machine',
    severity: 'info',
    field: 'machine',
    rule: 'zHeadroomUnknown',
    message:
      `Z headroom ${partly ? 'only partly checked' : 'not checked'}: enter ` +
      `${missing.map((f) => FIELD_TEXT[f]).join(' and ')} in the machine`,
    params: { missing: missing.join(',') },
  }
}
