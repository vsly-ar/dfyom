/**
 * GRBL 1.1's settings by number (name and unit, from the GRBL v1.1 configuration wiki) and the
 * read-only controller settings table of the Run inspector (v0.5 RV2): every `$$` line with its
 * name, unit, the machine field it maps to and, where the machine differs, the `$n=value` line to
 * copy. DFYOM never writes `$` settings (Q219). Pure.
 * Doc: docs/conventions/ui.md#run-settings-v05-rv2
 */
import { machineSettingsDiff, mappedSetting } from '../../library/grbl-import'
import type { MachineValuesDTO } from '../../library/machine.dto'

export interface GrblSettingInfo {
  readonly name: string
  /** GRBL's unit; `mask` and `boolean` for bit fields and switches. */
  readonly unit: string
}

const axes = (first: number, what: string, unit: string): [number, GrblSettingInfo][] =>
  ['X', 'Y', 'Z'].map((a, i) => [first + i, { name: `${a} ${what}`, unit }])

/** GRBL 1.1 (`$0`–`$32`, `$100`–`$132`). */
export const GRBL_SETTINGS: ReadonlyMap<number, GrblSettingInfo> = new Map([
  [0, { name: 'Step pulse time', unit: 'µs' }],
  [1, { name: 'Step idle delay', unit: 'ms' }],
  [2, { name: 'Step pulse invert', unit: 'mask' }],
  [3, { name: 'Step direction invert', unit: 'mask' }],
  [4, { name: 'Invert step enable pin', unit: 'boolean' }],
  [5, { name: 'Invert limit pins', unit: 'boolean' }],
  [6, { name: 'Invert probe pin', unit: 'boolean' }],
  [10, { name: 'Status report options', unit: 'mask' }],
  [11, { name: 'Junction deviation', unit: 'mm' }],
  [12, { name: 'Arc tolerance', unit: 'mm' }],
  [13, { name: 'Report in inches', unit: 'boolean' }],
  [20, { name: 'Soft limits enable', unit: 'boolean' }],
  [21, { name: 'Hard limits enable', unit: 'boolean' }],
  [22, { name: 'Homing cycle enable', unit: 'boolean' }],
  [23, { name: 'Homing direction invert', unit: 'mask' }],
  [24, { name: 'Homing locate feed rate', unit: 'mm/min' }],
  [25, { name: 'Homing search seek rate', unit: 'mm/min' }],
  [26, { name: 'Homing switch debounce delay', unit: 'ms' }],
  [27, { name: 'Homing switch pull-off distance', unit: 'mm' }],
  [30, { name: 'Maximum spindle speed', unit: 'rpm' }],
  [31, { name: 'Minimum spindle speed', unit: 'rpm' }],
  [32, { name: 'Laser-mode enable', unit: 'boolean' }],
  ...axes(100, 'steps per mm', 'steps/mm'),
  ...axes(110, 'max rate', 'mm/min'),
  ...axes(120, 'acceleration', 'mm/s²'),
  ...axes(130, 'max travel', 'mm'),
])

export interface ControllerSettingRow {
  /** `$110` */
  readonly setting: string
  readonly n: number
  /** GRBL's name; undefined for a setting GRBL 1.1 does not define (a fork's own). */
  readonly name: string | undefined
  readonly unit: string | undefined
  /** The controller's value as a number text (no unit). */
  readonly controller: string
  /** The machine field it maps to (`maxFeedRate.x`), when mapped. */
  readonly field?: string
  /** The machine's value with its unit, when mapped and set. */
  readonly machine?: string
  /** The machine sets another value (a difference of the settings check). */
  readonly differs: boolean
  /** `$130=300`: the machine's value in GRBL's unit, to copy, when it differs. */
  readonly copy?: string
}

/** A GRBL number: at most 3 decimals, no trailing zeros. */
const numberText = (v: number): string =>
  Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, '')

/** `$23` keeps the controller's bits from 2 up (Z homing direction): the machine sets X and Y. */
const homingMask = (controller: number, corner: number): number =>
  Math.trunc(controller) - (Math.trunc(controller) % 4) + corner

/**
 * Every setting of `settings` (by number, ascending) with GRBL's name and unit; with a machine,
 * the mapped field, its value and the differences of the settings check (`machineSettingsDiff`:
 * travel only with soft limits on, `$30`/`$31` only for a gCode spindle).
 */
export function controllerSettingsTable(
  settings: Readonly<Record<string, number>>,
  machine?: MachineValuesDTO,
): ControllerSettingRow[] {
  const map = new Map<number, number>()
  for (const [k, v] of Object.entries(settings)) map.set(Number(k), v)
  const diff = machine === undefined ? undefined : machineSettingsDiff(machine, map)
  const differing = new Set(
    (diff?.changes ?? []).filter((c) => c.from !== null).map((c) => c.setting),
  )
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([n, value]): ControllerSettingRow => {
      const info = GRBL_SETTINGS.get(n)
      const setting = `$${n}`
      const base = { setting, n, name: info?.name, unit: info?.unit, controller: numberText(value) }
      const mapped = machine === undefined ? undefined : mappedSetting(machine, n)
      if (mapped === undefined) return { ...base, differs: false }
      const differs = differing.has(setting)
      const copyValue =
        mapped.value === undefined
          ? undefined
          : n === 23
            ? homingMask(value, mapped.value)
            : mapped.value
      return {
        ...base,
        field: mapped.field,
        ...(mapped.text === undefined ? {} : { machine: mapped.text }),
        differs,
        ...(differs && copyValue !== undefined
          ? { copy: `${setting}=${numberText(copyValue)}` }
          : {}),
      }
    })
}
