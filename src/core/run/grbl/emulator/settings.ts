/**
 * GRBL `$` settings of the virtual machine (session only, no EEPROM).
 * Doc: docs/architecture/grbl.md#virtual-machine-task-38
 */
import type { Machine } from '../../../library/machine'
import { homingMaskOf } from '../envelope'
import { fail, Ok, type AppResult } from '../../../../shared/result'
import type { Issue } from '../../../../shared/errors/app-error'

interface SettingDef {
  readonly id: number
  readonly value: number
  /** Printed without decimals in `$$` (integer or mask settings, `$30/$31`). */
  readonly integer: boolean
}

const def = (id: number, value: number, integer = false): SettingDef => ({ id, value, integer })

/** GRBL 1.1h defaults (defaults.h, generic), with DFYOM's `$10`, `$11`, `$12`, `$20`. In `$$` order. */
export const SETTING_DEFS: readonly SettingDef[] = [
  def(0, 10, true),
  def(1, 25, true),
  def(2, 0, true),
  def(3, 0, true),
  def(4, 0, true),
  def(5, 0, true),
  def(6, 0, true),
  def(10, 1, true),
  def(11, 0.01),
  def(12, 0.002),
  def(13, 0, true),
  def(20, 1, true),
  def(21, 0, true),
  def(22, 1, true),
  def(23, 0, true),
  def(24, 25),
  def(25, 500),
  def(26, 250, true),
  def(27, 1),
  def(30, 1000, true),
  def(31, 0, true),
  def(32, 0, true),
  def(100, 250),
  def(101, 250),
  def(102, 250),
  def(110, 500),
  def(111, 500),
  def(112, 500),
  def(120, 10),
  def(121, 10),
  def(122, 10),
  def(130, 200),
  def(131, 200),
  def(132, 200),
]

const BY_ID = new Map(SETTING_DEFS.map((d) => [d.id, d]))

/** Boolean settings: stored as 0/1 like GRBL (`$4–$6`, `$13`, `$20–$22`, `$32`). */
const BOOLEAN = new Set([4, 5, 6, 13, 20, 21, 22, 32])

export type SettingValues = Readonly<Record<number, number>>

/**
 * `$110–$132`, `$30/$31`, `$20`, `$23`, `$27` and, when set, `$11`, `$12`, `$100–$102` from a
 * machine snapshot (library.md#machine; homing: grbl.md#homing-and-machine-coordinates).
 */
export function machineSettings(m: Machine): SettingValues {
  const out: Record<number, number> = {
    110: m.maxFeedRate.x.canonical,
    111: m.maxFeedRate.y.canonical,
    112: m.maxFeedRate.z.canonical,
    130: m.travel.x.canonical,
    131: m.travel.y.canonical,
    132: m.travel.z.canonical,
    30: m.spindle.maxSpeed.canonical,
    31: m.spindle.minSpeed.mapOr(0, (q) => q.canonical),
    23: homingMaskOf(m.homingCorner.unwrapOr('backRight')),
    27: m.pullOff.mapOr(1, (q) => q.canonical),
  }
  // `$20=1` is the default and needs homing; only "off" is passed, so `homing: false` still works
  if (!m.softLimits.unwrapOr(true)) out[20] = 0
  if (m.acceleration.isSome()) {
    const a = m.acceleration.unwrap()
    out[120] = a.x.canonical
    out[121] = a.y.canonical
    out[122] = a.z.canonical
  }
  if (m.junctionDeviation.isSome()) out[11] = m.junctionDeviation.unwrap().canonical
  if (m.arcTolerance.isSome()) out[12] = m.arcTolerance.unwrap().canonical
  if (m.stepsPerMm.isSome()) {
    const s = m.stepsPerMm.unwrap()
    out[100] = s.x.canonical
    out[101] = s.y.canonical
    out[102] = s.z.canonical
  }
  return out
}

/** Outcome of `$x=val`: 0 = ok, else a GRBL status code. */
export type SettingStatus = 0 | 3 | 4 | 10

export class Settings {
  private readonly values = new Map<number, number>()

  private constructor() {
    for (const d of SETTING_DEFS) this.values.set(d.id, d.value)
  }

  /**
   * Defaults, then `overrides`, then the `homing` option (`$22`; `false` also clears `$20`, as
   * GRBL does). Rejects unknown ids, negative values and soft limits without homing.
   */
  static create(overrides: SettingValues, homing: boolean): AppResult<Settings> {
    const s = new Settings()
    const issues: Issue[] = []
    for (const [key, value] of Object.entries(overrides)) {
      const id = Number(key)
      if (!BY_ID.has(id)) {
        issues.push({ path: ['settings', key], rule: 'known', message: `$${key} is not a setting` })
      } else if (!Number.isFinite(value) || value < 0) {
        issues.push({ path: ['settings', key], rule: 'nonNegative', message: `$${key} < 0` })
      } else s.values.set(id, BOOLEAN.has(id) ? (value ? 1 : 0) : value)
    }
    s.values.set(22, homing ? 1 : 0)
    if (!homing) {
      if (overrides[20]) {
        issues.push({
          path: ['settings', '20'],
          rule: 'softLimitsNeedHoming',
          message: 'soft limits ($20) need homing',
        })
      }
      s.values.set(20, 0)
    }
    if (issues.length > 0) {
      return fail('model.invariant', `${issues.length} invalid setting(s)`, {
        issues,
        where: 'Settings.create',
      })
    }
    return Ok(s)
  }

  get(id: number): number {
    return this.values.get(id) ?? 0
  }

  /** `$x=val`, as GRBL settings_store_global_setting(). */
  store(id: number, value: number): SettingStatus {
    if (value < 0) return 4
    const d = BY_ID.get(id)
    if (d === undefined) return 3
    const v = d.integer ? Math.trunc(value) : value
    if (BOOLEAN.has(id)) {
      const on = v !== 0
      if (id === 20 && on && this.get(22) === 0) return 10
      this.values.set(id, on ? 1 : 0)
      if (id === 22 && !on) this.values.set(20, 0)
      return 0
    }
    this.values.set(id, v)
    return 0
  }

  /** `$$` lines. */
  report(): string[] {
    return SETTING_DEFS.map((d) => {
      const v = this.get(d.id)
      return `$${d.id}=${d.integer ? String(Math.trunc(v)) : v.toFixed(3)}`
    })
  }
}
