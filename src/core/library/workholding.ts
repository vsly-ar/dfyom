/**
 * Workholding library item values: what a device is (a toe clamp's strap, a vise's jaws, a screw's
 * head). Where it sits stays in the setup item. One flat model for every device type; a field
 * not of the item's type is refused (`notForKind`, as `plan.workholding.set`).
 * Doc: docs/modes/workholding-library.md#item-model
 */
import { construct, invariants, type InvariantChecker } from '../../shared/model'
import type { AppResult, Option } from '../../shared/result'
import type { Quantity } from '../quantity/quantity'
import {
  checkKind,
  checkNameAndNotes,
  checkPositive,
  checkText,
  isPositive,
  lessThan,
  optionalField,
  optionalQuantityFromDTO,
  toOption,
  collectFields,
} from './item'
import {
  THREAD_MAX,
  type BaseType,
  type SurfaceType,
  type WorkholdingType,
  type WorkholdingValuesDTO,
} from './workholding.dto'

/** The length fields, in file order. */
export const WORKHOLDING_SIZES = [
  'width',
  'length',
  'top',
  'gripMin',
  'gripMax',
  'jawWidth',
  'jawThickness',
  'jawHeight',
  'maxOpening',
  'headDiameter',
  'headHeight',
  'height',
  'thickness',
] as const
export type WorkholdingSize = (typeof WORKHOLDING_SIZES)[number]

/** Every type-specific field (sizes, flags, texts, sub-types). */
export type WorkholdingField =
  WorkholdingSize | 'stud' | 'soft' | 'thread' | 'baseType' | 'sacrificial' | 'surfaceType'

/** Required and optional fields per type (workholding-library.md § Item model). */
export const WORKHOLDING_FIELDS: Readonly<
  Record<
    WorkholdingType,
    {
      readonly required: readonly WorkholdingField[]
      readonly optional: readonly WorkholdingField[]
    }
  >
> = {
  toeClamp: { required: ['width', 'length', 'top'], optional: ['gripMin', 'gripMax', 'stud'] },
  vise: { required: ['jawWidth', 'jawThickness', 'soft'], optional: ['jawHeight', 'maxOpening'] },
  screw: { required: ['headDiameter', 'headHeight'], optional: ['thread'] },
  block: { required: ['length', 'width', 'height'], optional: [] },
  base: { required: ['baseType', 'sacrificial'], optional: ['thickness'] },
  surface: { required: ['surfaceType'], optional: [] },
}

/** Sizes that may be 0 (a flush screw head, a base of unknown thickness). */
const MAY_BE_ZERO: readonly WorkholdingSize[] = ['headHeight', 'thickness']

export interface WorkholdingProps {
  readonly name: string
  readonly notes: Option<string>
  readonly type: WorkholdingType
  /** `default: true`: the default of its type for Add and Arrange automatically (Q135). */
  readonly isDefault: boolean
  readonly sizes: Readonly<Partial<Record<WorkholdingSize, Quantity>>>
  readonly stud: Option<string>
  readonly soft: Option<boolean>
  readonly thread: Option<string>
  readonly baseType: Option<BaseType>
  readonly sacrificial: Option<boolean>
  readonly surfaceType: Option<SurfaceType>
}

export class Workholding implements WorkholdingProps {
  readonly kind = 'workholding'

  private constructor(
    readonly name: string,
    readonly notes: Option<string>,
    readonly type: WorkholdingType,
    readonly isDefault: boolean,
    readonly sizes: Readonly<Partial<Record<WorkholdingSize, Quantity>>>,
    readonly stud: Option<string>,
    readonly soft: Option<boolean>,
    readonly thread: Option<string>,
    readonly baseType: Option<BaseType>,
    readonly sacrificial: Option<boolean>,
    readonly surfaceType: Option<SurfaceType>,
  ) {
    invariants('Workholding', (c) => {
      checkNameAndNotes(c, name, notes)
      const fields = WORKHOLDING_FIELDS[type]
      const own = [...fields.required, ...fields.optional]
      for (const f of allFields())
        if (this.has(f) && !own.includes(f))
          c.check(false, [f], 'notForKind', `a ${type} takes ${own.join(', ')}`, { type })
      for (const f of fields.required)
        c.check(this.has(f), [f], 'required', `a ${type} needs ${f}`, { type })
      for (const f of WORKHOLDING_SIZES) {
        const q = sizes[f]
        if (q === undefined || !own.includes(f)) continue
        if (MAY_BE_ZERO.includes(f)) checkNotNegative(c, f, q)
        else checkPositive(c, [f], q, 'length')
      }
      if (stud.isSome()) checkText(c, ['stud'], stud.unwrap(), 1, THREAD_MAX)
      if (thread.isSome()) checkText(c, ['thread'], thread.unwrap(), 1, THREAD_MAX)
      if (type === 'toeClamp') checkGrip(c, sizes)
    })
    Object.freeze(sizes)
    Object.freeze(this)
  }

  static create(p: WorkholdingProps): AppResult<Workholding> {
    return construct(
      'Workholding',
      () =>
        new Workholding(
          p.name,
          p.notes,
          p.type,
          p.isDefault,
          Object.fromEntries(
            WORKHOLDING_SIZES.flatMap((f) => (p.sizes[f] === undefined ? [] : [[f, p.sizes[f]]])),
          ),
          p.stud,
          p.soft,
          p.thread,
          p.baseType,
          p.sacrificial,
          p.surfaceType,
        ),
    )
  }

  /** Load shape-checked values (`parseWith(WorkholdingValuesDtoSchema, …)` first). */
  static fromDTO(dto: WorkholdingValuesDTO): AppResult<Workholding> {
    const sizes = collectFields(
      Object.fromEntries(
        WORKHOLDING_SIZES.map((f) => [f, optionalQuantityFromDTO(dto[f], f)]),
      ) as Record<WorkholdingSize, AppResult<Option<Quantity>>>,
    )
    if (sizes.isErr()) return sizes
    const s = sizes.unwrap()
    return Workholding.create({
      name: dto.name,
      notes: toOption(dto.notes),
      type: dto.type,
      isDefault: dto.default === true,
      sizes: Object.fromEntries(
        WORKHOLDING_SIZES.flatMap((f) => (s[f].isSome() ? [[f, s[f].unwrap()]] : [])),
      ),
      stud: toOption(dto.stud),
      soft: toOption(dto.soft),
      thread: toOption(dto.thread),
      baseType: toOption(dto.baseType),
      sacrificial: toOption(dto.sacrificial),
      surfaceType: toOption(dto.surfaceType),
    })
  }

  with(patch: Partial<WorkholdingProps>): AppResult<Workholding> {
    return Workholding.create({ ...this.props(), ...patch })
  }

  size(f: WorkholdingSize): Option<Quantity> {
    return toOption(this.sizes[f])
  }

  /** Field order: kind, name, notes, type, default (only when set), then the type's fields. */
  toDTO(): WorkholdingValuesDTO {
    const sizes = Object.fromEntries(
      WORKHOLDING_SIZES.flatMap((f) => {
        const q = this.sizes[f]
        return q === undefined ? [] : [[f, q.toDTO()]]
      }),
    )
    // Insert the non-size fields at their schema positions for a stable file key order.
    const ordered: Record<string, unknown> = {
      kind: 'workholding',
      name: this.name,
      ...optionalField('notes', this.notes),
      type: this.type,
      ...(this.isDefault ? { default: true } : {}),
    }
    const extra: Record<string, unknown> = {
      ...optionalField('stud', this.stud),
      ...optionalField('soft', this.soft),
      ...optionalField('thread', this.thread),
      ...optionalField('baseType', this.baseType),
      ...optionalField('sacrificial', this.sacrificial),
      ...optionalField('surfaceType', this.surfaceType),
    }
    for (const k of FILE_ORDER) {
      if (k in sizes) ordered[k] = sizes[k]
      else if (k in extra) ordered[k] = extra[k]
    }
    // Quantity kinds are model invariants, so the length DTO type holds.
    return ordered as WorkholdingValuesDTO
  }

  private has(f: WorkholdingField): boolean {
    switch (f) {
      case 'stud':
      case 'soft':
      case 'thread':
      case 'baseType':
      case 'sacrificial':
      case 'surfaceType':
        return (this[f] as Option<unknown>).isSome()
      default:
        return this.sizes[f] !== undefined
    }
  }

  private props(): WorkholdingProps {
    return { ...this }
  }
}

const FILE_ORDER: readonly WorkholdingField[] = [
  'width',
  'length',
  'top',
  'gripMin',
  'gripMax',
  'stud',
  'jawWidth',
  'jawThickness',
  'jawHeight',
  'maxOpening',
  'soft',
  'headDiameter',
  'headHeight',
  'thread',
  'height',
  'baseType',
  'sacrificial',
  'thickness',
  'surfaceType',
]

const allFields = (): readonly WorkholdingField[] => FILE_ORDER

function checkNotNegative(c: InvariantChecker, f: WorkholdingSize, q: Quantity): void {
  if (!checkKind(c, [f], q, 'length')) return
  c.check(isPositive(q) || q.canonical === 0, [f], 'nonNegative', 'must be 0 or more', {
    actual: q.canonical,
  })
}

/** `gripMin` and `gripMax` together, `gripMin` ≤ `gripMax` < `length`. */
function checkGrip(
  c: InvariantChecker,
  sizes: Readonly<Partial<Record<WorkholdingSize, Quantity>>>,
): void {
  const { gripMin: min, gripMax: max, length } = sizes
  if ((min === undefined) !== (max === undefined)) {
    const missing = min === undefined ? 'gripMin' : 'gripMax'
    c.check(false, [missing], 'gripRange', 'give gripMin and gripMax together')
    return
  }
  if (min === undefined || max === undefined) return
  if (min.kind !== 'length' || max.kind !== 'length') return
  c.check(!lessThan(max, min), ['gripMax'], 'gripRange', 'must be at least gripMin', {
    min: min.canonical,
    actual: max.canonical,
  })
  if (length !== undefined && length.kind === 'length')
    c.check(lessThan(max, length), ['gripMax'], 'lessThanLength', 'must be less than length', {
      max: length.canonical,
      actual: max.canonical,
    })
}

/** Type defaults the command input may omit: a vise is not soft, a spoilboard is sacrificial. */
export function withTypeDefaults(dto: WorkholdingValuesDTO): WorkholdingValuesDTO {
  if (dto.type === 'vise' && dto.soft === undefined) return { ...dto, soft: false }
  if (dto.type === 'base' && dto.sacrificial === undefined)
    return { ...dto, sacrificial: (dto.baseType ?? 'spoilboard') === 'spoilboard' }
  return dto
}
