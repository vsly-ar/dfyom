/**
 * Impossible locks: when a locked input breaks a hard limit or leaves the locked set no way to
 * meet one. Pure. Doc: docs/architecture/feeds-speeds.md#impossible-locks
 *
 * Values in canonical units (rpm, mm/min, mm, kW). Reasons are English with those units, like
 * the other plan messages.
 */
import { None, Some, type Option } from '../../shared/result'
import type { Tool } from '../library/tool'
import type { MaterialRow } from './data'
import { MATERIAL_DATA } from './data'
import {
  checkCutting,
  fixedAp,
  type CuttingInput,
  type LockedInputs,
  type MachineLimits,
} from './suggest'

export const LOCK_RULES = [
  'invalid',
  'spindleRange',
  'feedLimit',
  'toolLength',
  'stepoverAboveTool',
  'power',
] as const
export type LockRule = (typeof LOCK_RULES)[number]

export interface LockIssue {
  readonly rule: LockRule
  /** As shown next to the disabled lock. */
  readonly reason: string
  readonly params: Readonly<Record<string, number | string>>
}

/** What a single lock is checked against. */
export interface LockLimits {
  readonly tool: Tool
  readonly machine: Option<MachineLimits>
  /** Resolved stickout of the plan operation (mm), if known. */
  readonly stickout?: number
  /** Drilling with a drill: the feed limit is `maxFeedRate.z`. */
  readonly drill: boolean
}

const EPS = 1e-9

/** Whole numbers for rpm and mm/min, up to 3 decimals for mm and kW. */
const num = (v: number, decimals = 0): string =>
  v
    .toFixed(decimals)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '')

const issue = (
  rule: LockRule,
  reason: string,
  params: Record<string, number | string> = {},
): Option<LockIssue> => Some({ rule, reason, params })

/** Rules of one lock on its own (`invalid`, `spindleRange`, `feedLimit`, `toolLength`, `stepoverAboveTool`). */
export function lockIssue(
  input: keyof LockedInputs,
  value: number | undefined,
  l: LockLimits,
): Option<LockIssue> {
  if (value === undefined || !Number.isFinite(value) || value <= 0)
    return issue('invalid', 'Enter a valid value to lock it.')
  const m = l.machine
  switch (input) {
    case 'n': {
      if (m.isNone()) return None
      const { minSpeed, maxSpeed } = m.unwrap()
      if (value > maxSpeed + EPS)
        return issue(
          'spindleRange',
          `${num(value)} rpm is above this machine's ${num(maxSpeed)} rpm.`,
          { spindleSpeed: value, max: maxSpeed },
        )
      if (value < minSpeed - EPS)
        return issue(
          'spindleRange',
          `${num(value)} rpm is below this machine's minimum of ${num(minSpeed)} rpm.`,
          { spindleSpeed: value, min: minSpeed },
        )
      return None
    }
    case 'vf': {
      if (m.isNone()) return None
      const max = l.drill ? m.unwrap().maxFeedZ : m.unwrap().maxFeedXY
      if (value > max + EPS)
        return issue(
          'feedLimit',
          `${num(value)} mm/min is above this machine's ${num(max)} mm/min (${l.drill ? 'Z' : 'X/Y'}).`,
          { feedRate: value, max },
        )
      return None
    }
    case 'ap': {
      const flute = l.tool.fluteLength.canonical
      if (value > flute + EPS)
        return issue(
          'toolLength',
          `Stepdown ${num(value, 3)} mm is deeper than the flute length (${num(flute, 3)} mm).`,
          { stepdown: value, max: flute },
        )
      if (l.stickout !== undefined && value > l.stickout + EPS)
        return issue(
          'toolLength',
          `Stepdown ${num(value, 3)} mm is deeper than the stickout (${num(l.stickout, 3)} mm).`,
          { stepdown: value, max: l.stickout },
        )
      return None
    }
    case 'ae': {
      const D = l.tool.diameter.canonical
      if (value > D + EPS)
        return issue('stepoverAboveTool', 'A stepover above the tool diameter leaves ridges.', {
          stepover: value,
          max: D,
        })
      return None
    }
  }
}

/**
 * The `power` rule: every input of F7 is locked (`n`, `vf`, a fixed `ap` – locked, or the helix
 * pitch – and for facing `ae`) and the cut needs more than the spindle gives, so no unlocked
 * field can absorb it. Skipped without spindle power or data.
 */
export function powerLockIssue(
  input: CuttingInput,
  data: readonly MaterialRow[] = MATERIAL_DATA,
): Option<LockIssue> {
  const { engagement: e } = input
  const L = input.locked ?? {}
  if (e.kind === 'drill' || L.n === undefined || L.vf === undefined) return None
  const ap = fixedAp(e) ?? L.ap
  if (ap === undefined || (e.kind === 'stepover' && L.ae === undefined)) return None
  const values = { n: L.n, vf: L.vf, ap, ...(L.ae === undefined ? {} : { ae: L.ae }) }
  const over = checkCutting(input, values, data).find((w) => w.code === 'feeds.powerExceeded')
  if (over === undefined) return None
  const names =
    e.kind === 'stepover'
      ? 'spindle speed, feed, stepdown and stepover'
      : e.kind === 'slot'
        ? 'spindle speed, feed and stepdown'
        : 'spindle speed and feed'
  const pc = Number(over.params['cuttingPower'])
  const avail = Number(over.params['availablePower'])
  return issue(
    'power',
    `With ${names} locked the cut needs ${num(pc, 2)} kW of ${num(avail, 2)} kW.`,
    { cuttingPower: pc, availablePower: avail },
  )
}
