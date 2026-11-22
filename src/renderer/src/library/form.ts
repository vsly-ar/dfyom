// Pure helpers of the library forms (the Library window's item editor and the quick "New tool…" /
// "New machine…" dialogs, which share the form components, L4): defaults per unit system, the
// draft values (the kind's stored values DTO, with the per-type tool fields kept while the type
// changes and a partial acceleration allowed), their validation by the core models as typed (L3),
// the command input built from them (quantities as entered; L5 keeps stored sources), and a
// command error's issues per field. The core validates; the forms only shape what was entered.
// Doc: docs/conventions/ui-library-window.md, docs/architecture/library.md,
// docs/conventions/ui.md#plan-mode-task-37
import type { OperationKind } from '../../../core/design/part.dto'
import type { LibraryItemKind } from '../../../core/library/item'
import {
  valuesFromDTO,
  type ItemValuesDTO,
  type LibraryItemDTO,
} from '../../../core/library/library-item'
import type { MachineValuesDTO } from '../../../core/library/machine.dto'
import type { StockValuesDTO } from '../../../core/library/stock.dto'
import type { ToolType, ToolValuesDTO } from '../../../core/library/tool.dto'
import {
  itemUnitSystem,
  libraryUnit,
  sourceFor,
  valuesInputFromDTO,
} from '../../../core/library/values-input'
import type { UnitSystem } from '../../../core/project/document'
import { parseLiteral } from '../../../core/quantity/parse'
import { Quantity } from '../../../core/quantity/quantity'
import type { QuantityDTO } from '../../../core/quantity/quantity.dto'
import type { QuantityKind } from '../../../core/quantity/units'
import type { Issue } from '../../../shared/errors/app-error'
import { libraryMessages } from '../messages/library'

export { libraryUnit }

/** A quantity from a default source (a programming error if it does not parse). */
export function q(kind: QuantityKind, source: string, units: UnitSystem): Quantity {
  return Quantity.parse(source, { kind, defaultUnit: libraryUnit(kind, units) })
    .ok()
    .unwrap()
}

/** A quantity DTO of a known kind (as the library DTO schemas type each field). */
export type QDto<K extends QuantityKind> = QuantityDTO & { readonly kind: K }

/** The DTO of a default source. */
export const qdto = <K extends QuantityKind>(kind: K, source: string, units: UnitSystem): QDto<K> =>
  q(kind, source, units).toDTO() as QDto<K>

/** The quantity of a stored DTO, or undefined when it does not load. */
export function quantityOf(dto: QuantityDTO): Quantity | undefined {
  const r = Quantity.fromDTO(dto)
  return r.isOk() ? r.unwrap() : undefined
}

export type Axis = 'x' | 'y' | 'z'
export const AXES: readonly Axis[] = ['x', 'y', 'z']

// ── draft values ──────────────────────────────────────────────────────────────────────────

/** A tool's values; `cornerRadius` / `pointAngle` stay while the type is another (dropped on save). */
export type ToolDraft = ToolValuesDTO
/** A machine's values; `acceleration` may have some axes only while typing (all or none on save). */
export type MachineDraft = Omit<MachineValuesDTO, 'acceleration'> & {
  readonly acceleration?: Partial<Record<Axis, QuantityDTO>> | undefined
}
export type StockDraft = StockValuesDTO
export type DraftValues = ToolDraft | MachineDraft | StockDraft

/** The values of a stored item (its meta dropped). */
export function itemValues(item: LibraryItemDTO): ItemValuesDTO {
  const { id: _id, revision: _revision, updatedAt: _updatedAt, ...values } = item
  return values as ItemValuesDTO
}

/** The generalized tool a new tool starts from (the Design tool field's "New tool…", L4). */
export interface ToolPrefill {
  readonly type: ToolType
  readonly diameter: QDto<'length'>
  readonly cornerRadius?: QDto<'length'> | undefined
}

/**
 * Typical small router tool (library.md#tool): carbide, 2 flutes; a drill for a drilling. The name
 * is empty: the form suggests one (`toolName`) until the user types one.
 */
export function defaultToolValues(
  units: UnitSystem,
  kind?: OperationKind,
  prefill?: ToolPrefill,
): ToolDraft {
  const drill = (prefill?.type ?? (kind === 'drilling' ? 'drill' : 'flatEndMill')) === 'drill'
  const mm = units === 'mm'
  const [d, re, lcf, oal] = mm
    ? ['6', '1', drill ? '30' : '20', drill ? '66' : '50']
    : ['1/4', '1/32', drill ? '1' : '3/4', drill ? '2 1/2' : '2']
  return {
    kind: 'tool',
    name: '',
    type: prefill?.type ?? (drill ? 'drill' : 'flatEndMill'),
    diameter: prefill?.diameter ?? qdto('length', d, units),
    cornerRadius: prefill?.cornerRadius ?? qdto('length', re, units),
    fluteLength: qdto('length', lcf, units),
    overallLength: qdto('length', oal, units),
    fluteCount: qdto('scalar', '2', units),
    pointAngle: qdto('angle', '118', units),
    toolMaterial: 'carbide',
    presets: [],
  }
}

/** A hobby router with a trim router (dial spindle), lowest rigidity; gCode units follow `units`. */
export function defaultMachineValues(units: UnitSystem): MachineDraft {
  const [t, tz, f, fz] = units === 'mm' ? ['400', '100', '3000', '1000'] : ['16', '4', '120', '40']
  return {
    kind: 'machine',
    name: libraryMessages.machine.defaultName,
    controller: 'grbl',
    travel: {
      x: qdto('length', t, units),
      y: qdto('length', t, units),
      z: qdto('length', tz, units),
    },
    maxFeedRate: {
      x: qdto('feedRate', f, units),
      y: qdto('feedRate', f, units),
      z: qdto('feedRate', fz, units),
    },
    spindle: { control: 'manual', maxSpeed: qdto('spindleSpeed', '30000', units) },
    rigidity: 'extrusion',
    programUnits: units === 'mm' ? 'mm' : 'in',
    toolChanger: 'none',
  }
}

/** The stock setup's new block: 100 × 60 × 20 mm (4 × 2½ × ¾″) of 6061-T6. */
export function defaultStockValues(units: UnitSystem): StockDraft {
  const [l, w, t] = units === 'mm' ? ['100', '60', '20'] : ['4', '2 1/2', '3/4']
  return {
    kind: 'stock',
    name: libraryMessages.stock.defaultName(l, w, t),
    shape: 'block',
    length: qdto('length', l, units),
    width: qdto('length', w, units),
    thickness: qdto('length', t, units),
    material: { name: '6061-T6', class: 'aluminum' },
  }
}

export function defaultValues(kind: LibraryItemKind, units: UnitSystem): DraftValues {
  return kind === 'tool'
    ? defaultToolValues(units)
    : kind === 'machine'
      ? defaultMachineValues(units)
      : defaultStockValues(units)
}

/** The suggested name: short type and diameter as entered ("Flat 6", "Drill 1/4"). */
export function toolName(v: Pick<ToolDraft, 'type' | 'diameter'>): string {
  return `${libraryMessages.tool.shortTypes[v.type]} ${v.diameter.source.trim()}`
}

/** The tool with another type; a bull nose or drill gets a corner radius / point angle if none. */
export function withToolType(v: ToolDraft, type: ToolType, units: UnitSystem): ToolDraft {
  return {
    ...v,
    type,
    cornerRadius: v.cornerRadius ?? qdto('length', units === 'mm' ? '1' : '1/32', units),
    pointAngle: v.pointAngle ?? qdto('angle', '118', units),
  }
}

/** "Flat 6 copy" (Duplicate), within the name limit. */
export function copyName(name: string): string {
  return `${name} ${libraryMessages.copySuffix}`.slice(0, 120)
}

/**
 * The values the library stores: the suggested name when it is empty (`autoName`), a tool's
 * per-type fields only for their type, empty notes dropped, a machine's acceleration all or none
 * (some axes only: an issue at `acceleration`).
 */
export function cleanValues(
  values: DraftValues,
  autoName = false,
): { values: ItemValuesDTO; issues: Issue[] } {
  const issues: Issue[] = []
  const notes = values.notes?.trim() === '' ? undefined : values.notes
  if (values.kind === 'tool') {
    const { cornerRadius, pointAngle, coating, ...rest } = values
    const name = autoName && values.name.trim() === '' ? toolName(values) : values.name.trim()
    return {
      values: {
        ...rest,
        name,
        notes,
        ...(values.type === 'bullNoseEndMill' ? { cornerRadius } : {}),
        ...(values.type === 'drill' ? { pointAngle } : {}),
        ...(coating?.trim() ? { coating: coating.trim() } : {}),
      } as ToolValuesDTO,
      issues,
    }
  }
  if (values.kind === 'machine') {
    const { acceleration, ...rest } = values
    const set = AXES.filter((a) => acceleration?.[a] !== undefined)
    if (set.length > 0 && set.length < 3)
      issues.push({
        path: ['acceleration'],
        rule: 'allAxes',
        message: libraryMessages.machine.accelerationAll,
      })
    return {
      values: {
        ...rest,
        name: values.name.trim(),
        notes,
        ...(set.length === 3 ? { acceleration } : {}),
      } as MachineValuesDTO,
      issues,
    }
  }
  return { values: { ...values, name: values.name.trim(), notes }, issues }
}

/** Every issue of the values as the core model sees them (paths below the values, no prefix). */
export function draftIssues(values: DraftValues, autoName = false): Issue[] {
  const clean = cleanValues(values, autoName)
  const model = valuesFromDTO(clean.values)
  return [...clean.issues, ...(model.isErr() ? model.unwrapErr().issues : [])]
}

/**
 * `library.<kind>.add` / `.update` args `values` and `units`: a stored item keeps its own unit
 * system (unchanged sources stay byte for byte, L5), a new one uses the window's.
 */
export function commandInput(
  values: DraftValues,
  opts: {
    readonly units: UnitSystem
    readonly base?: object | undefined
    readonly autoName?: boolean
  },
): { values: Record<string, unknown>; units: UnitSystem } {
  const units = opts.base === undefined ? opts.units : itemUnitSystem(opts.base, opts.units)
  const clean = cleanValues(values, opts.autoName ?? false).values
  return { values: valuesInputFromDTO(clean, units), units }
}

/**
 * The quantity as a field in `units` shows it: a bare source entered in the other unit system gets
 * its unit written out (`1/4` in inches → `1/4 in`, then "· 6.35 mm"), so it never reads as a
 * number in the window's unit (L5).
 */
export function displayQuantity(
  dto: QuantityDTO | undefined,
  units: UnitSystem,
): Quantity | undefined {
  if (dto === undefined) return undefined
  const unit = libraryUnit(dto.kind, units)
  if (dto.defaultUnit === unit) return quantityOf(dto)
  const r = Quantity.parse(sourceFor(dto, units), { kind: dto.kind, defaultUnit: unit })
  return r.isOk() ? r.unwrap() : undefined
}

const UNIT_TEXT: Readonly<Record<string, string>> = { in: '"', '1': '' }

/** A table cell's text: the source with its bare-number unit ("6 mm", `1/4"`, "18000 rpm"). */
export function quantityText(dto: QuantityDTO | undefined): string {
  if (dto === undefined) return '–'
  const source = dto.source.trim()
  const parsed = parseLiteral(source, { kind: dto.kind, defaultUnit: dto.defaultUnit })
  // the source writes its unit (or does not parse): as entered
  if (parsed.isErr() || parsed.unwrap().nominal.unit.isSome()) return source
  return `${source}${UNIT_TEXT[dto.defaultUnit] ?? ` ${dto.defaultUnit}`}`
}

// ── issues ────────────────────────────────────────────────────────────────────────────────

/** The field key of an issue (path below `values`, dotted; a command's or the model's). */
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
