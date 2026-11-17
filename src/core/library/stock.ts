/**
 * Stock: the material a part is cut from. v0.1 has one shape, the rectangular block.
 * Doc: docs/architecture/library.md#stock
 */
import { construct, invariants } from '../../shared/model'
import type { AppResult, Option } from '../../shared/result'
import type { Quantity } from '../quantity/quantity'
import {
  checkNameAndNotes,
  checkPositive,
  checkText,
  collectFields,
  NAME_MAX,
  optionalField,
  quantityFromDTO,
  toOption,
  type MaterialClass,
} from './item'
import type { StockValuesDTO } from './stock.dto'

export interface StockMaterial {
  readonly name: string
  readonly class: MaterialClass
}

export interface StockProps {
  readonly name: string
  readonly notes: Option<string>
  readonly shape: 'block'
  readonly length: Quantity
  readonly width: Quantity
  readonly thickness: Quantity
  readonly material: StockMaterial
}

export class Stock implements StockProps {
  readonly kind = 'stock'

  private constructor(
    readonly name: string,
    readonly notes: Option<string>,
    readonly shape: 'block',
    readonly length: Quantity,
    readonly width: Quantity,
    readonly thickness: Quantity,
    readonly material: StockMaterial,
  ) {
    invariants('Stock', (c) => {
      checkNameAndNotes(c, name, notes)
      checkPositive(c, ['length'], length, 'length')
      checkPositive(c, ['width'], width, 'length')
      checkPositive(c, ['thickness'], thickness, 'length')
      checkText(c, ['material', 'name'], material.name, 1, NAME_MAX)
    })
    Object.freeze(material)
    Object.freeze(this)
  }

  static create(p: StockProps): AppResult<Stock> {
    return construct(
      'Stock',
      () =>
        new Stock(p.name, p.notes, p.shape, p.length, p.width, p.thickness, {
          name: p.material.name,
          class: p.material.class,
        }),
    )
  }

  /** Load shape-checked values (`parseWith(StockValuesDtoSchema, …)` first). */
  static fromDTO(dto: StockValuesDTO): AppResult<Stock> {
    return collectFields({
      length: quantityFromDTO(dto.length, 'length'),
      width: quantityFromDTO(dto.width, 'width'),
      thickness: quantityFromDTO(dto.thickness, 'thickness'),
    }).andThen((q) =>
      Stock.create({
        name: dto.name,
        notes: toOption(dto.notes),
        shape: dto.shape,
        material: dto.material,
        ...q,
      }),
    )
  }

  with(patch: Partial<StockProps>): AppResult<Stock> {
    return Stock.create({ ...this.props(), ...patch })
  }

  toDTO(): StockValuesDTO {
    // Quantity kinds are model invariants, so the kind-specific DTO type holds.
    return {
      kind: 'stock',
      name: this.name,
      ...optionalField('notes', this.notes),
      shape: this.shape,
      length: this.length.toDTO(),
      width: this.width.toDTO(),
      thickness: this.thickness.toDTO(),
      material: { name: this.material.name, class: this.material.class },
    } as StockValuesDTO
  }

  private props(): StockProps {
    return { ...this }
  }
}
