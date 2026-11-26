// Pure helpers of the Library window's Workholding tab (WL3): the L1 type icon per device type, a
// listing row's flags (built-in, effective default), and the list's size and details cells in the
// window's unit system ("30 × 60, top 25 mm"). Doc: docs/modes/workholding-library.md#library-window-tab
import type { LibraryItemDTO } from '../../../core/library/library-item'
import type { WorkholdingType } from '../../../core/library/workholding.dto'
import type { UnitSystem } from '../../../core/project/document'
import type { QuantityDTO } from '../../../core/quantity/quantity.dto'
import { libraryMessages } from '../messages/library'
import type { IconName } from '../ui'
import { quantityOf, type WorkholdingDraft } from './form'

const m = libraryMessages.workholding

/** The L1 workholding icons (ui.md § Icons) per device type. */
export const WORKHOLDING_TYPE_ICON: Record<WorkholdingType, IconName> = {
  toeClamp: 'toe-clamp',
  vise: 'vise',
  screw: 'screw',
  block: 'block',
  base: 'base',
  surface: 'surface-hold',
}

/** A `library.workholding.list` / `.get` row: the stored DTO plus its output-only flags. */
export type WorkholdingRow = LibraryItemDTO & {
  readonly kind: 'workholding'
  readonly builtIn?: true
  readonly isDefault?: true
}

export const asWorkholding = (i: LibraryItemDTO): WorkholdingRow | undefined =>
  i.kind === 'workholding' ? (i as WorkholdingRow) : undefined

export const isBuiltIn = (i: LibraryItemDTO): boolean => asWorkholding(i)?.builtIn === true
export const isDefaultRow = (i: LibraryItemDTO): boolean => asWorkholding(i)?.isDefault === true

/** A length in the window's unit, without the unit ("30", "1.25"); "–" if it does not load. */
export function lengthNumber(dto: QuantityDTO | undefined, units: UnitSystem): string {
  const mm = dto === undefined ? undefined : quantityOf(dto)?.canonical
  if (mm === undefined) return '–'
  const v = units === 'mm' ? mm : mm / 25.4
  return String(Number(v.toFixed(units === 'mm' ? 3 : 4)))
}

const unitWord = (units: UnitSystem) => (units === 'mm' ? 'mm' : 'in')

/** The list's main size: "30 × 60, top 25 mm", "jaws 150 mm", "head Ø 8 mm", a base's type. */
export function sizeText(v: WorkholdingDraft, units: UnitSystem): string {
  const n = (dto: QuantityDTO | undefined) => lengthNumber(dto, units)
  const u = unitWord(units)
  switch (v.type) {
    case 'toeClamp':
      return m.size.toeClamp(n(v.width), n(v.length), n(v.top), u)
    case 'vise':
      return m.size.vise(n(v.jawWidth), u)
    case 'screw':
      return m.size.screw(n(v.headDiameter), u)
    case 'block':
      return m.size.block(n(v.length), n(v.width), n(v.height), u)
    case 'base':
      return v.baseType === undefined ? '' : m.baseTypes[v.baseType]
    case 'surface':
      return v.surfaceType === undefined ? '' : m.surfaceTypes[v.surfaceType]
  }
}

/** The list's details cell: grip range and stud, soft jaws and opening, thread, sacrificial. */
export function detailsText(v: WorkholdingDraft, units: UnitSystem): string {
  const n = (dto: QuantityDTO | undefined) => lengthNumber(dto, units)
  const u = unitWord(units)
  const parts: string[] = []
  if (v.type === 'toeClamp') {
    if (v.gripMin !== undefined && v.gripMax !== undefined)
      parts.push(m.details.grip(n(v.gripMin), n(v.gripMax), u))
    if (v.stud !== undefined) parts.push(v.stud)
  } else if (v.type === 'vise') {
    if (v.soft === true) parts.push(m.details.soft)
    if (v.maxOpening !== undefined) parts.push(m.details.opening(n(v.maxOpening), u))
  } else if (v.type === 'screw') {
    if (v.thread !== undefined) parts.push(v.thread)
  } else if (v.type === 'base') {
    if (v.sacrificial === true) parts.push(m.details.sacrificial)
  }
  return parts.join(' · ')
}
