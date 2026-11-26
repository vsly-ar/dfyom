/**
 * A stored library item: common meta (`id`, `revision`, `updatedAt`) plus the values of one
 * kind (Stock, Tool, Machine or Workholding). The values alone are what a snapshot copies.
 * Doc: docs/architecture/library.md#common-fields, #storage
 */
import { z } from 'zod'
import { construct, invariants } from '../../shared/model'
import { parseWith } from '../../shared/parse'
import { None, type AppResult, type Option } from '../../shared/result'
import {
  ITEM_ID_PATTERN,
  ITEM_ID_RULE,
  ItemMetaDtoSchema,
  optionalField,
  toOption,
  type LibraryItemKind,
} from './item'
import { Machine } from './machine'
import { MachineValuesDtoSchema, type MachineValuesDTO } from './machine.dto'
import { Stock } from './stock'
import { StockValuesDtoSchema, type StockValuesDTO } from './stock.dto'
import { Tool } from './tool'
import { ToolValuesDtoSchema, type ToolValuesDTO } from './tool.dto'
import { Workholding } from './workholding'
import { WorkholdingValuesDtoSchema, type WorkholdingValuesDTO } from './workholding.dto'

export type ItemValues = Stock | Tool | Machine | Workholding
export type ItemValuesDTO = StockValuesDTO | ToolValuesDTO | MachineValuesDTO | WorkholdingValuesDTO
export type ValuesOf<K extends LibraryItemKind> = Extract<ItemValues, { kind: K }>
export type ValuesDtoOf<K extends LibraryItemKind> = Extract<ItemValuesDTO, { kind: K }>

/** Values schema per kind (also the snapshot `values` schema). */
export const VALUES_SCHEMAS = {
  stock: StockValuesDtoSchema,
  tool: ToolValuesDtoSchema,
  machine: MachineValuesDtoSchema,
  workholding: WorkholdingValuesDtoSchema,
} as const

export const ItemValuesDtoSchema = z.discriminatedUnion('kind', [
  StockValuesDtoSchema,
  ToolValuesDtoSchema,
  MachineValuesDtoSchema,
  WorkholdingValuesDtoSchema,
])

/** One stored file: meta + values, flat. */
export const LibraryItemDtoSchema = z.discriminatedUnion('kind', [
  StockValuesDtoSchema.extend(ItemMetaDtoSchema.shape),
  ToolValuesDtoSchema.extend(ItemMetaDtoSchema.shape),
  MachineValuesDtoSchema.extend(ItemMetaDtoSchema.shape),
  WorkholdingValuesDtoSchema.extend(ItemMetaDtoSchema.shape),
])
export type LibraryItemDTO = z.output<typeof LibraryItemDtoSchema>

/** Builds the model of shape-checked values with `Model.fromDTO()`. */
export function valuesFromDTO(dto: ItemValuesDTO): AppResult<ItemValues> {
  switch (dto.kind) {
    case 'stock':
      return Stock.fromDTO(dto)
    case 'tool':
      return Tool.fromDTO(dto)
    case 'machine':
      return Machine.fromDTO(dto)
    case 'workholding':
      return Workholding.fromDTO(dto)
  }
}

/** Shape check + model of untrusted values (snapshot files, command args). */
export function parseValues(raw: unknown, where: string): AppResult<ItemValues> {
  return parseWith(ItemValuesDtoSchema, raw, where).andThen(valuesFromDTO)
}

export interface LibraryItemProps {
  readonly id: string
  readonly revision: number
  readonly updatedAt: string
  readonly values: ItemValues
  /** A stock variant's parent stock (library.md#stock-variants-df13); None for every other item. */
  readonly parentId?: Option<string>
}

export class LibraryItem implements LibraryItemProps {
  private constructor(
    readonly id: string,
    readonly revision: number,
    readonly updatedAt: string,
    readonly values: ItemValues,
    readonly parentId: Option<string>,
  ) {
    invariants('LibraryItem', (c) => {
      c.check(ITEM_ID_PATTERN.test(id), ['id'], 'pattern', ITEM_ID_RULE)
      if (parentId.isSome()) {
        const p = parentId.unwrap()
        c.check(ITEM_ID_PATTERN.test(p), ['parentId'], 'pattern', ITEM_ID_RULE)
        c.check(p !== id, ['parentId'], 'notSelf', 'must not be the item itself')
        c.check(values.kind === 'stock', ['parentId'], 'notStock', 'only stock has variants')
      }
      c.check(
        Number.isInteger(revision) && revision >= 1,
        ['revision'],
        'integer',
        'must be a whole number of at least 1',
        { min: 1, actual: revision },
      )
      c.check(
        !Number.isNaN(Date.parse(updatedAt)),
        ['updatedAt'],
        'isoDate',
        'must be an ISO 8601 time',
        { actual: updatedAt },
      )
    })
    Object.freeze(this)
  }

  static create(p: LibraryItemProps): AppResult<LibraryItem> {
    return construct(
      'LibraryItem',
      () => new LibraryItem(p.id, p.revision, p.updatedAt, p.values, p.parentId ?? None),
    )
  }

  static fromDTO(dto: LibraryItemDTO): AppResult<LibraryItem> {
    const { id, revision, updatedAt, parentId, ...values } = dto
    return valuesFromDTO(values).andThen((v) =>
      LibraryItem.create({ id, revision, updatedAt, values: v, parentId: toOption(parentId) }),
    )
  }

  get kind(): LibraryItemKind {
    return this.values.kind
  }

  /** The written successor: same id and parent, `revision + 1`, new values and time. */
  next(values: ItemValues, updatedAt: string): AppResult<LibraryItem> {
    return LibraryItem.create({
      id: this.id,
      revision: this.revision + 1,
      updatedAt,
      values,
      parentId: this.parentId,
    })
  }

  /** Meta first, then the values in model order: a stable key order for files. */
  toDTO(): LibraryItemDTO {
    return {
      id: this.id,
      revision: this.revision,
      updatedAt: this.updatedAt,
      ...optionalField('parentId', this.parentId),
      ...this.values.toDTO(),
    }
  }
}

/** Shape check + model of an untrusted stored item. */
export function parseLibraryItem(raw: unknown, where: string): AppResult<LibraryItem> {
  return parseWith(LibraryItemDtoSchema, raw, where).andThen(LibraryItem.fromDTO)
}
