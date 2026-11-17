/**
 * Machine: a 3-axis router or mill on a GRBL-family controller.
 * Doc: docs/architecture/library.md#machine
 */
import { construct, invariants } from '../../shared/model'
import { None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import type { Quantity } from '../quantity/quantity'
import { Rational } from '../quantity/rational'
import type { QuantityKind } from '../quantity/units'
import type { InvariantChecker } from '../../shared/model'
import {
  checkKind,
  checkNameAndNotes,
  checkPositive,
  collectFields,
  lessThan,
  optionalField,
  optionalQuantityDTO,
  optionalQuantityFromDTO,
  quantityFromDTO,
  toOption,
} from './item'
import type { MachineValuesDTO } from './machine.dto'
import type { QuantityDTO } from '../quantity/quantity.dto'

export interface Axes<T> {
  readonly x: T
  readonly y: T
  readonly z: T
}

export interface Spindle {
  readonly control: 'gcode' | 'manual'
  readonly maxSpeed: Quantity
  readonly minSpeed: Option<Quantity>
}

export interface MachineProps {
  readonly name: string
  readonly notes: Option<string>
  readonly controller: 'grbl'
  readonly travel: Axes<Quantity>
  readonly maxFeedRate: Axes<Quantity>
  /** Scalar quantities in mm/s² (acceleration is not a v0.1 quantity kind). */
  readonly acceleration: Option<Axes<Quantity>>
  readonly spindle: Spindle
  readonly programUnits: 'mm' | 'in'
  readonly toolChanger: 'none'
}

const AXES = ['x', 'y', 'z'] as const

function checkAxes(c: InvariantChecker, field: string, a: Axes<Quantity>, kind: QuantityKind) {
  for (const axis of AXES) checkPositive(c, [field, axis], a[axis], kind)
}

export class Machine implements MachineProps {
  readonly kind = 'machine'

  private constructor(
    readonly name: string,
    readonly notes: Option<string>,
    readonly controller: 'grbl',
    readonly travel: Axes<Quantity>,
    readonly maxFeedRate: Axes<Quantity>,
    readonly acceleration: Option<Axes<Quantity>>,
    readonly spindle: Spindle,
    readonly programUnits: 'mm' | 'in',
    readonly toolChanger: 'none',
  ) {
    invariants('Machine', (c) => {
      checkNameAndNotes(c, name, notes)
      checkAxes(c, 'travel', travel, 'length')
      checkAxes(c, 'maxFeedRate', maxFeedRate, 'feedRate')
      if (acceleration.isSome()) checkAxes(c, 'acceleration', acceleration.unwrap(), 'scalar')
      checkPositive(c, ['spindle', 'maxSpeed'], spindle.maxSpeed, 'spindleSpeed')
      if (spindle.minSpeed.isSome()) {
        const min = spindle.minSpeed.unwrap()
        const path = ['spindle', 'minSpeed']
        if (checkKind(c, path, min, 'spindleSpeed')) {
          const nonNegative = min.exact.compare(Rational.ZERO) >= 0
          c.check(nonNegative, path, 'nonNegative', 'must be 0 or more', { actual: min.canonical })
          if (nonNegative && spindle.maxSpeed.kind === 'spindleSpeed')
            c.check(
              lessThan(min, spindle.maxSpeed),
              path,
              'lessThanMaxSpeed',
              'must be less than the maximum speed',
              { max: spindle.maxSpeed.canonical, actual: min.canonical },
            )
        }
      }
    })
    Object.freeze(travel)
    Object.freeze(maxFeedRate)
    if (acceleration.isSome()) Object.freeze(acceleration.unwrap())
    Object.freeze(spindle)
    Object.freeze(this)
  }

  static create(p: MachineProps): AppResult<Machine> {
    const copy = <T>(a: Axes<T>): Axes<T> => ({ x: a.x, y: a.y, z: a.z })
    return construct(
      'Machine',
      () =>
        new Machine(
          p.name,
          p.notes,
          p.controller,
          copy(p.travel),
          copy(p.maxFeedRate),
          p.acceleration.map(copy),
          { ...p.spindle },
          p.programUnits,
          p.toolChanger,
        ),
    )
  }

  /** Load shape-checked values (`parseWith(MachineValuesDtoSchema, …)` first). */
  static fromDTO(dto: MachineValuesDTO): AppResult<Machine> {
    return collectFields({
      travel: axesFromDTO(dto.travel, 'travel'),
      maxFeedRate: axesFromDTO(dto.maxFeedRate, 'maxFeedRate'),
      acceleration:
        dto.acceleration === undefined
          ? Ok(None)
          : axesFromDTO(dto.acceleration, 'acceleration').map((a) => Some(a)),
      maxSpeed: quantityFromDTO(dto.spindle.maxSpeed, 'spindle', 'maxSpeed'),
      minSpeed: optionalQuantityFromDTO(dto.spindle.minSpeed, 'spindle', 'minSpeed'),
    }).andThen((q) =>
      Machine.create({
        name: dto.name,
        notes: toOption(dto.notes),
        controller: dto.controller,
        travel: q.travel,
        maxFeedRate: q.maxFeedRate,
        acceleration: q.acceleration,
        spindle: { control: dto.spindle.control, maxSpeed: q.maxSpeed, minSpeed: q.minSpeed },
        programUnits: dto.programUnits,
        toolChanger: dto.toolChanger,
      }),
    )
  }

  with(patch: Partial<MachineProps>): AppResult<Machine> {
    return Machine.create({ ...this.props(), ...patch })
  }

  toDTO(): MachineValuesDTO {
    // Quantity kinds are model invariants, so the kind-specific DTO type holds.
    return {
      kind: 'machine',
      name: this.name,
      ...optionalField('notes', this.notes),
      controller: this.controller,
      travel: axesToDTO(this.travel),
      maxFeedRate: axesToDTO(this.maxFeedRate),
      ...optionalField('acceleration', this.acceleration.map(axesToDTO)),
      spindle: {
        control: this.spindle.control,
        maxSpeed: this.spindle.maxSpeed.toDTO(),
        ...optionalQuantityDTO('minSpeed', this.spindle.minSpeed),
      },
      programUnits: this.programUnits,
      toolChanger: this.toolChanger,
    } as MachineValuesDTO
  }

  private props(): MachineProps {
    return { ...this }
  }
}

function axesFromDTO(a: Axes<QuantityDTO>, field: string): AppResult<Axes<Quantity>> {
  return collectFields({
    x: quantityFromDTO(a.x, field, 'x'),
    y: quantityFromDTO(a.y, field, 'y'),
    z: quantityFromDTO(a.z, field, 'z'),
  })
}

const axesToDTO = (a: Axes<Quantity>): Axes<QuantityDTO> => ({
  x: a.x.toDTO(),
  y: a.y.toDTO(),
  z: a.z.toDTO(),
})
