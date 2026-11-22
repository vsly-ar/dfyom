// Pure helpers of the "New tool" and "New machine" forms (plan mode's pickers): defaults per
// project unit system, the `library.tool.add` / `library.machine.add` values built from the
// form (quantities as entered; the command gets the project's `units` for bare numbers), and a
// command error's issues per form field. The core validates (Tool / Machine models);
// the form only shapes what was entered. Doc: docs/conventions/ui.md#plan-mode-task-37,
// docs/architecture/library.md#tool, #machine
import type { Rigidity } from '../../../../core/library/machine.dto'
import type { ToolMaterial, ToolType } from '../../../../core/library/tool.dto'
import type { OperationKind } from '../../../../core/design/part.dto'
import type { UnitSystem } from '../../../../core/project/document'
import { Quantity } from '../../../../core/quantity/quantity'
import type { QuantityKind } from '../../../../core/quantity/units'
import { libraryUnit } from '../../../../core/library/values-input'
import type { Issue } from '../../../../shared/errors/app-error'
import { libraryMessages } from '../../messages/library'

export { libraryUnit }

/** A quantity from a default source (a programming error if it does not parse). */
export function q(kind: QuantityKind, source: string, units: UnitSystem): Quantity {
  return Quantity.parse(source, { kind, defaultUnit: libraryUnit(kind, units) })
    .ok()
    .unwrap()
}

// ── tool ──────────────────────────────────────────────────────────────────────────────────

export interface ToolForm {
  /** `null` = the suggested name (`toolName`), until the user types one. */
  readonly name: string | null
  readonly type: ToolType
  readonly diameter: Quantity
  readonly cornerRadius: Quantity
  readonly fluteLength: Quantity
  readonly overallLength: Quantity
  readonly fluteCount: Quantity
  readonly pointAngle: Quantity
  readonly toolMaterial: ToolMaterial
}

/** Typical small router tool (library.md#tool): carbide, 2 flutes; a drill for a drilling. */
export function defaultToolForm(units: UnitSystem, kind?: OperationKind): ToolForm {
  const drill = kind === 'drilling'
  const s =
    units === 'mm' ? ['6', '1', '20', '50', '30', '66'] : ['1/4', '1/32', '3/4', '2', '1', '2 1/2']
  const [d, re, lcf, oal, drillLcf, drillOal] = s as [
    string,
    string,
    string,
    string,
    string,
    string,
  ]
  return {
    name: null,
    type: drill ? 'drill' : 'flatEndMill',
    diameter: q('length', d, units),
    cornerRadius: q('length', re, units),
    fluteLength: q('length', drill ? drillLcf : lcf, units),
    overallLength: q('length', drill ? drillOal : oal, units),
    fluteCount: q('scalar', '2', units),
    pointAngle: q('angle', '118', units),
    toolMaterial: 'carbide',
  }
}

/** The suggested name: short type and diameter as entered ("Flat 6", "Drill 1/4"). */
export function toolName(f: ToolForm): string {
  return `${libraryMessages.tool.shortTypes[f.type]} ${f.diameter.source.trim()}`
}

/** `library.tool.add` values; the corner radius only for a bull nose, the point angle only for a drill. */
export function toolValues(f: ToolForm): Record<string, unknown> {
  return {
    name: f.name === null || f.name.trim() === '' ? toolName(f) : f.name.trim(),
    type: f.type,
    diameter: f.diameter.source,
    ...(f.type === 'bullNoseEndMill' ? { cornerRadius: f.cornerRadius.source } : {}),
    fluteLength: f.fluteLength.source,
    overallLength: f.overallLength.source,
    fluteCount: f.fluteCount.source,
    ...(f.type === 'drill' ? { pointAngle: f.pointAngle.source } : {}),
    toolMaterial: f.toolMaterial,
    presets: [],
  }
}

// ── machine ───────────────────────────────────────────────────────────────────────────────

export type Axis = 'x' | 'y' | 'z'
export const AXES: readonly Axis[] = ['x', 'y', 'z']

export interface MachineForm {
  readonly name: string
  readonly travel: Readonly<Record<Axis, Quantity>>
  readonly maxFeedRate: Readonly<Record<Axis, Quantity>>
  readonly control: 'manual' | 'gcode'
  readonly maxSpeed: Quantity
  readonly minSpeed: Quantity | undefined
  readonly power: Quantity | undefined
  readonly rigidity: Rigidity
  readonly programUnits: 'mm' | 'in'
}

/** A hobby router with a trim router (dial spindle), lowest rigidity (the core's default); gCode units follow the project. */
export function defaultMachineForm(units: UnitSystem): MachineForm {
  const [t, tz, f, fz] = units === 'mm' ? ['400', '100', '3000', '1000'] : ['16', '4', '120', '40']
  return {
    name: libraryMessages.machine.defaultName,
    travel: { x: q('length', t, units), y: q('length', t, units), z: q('length', tz, units) },
    maxFeedRate: {
      x: q('feedRate', f, units),
      y: q('feedRate', f, units),
      z: q('feedRate', fz, units),
    },
    control: 'manual',
    maxSpeed: q('spindleSpeed', '30000', units),
    minSpeed: undefined,
    power: undefined,
    rigidity: 'extrusion',
    programUnits: units === 'mm' ? 'mm' : 'in',
  }
}

const axesInput = (a: Readonly<Record<Axis, Quantity>>) => ({
  x: a.x.source,
  y: a.y.source,
  z: a.z.source,
})

/** `library.machine.add` values (controller GRBL, manual tool change: the only v0.1 choices). */
export function machineValues(f: MachineForm): Record<string, unknown> {
  return {
    name: f.name.trim(),
    controller: 'grbl',
    travel: axesInput(f.travel),
    maxFeedRate: axesInput(f.maxFeedRate),
    spindle: {
      control: f.control,
      maxSpeed: f.maxSpeed.source,
      ...(f.minSpeed === undefined ? {} : { minSpeed: f.minSpeed.source }),
      ...(f.power === undefined ? {} : { power: f.power.source }),
    },
    rigidity: f.rigidity,
    programUnits: f.programUnits,
    toolChanger: 'none',
  }
}

// ── issues ────────────────────────────────────────────────────────────────────────────────

/** The field key of an issue of `library.<kind>.add` (path below `values`, dotted). */
const keyOf = (i: Issue): string => {
  const path = i.path[0] === 'values' ? i.path.slice(1) : i.path
  return path.join('.')
}

/** Issues at a form field (`spindle.maxSpeed`), including those below it. */
export function issuesAt(issues: readonly Issue[], field: string): Issue[] {
  return issues.filter((i) => {
    const k = keyOf(i)
    return k === field || k.startsWith(`${field}.`)
  })
}

/** Issues no form field shows (for the summary at the top of the form). */
export function unmatchedIssues(issues: readonly Issue[], fields: readonly string[]): Issue[] {
  return issues.filter((i) => !fields.some((f) => issuesAt([i], f).length > 0))
}
