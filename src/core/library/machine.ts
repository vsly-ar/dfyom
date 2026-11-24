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
import type { HomingCorner, MachineValuesDTO, Rigidity } from './machine.dto'
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
  /** Rated output power (kind `power`); None skips the feeds-and-speeds power check. */
  readonly power: Option<Quantity>
}

export interface MachineProps {
  readonly name: string
  readonly notes: Option<string>
  readonly controller: 'grbl'
  readonly travel: Axes<Quantity>
  readonly maxFeedRate: Axes<Quantity>
  /** Scalar quantities in mm/s² (acceleration is not a v0.1 quantity kind). */
  readonly acceleration: Option<Axes<Quantity>>
  /** GRBL `$11` (length); None = the virtual machine's default. */
  readonly junctionDeviation: Option<Quantity>
  /** GRBL `$12` (length); None = the virtual machine's default. */
  readonly arcTolerance: Option<Quantity>
  /** GRBL `$100–$102`: scalar quantities in steps/mm. */
  readonly stepsPerMm: Option<Axes<Quantity>>
  readonly spindle: Spindle
  readonly programUnits: 'mm' | 'in'
  readonly toolChanger: 'none'
  /** Feeds-and-speeds rigidity preset; None = lowest (`extrusion`). */
  readonly rigidity: Option<Rigidity>
  /** XY homing corner (`$23`); None = `backRight` (GRBL default). */
  readonly homingCorner: Option<HomingCorner>
  /** Homing pull-off (`$27`, length); None = 1 mm. */
  readonly pullOff: Option<Quantity>
  /** Soft limits (`$20`); None = on. */
  readonly softLimits: Option<boolean>
  /**
   * Spindle nose (where stickout is measured) to the table top with Z homed (length); None =
   * the Z headroom check is skipped (docs/architecture/grbl.md#z-headroom-hardening-df68).
   */
  readonly noseToTable: Option<Quantity>
  /** Spoilboard thickness on the table (length, ≥ 0); None = unknown (Z headroom partly checked). */
  readonly spoilboardThickness: Option<Quantity>
  /**
   * Largest extent of the Z touch plate (length); None = unknown, the touch-off spot then leaves
   * room for the tool only (docs/modes/z-reference.md#touch-off-spot, hardening DF69).
   */
  readonly probePlateSize: Option<Quantity>
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
    readonly junctionDeviation: Option<Quantity>,
    readonly arcTolerance: Option<Quantity>,
    readonly stepsPerMm: Option<Axes<Quantity>>,
    readonly spindle: Spindle,
    readonly programUnits: 'mm' | 'in',
    readonly toolChanger: 'none',
    readonly rigidity: Option<Rigidity>,
    readonly homingCorner: Option<HomingCorner>,
    readonly pullOff: Option<Quantity>,
    readonly softLimits: Option<boolean>,
    readonly noseToTable: Option<Quantity>,
    readonly spoilboardThickness: Option<Quantity>,
    readonly probePlateSize: Option<Quantity>,
  ) {
    invariants('Machine', (c) => {
      checkNameAndNotes(c, name, notes)
      checkAxes(c, 'travel', travel, 'length')
      checkAxes(c, 'maxFeedRate', maxFeedRate, 'feedRate')
      if (acceleration.isSome()) checkAxes(c, 'acceleration', acceleration.unwrap(), 'scalar')
      if (junctionDeviation.isSome())
        checkPositive(c, ['junctionDeviation'], junctionDeviation.unwrap(), 'length')
      if (arcTolerance.isSome()) checkPositive(c, ['arcTolerance'], arcTolerance.unwrap(), 'length')
      if (stepsPerMm.isSome()) checkAxes(c, 'stepsPerMm', stepsPerMm.unwrap(), 'scalar')
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
      if (pullOff.isSome()) checkPositive(c, ['pullOff'], pullOff.unwrap(), 'length')
      if (spindle.power.isSome())
        checkPositive(c, ['spindle', 'power'], spindle.power.unwrap(), 'power')
      if (noseToTable.isSome()) checkPositive(c, ['noseToTable'], noseToTable.unwrap(), 'length')
      if (probePlateSize.isSome())
        checkPositive(c, ['probePlateSize'], probePlateSize.unwrap(), 'length')
      if (spoilboardThickness.isSome()) {
        const board = spoilboardThickness.unwrap()
        const path = ['spoilboardThickness']
        if (checkKind(c, path, board, 'length')) {
          const nonNegative = board.exact.compare(Rational.ZERO) >= 0
          c.check(nonNegative, path, 'nonNegative', 'must be 0 or more', {
            actual: board.canonical,
          })
          const nose = noseToTable.isSome() ? noseToTable.unwrap() : undefined
          if (nonNegative && nose !== undefined && nose.kind === 'length')
            c.check(
              lessThan(board, nose),
              path,
              'lessThanNoseToTable',
              'must be less than the spindle nose to table distance',
              { max: nose.canonical, actual: board.canonical },
            )
        }
      }
    })
    Object.freeze(travel)
    Object.freeze(maxFeedRate)
    if (acceleration.isSome()) Object.freeze(acceleration.unwrap())
    if (stepsPerMm.isSome()) Object.freeze(stepsPerMm.unwrap())
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
          p.junctionDeviation,
          p.arcTolerance,
          p.stepsPerMm.map(copy),
          { ...p.spindle },
          p.programUnits,
          p.toolChanger,
          p.rigidity,
          p.homingCorner,
          p.pullOff,
          p.softLimits,
          p.noseToTable,
          p.spoilboardThickness,
          p.probePlateSize,
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
      junctionDeviation: optionalQuantityFromDTO(dto.junctionDeviation, 'junctionDeviation'),
      arcTolerance: optionalQuantityFromDTO(dto.arcTolerance, 'arcTolerance'),
      stepsPerMm:
        dto.stepsPerMm === undefined
          ? Ok(None)
          : axesFromDTO(dto.stepsPerMm, 'stepsPerMm').map((a) => Some(a)),
      maxSpeed: quantityFromDTO(dto.spindle.maxSpeed, 'spindle', 'maxSpeed'),
      minSpeed: optionalQuantityFromDTO(dto.spindle.minSpeed, 'spindle', 'minSpeed'),
      power: optionalQuantityFromDTO(dto.spindle.power, 'spindle', 'power'),
      pullOff: optionalQuantityFromDTO(dto.pullOff, 'pullOff'),
      noseToTable: optionalQuantityFromDTO(dto.noseToTable, 'noseToTable'),
      spoilboardThickness: optionalQuantityFromDTO(dto.spoilboardThickness, 'spoilboardThickness'),
      probePlateSize: optionalQuantityFromDTO(dto.probePlateSize, 'probePlateSize'),
    }).andThen((q) =>
      Machine.create({
        name: dto.name,
        notes: toOption(dto.notes),
        controller: dto.controller,
        travel: q.travel,
        maxFeedRate: q.maxFeedRate,
        acceleration: q.acceleration,
        junctionDeviation: q.junctionDeviation,
        arcTolerance: q.arcTolerance,
        stepsPerMm: q.stepsPerMm,
        spindle: {
          control: dto.spindle.control,
          maxSpeed: q.maxSpeed,
          minSpeed: q.minSpeed,
          power: q.power,
        },
        programUnits: dto.programUnits,
        toolChanger: dto.toolChanger,
        rigidity: toOption(dto.rigidity),
        homingCorner: toOption(dto.homingCorner),
        pullOff: q.pullOff,
        softLimits: toOption(dto.softLimits),
        noseToTable: q.noseToTable,
        spoilboardThickness: q.spoilboardThickness,
        probePlateSize: q.probePlateSize,
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
      ...optionalQuantityDTO('junctionDeviation', this.junctionDeviation),
      ...optionalQuantityDTO('arcTolerance', this.arcTolerance),
      ...optionalField('stepsPerMm', this.stepsPerMm.map(axesToDTO)),
      spindle: {
        control: this.spindle.control,
        maxSpeed: this.spindle.maxSpeed.toDTO(),
        ...optionalQuantityDTO('minSpeed', this.spindle.minSpeed),
        ...optionalQuantityDTO('power', this.spindle.power),
      },
      programUnits: this.programUnits,
      toolChanger: this.toolChanger,
      ...optionalField('rigidity', this.rigidity),
      ...optionalField('homingCorner', this.homingCorner),
      ...optionalQuantityDTO('pullOff', this.pullOff),
      ...optionalField('softLimits', this.softLimits),
      ...optionalQuantityDTO('noseToTable', this.noseToTable),
      ...optionalQuantityDTO('spoilboardThickness', this.spoilboardThickness),
      ...optionalQuantityDTO('probePlateSize', this.probePlateSize),
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
