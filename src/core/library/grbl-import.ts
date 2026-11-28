/**
 * GRBL `$$` settings → a library machine: the diff (changes, unchanged, skipped and why, ignored
 * ids) and the machine with the accepted changes applied. Pure; never writes to GRBL. Takes the
 * parsed settings map, so the sender's connect path can call it with `ControllerInfo.settings`.
 * Doc: docs/architecture/library.md#grbl--import
 *
 * Origin: the mapping rules (travel only with soft limits, `$30` only for a gCode spindle, positive
 * values only) are ported from cnc-code `src/core/model/grblSettings.ts` `applyGrblSettings` (same
 * author, relicensed under GPL-3.0-or-later for DFYOM).
 */
import { fail, Ok, type AppResult } from '../../shared/result'
import type { Issue } from '../../shared/errors/app-error'
import type { UnitSystem } from '../project/document'
import { parseLiteral } from '../quantity/parse'
import { Quantity } from '../quantity/quantity'
import type { QuantityDTO } from '../quantity/quantity.dto'
import type { QuantityKind, UnitId } from '../quantity/units'
import { HOMING_CORNERS, type HomingCorner, type MachineValuesDTO } from './machine.dto'
import { itemUnitSystem, libraryUnit } from './values-input'

type Group = 'stepsPerMm' | 'acceleration'

interface SettingDef {
  readonly n: number
  /** Path below the machine values. */
  readonly path: readonly string[]
  readonly kind: QuantityKind
  /** Unit text of a scalar field (`mm/s²`), for the diff's display texts. */
  readonly scalarUnit?: string
  /** All three axes or none: a group the machine does not have yet is set whole. */
  readonly group?: Group
  readonly needs?: 'softLimits' | 'gcodeSpindle'
}

const AXES = ['x', 'y', 'z'] as const
const axes = (first: number, field: string, kind: QuantityKind, extra: Partial<SettingDef> = {}) =>
  AXES.map((a, i): SettingDef => ({ n: first + i, path: [field, a], kind, ...extra }))

/** Every setting DFYOM maps, in diff order (library.md#grbl--import). */
const DEFS: readonly SettingDef[] = [
  ...axes(110, 'maxFeedRate', 'feedRate'),
  ...axes(120, 'acceleration', 'scalar', { scalarUnit: 'mm/s²', group: 'acceleration' }),
  { n: 11, path: ['junctionDeviation'], kind: 'length' },
  { n: 12, path: ['arcTolerance'], kind: 'length' },
  { n: 27, path: ['pullOff'], kind: 'length' },
  ...axes(130, 'travel', 'length', { needs: 'softLimits' }),
  { n: 30, path: ['spindle', 'maxSpeed'], kind: 'spindleSpeed', needs: 'gcodeSpindle' },
  { n: 31, path: ['spindle', 'minSpeed'], kind: 'spindleSpeed', needs: 'gcodeSpindle' },
  ...axes(100, 'stepsPerMm', 'scalar', { scalarUnit: 'steps/mm', group: 'stepsPerMm' }),
]

/**
 * `$30`/`$31` map to `spindle.controllerMaxSpeed`/`controllerMinSpeed` when the machine sets them
 * (a speed controller whose PWM range differs from the usable speeds), else to `maxSpeed`/`minSpeed`.
 */
function controllerRange(machine: MachineValuesDTO, def: SettingDef): SettingDef {
  const field =
    def.n === 30 ? 'controllerMaxSpeed' : def.n === 31 ? 'controllerMinSpeed' : undefined
  if (field === undefined || machine.spindle[field] === undefined) return def
  return { ...def, path: ['spindle', field] }
}

/** Mapped outside DEFS (not quantities): `$20` soft limits, `$23` homing corner. */
const FLAGS = new Set([20, 23])

/** GRBL's own unit per kind (`$$` is always metric). */
const GRBL_UNIT: Readonly<Record<QuantityKind, UnitId>> = {
  length: 'mm',
  feedRate: 'mm/min',
  spindleSpeed: 'rpm',
  scalar: '1',
  angle: 'deg',
  power: 'W',
}

/** Half of GRBL's printed precision (3 decimals): closer values are unchanged. */
const SAME = 0.0005

export interface SettingsChange {
  /** `$110` */
  readonly setting: string
  /** Dotted path below the machine values (`maxFeedRate.x`). */
  readonly field: string
  /** The value as GRBL printed it, in GRBL's unit. */
  readonly value: number
  /** The stored value with its unit; null when the machine has none. */
  readonly from: string | null
  readonly to: string
  /** Settings that must be accepted together with this one (a new all-axes group). */
  readonly together?: readonly string[]
  /** The value to store: a quantity in the machine's unit system, `softLimits` or `homingCorner`. */
  readonly stored: QuantityDTO | boolean | HomingCorner
}

export type SkipRule = 'softLimitsOff' | 'manualSpindle' | 'notPositive' | 'allAxes' | 'zHomesDown'

export interface SettingsSkip {
  readonly setting: string
  readonly field: string
  readonly value: number
  readonly rule: SkipRule
}

export interface SettingsDiff {
  /** Settings found in the text. */
  readonly read: number
  readonly changes: readonly SettingsChange[]
  /** Mapped settings equal to the stored values. */
  readonly unchanged: readonly string[]
  readonly skipped: readonly SettingsSkip[]
  /** Settings found but not used by DFYOM (`$0`, `$999`, …), by number. */
  readonly ignored: readonly number[]
}

const name = (n: number) => `$${n}`

function at(values: object, path: readonly string[]): QuantityDTO | undefined {
  let v: unknown = values
  for (const k of path) v = typeof v === 'object' && v !== null ? (v as never)[k] : undefined
  return v as QuantityDTO | undefined
}

function setAt<T extends object>(values: T, path: readonly string[], q: unknown): T {
  const [k, ...rest] = path as [string, ...string[]]
  const inner = (values as Record<string, unknown>)[k]
  return {
    ...values,
    [k]: rest.length === 0 ? q : setAt((inner ?? {}) as object, rest, q),
  } as T
}

/** The quantity's source with its unit written out (`3000 mm/min`, `500 mm/s²`). */
export function quantityWithUnit(q: QuantityDTO, scalarUnit?: string): string {
  const source = q.source.trim()
  const parsed = parseLiteral(source, { kind: q.kind, defaultUnit: q.defaultUnit })
  if (parsed.isErr()) return source
  const { end, unit } = parsed.unwrap().nominal
  if (unit.isSome()) return source
  const text = q.defaultUnit === '1' ? scalarUnit : q.defaultUnit
  return text === undefined ? source : `${source.slice(0, end)} ${text}${source.slice(end)}`
}

/** A GRBL number as a literal: at most 6 decimals, no exponent, no trailing zeros. */
function numberText(v: number): string {
  return v.toFixed(6).replace(/\.?0+$/, '')
}

/** The stored quantity of a GRBL value: bare in an mm machine, GRBL's unit written out in inch. */
function grblQuantity(def: SettingDef, v: number, units: UnitSystem): AppResult<QuantityDTO> {
  const unit = GRBL_UNIT[def.kind]
  const defaultUnit = libraryUnit(def.kind, units)
  const source = unit === defaultUnit ? numberText(v) : `${numberText(v)} ${unit}`
  return Quantity.parse(source, { kind: def.kind, defaultUnit }).map((q) => q.toDTO())
}

/** What `settings` would change in the machine (library.md#grbl--import). */
export function machineSettingsDiff(
  machine: MachineValuesDTO,
  settings: ReadonlyMap<number, number>,
): SettingsDiff {
  const units = itemUnitSystem(machine, 'mm')
  const changes: SettingsChange[] = []
  const unchanged: string[] = []
  const skipped: SettingsSkip[] = []
  for (const mapped of DEFS) {
    const def = controllerRange(machine, mapped)
    const v = settings.get(def.n)
    if (v === undefined) continue
    const base = { setting: name(def.n), field: def.path.join('.'), value: v }
    if (def.needs === 'softLimits' && settings.get(20) !== 1) {
      skipped.push({ ...base, rule: 'softLimitsOff' })
      continue
    }
    if (def.needs === 'gcodeSpindle' && machine.spindle.control !== 'gcode') {
      skipped.push({ ...base, rule: 'manualSpindle' })
      continue
    }
    const to = v > 0 ? grblQuantity(def, v, units) : undefined
    if (to === undefined || to.isErr()) {
      skipped.push({ ...base, rule: 'notPositive' })
      continue
    }
    const from = at(machine, def.path)
    const fromQ = from === undefined ? undefined : Quantity.fromDTO(from)
    if (fromQ?.isOk() && Math.abs(fromQ.unwrap().canonical - v) <= SAME) {
      unchanged.push(base.setting)
      continue
    }
    changes.push({
      ...base,
      from: from === undefined ? null : quantityWithUnit(from, def.scalarUnit),
      to: quantityWithUnit(to.unwrap(), def.scalarUnit),
      stored: to.unwrap(),
    })
  }
  // a group the machine does not have yet: all three axes together, or none
  const out: SettingsChange[] = []
  for (const c of changes) {
    const def = DEFS.find((d) => name(d.n) === c.setting)!
    const group = def.group
    if (group === undefined || machine[group] !== undefined) {
      out.push(c)
      continue
    }
    const members = DEFS.filter((d) => d.group === group).map((d) => name(d.n))
    if (members.every((m) => changes.some((x) => x.setting === m)))
      out.push({ ...c, together: members })
    else skipped.push({ setting: c.setting, field: c.field, value: c.value, rule: 'allAxes' })
  }
  flagChanges(machine, settings, out, unchanged, skipped)
  const mapped = new Set(DEFS.map((d) => d.n))
  const ignored = [...settings.keys()]
    .filter((n) => !mapped.has(n) && !FLAGS.has(n))
    .sort((a, b) => a - b)
  return { read: settings.size, changes: out, unchanged, skipped, ignored }
}

/**
 * `$20` → `softLimits` and `$23` → `homingCorner` (bits 0–1; Z homing down is skipped). Equal to the
 * stored value, or with none stored to DFYOM's default (on, `backRight`), is unchanged.
 */
function flagChanges(
  machine: MachineValuesDTO,
  settings: ReadonlyMap<number, number>,
  changes: SettingsChange[],
  unchanged: string[],
  skipped: SettingsSkip[],
): void {
  const onOff = (v: boolean) => (v ? 'on' : 'off')
  const soft = settings.get(20)
  if (soft !== undefined) {
    const to = soft !== 0
    const from = machine.softLimits
    if ((from ?? true) === to) unchanged.push('$20')
    else
      changes.push({
        setting: '$20',
        field: 'softLimits',
        value: soft,
        from: from === undefined ? null : onOff(from),
        to: onOff(to),
        stored: to,
      })
  }
  const mask = settings.get(23)
  if (mask !== undefined) {
    const bits = Math.trunc(mask)
    const base = { setting: '$23', field: 'homingCorner', value: mask }
    // bit 0 X homes −, bit 1 Y homes − (envelope.ts homingMaskOf); bit 2: Z homes down
    if ((bits & 4) !== 0) skipped.push({ ...base, rule: 'zHomesDown' })
    else {
      const to = HOMING_CORNERS[bits & 3]!
      const from = machine.homingCorner
      if ((from ?? HOMING_CORNERS[0]) === to) unchanged.push('$23')
      else changes.push({ ...base, from: from ?? null, to, stored: to })
    }
  }
}

/**
 * The machine values with the accepted changes (setting names from `diff.changes`). The result is
 * not yet checked by the Machine model; the caller builds it.
 */
export function applySettingsChanges(
  machine: MachineValuesDTO,
  diff: SettingsDiff,
  accept: readonly string[],
): AppResult<MachineValuesDTO> {
  const issues: Issue[] = []
  accept.forEach((s, i) => {
    if (!diff.changes.some((c) => c.setting === s))
      issues.push({
        path: ['accept', i],
        rule: 'notAChange',
        message: `${s} is not a change of this import`,
      })
  })
  for (const c of diff.changes) {
    if (c.together === undefined || !accept.includes(c.setting)) continue
    if (!c.together.every((t) => accept.includes(t)) && !issues.some((x) => x.rule === 'allAxes'))
      issues.push({
        path: ['accept'],
        rule: 'allAxes',
        message: `accept ${c.together.join(', ')} together (the machine has none of them yet)`,
      })
  }
  if (issues.length > 0)
    return fail('input.malformed', 'the accepted settings do not fit the import', {
      issues,
      where: 'applySettingsChanges',
    })
  let next = machine
  for (const c of diff.changes)
    if (accept.includes(c.setting)) next = setAt(next, c.field.split('.'), c.stored)
  return Ok(next)
}

/** What a setting maps to in the machine (v0.5 RV2, the Run controller settings table). */
export interface MappedSetting {
  /** Dotted path below the machine values. */
  readonly field: string
  /** The machine's value in GRBL's unit (the `$n=` copy value); undefined when it has none. */
  readonly value: number | undefined
  /** The machine's value with its unit, as the diff shows it. */
  readonly text: string | undefined
}

/**
 * The machine field setting `$n` maps to and the machine's value of it, as the diff maps it
 * (`$30`/`$31` to the controller range when set, `$20` soft limits, `$23` the homing corner's
 * bits 0–1); undefined for a setting DFYOM does not map.
 */
export function mappedSetting(machine: MachineValuesDTO, n: number): MappedSetting | undefined {
  if (n === 20) {
    const on = machine.softLimits ?? true
    return { field: 'softLimits', value: on ? 1 : 0, text: on ? 'on' : 'off' }
  }
  if (n === 23) {
    const corner = machine.homingCorner ?? HOMING_CORNERS[0]
    return { field: 'homingCorner', value: HOMING_CORNERS.indexOf(corner), text: corner }
  }
  const mapped = DEFS.find((d) => d.n === n)
  if (mapped === undefined) return undefined
  const def = controllerRange(machine, mapped)
  const dto = at(machine, def.path)
  const q = dto === undefined ? undefined : Quantity.fromDTO(dto)
  return {
    field: def.path.join('.'),
    value: q?.isOk() ? q.unwrap().canonical : undefined,
    text: dto === undefined ? undefined : quantityWithUnit(dto, def.scalarUnit),
  }
}
