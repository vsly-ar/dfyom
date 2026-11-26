/**
 * Tool (ISO 13399 symbols) with per-type invariants, and its feeds-and-speeds presets.
 * Doc: docs/architecture/library.md#tool
 *
 * Machine limits and the calculator (task 2.12) are not here: plan mode checks them.
 */
import { construct, invariants } from '../../shared/model'
import { collect, type AppResult, type Option } from '../../shared/result'
import type { Quantity } from '../quantity/quantity'
import { Rational } from '../quantity/rational'
import {
  checkKind,
  checkNameAndNotes,
  checkPositive,
  checkText,
  collectFields,
  lessThan,
  optionalField,
  optionalQuantityDTO,
  optionalQuantityFromDTO,
  quantityFromDTO,
  toOption,
  type MaterialClass,
} from './item'
import {
  CHAMFER_MILL_ANGLE,
  COATING_MAX,
  PRESET_NAME_MAX,
  type CuttingPresetDTO,
  type ToolMaterial,
  type ToolType,
  type ToolValuesDTO,
} from './tool.dto'

export interface CuttingPresetProps {
  readonly name: string
  /** None = any material. */
  readonly materialClass: Option<MaterialClass>
  readonly spindleSpeed: Quantity
  readonly feedRate: Quantity
  readonly plungeRate: Quantity
  readonly stepdown: Option<Quantity>
  readonly stepover: Option<Quantity>
  /** Follows the calculator (library.md#recommended-presets); needs a material class. */
  readonly recommended?: boolean
}

/** One feeds-and-speeds preset; rules that need the tool (stepover ≤ DC, unique name) are Tool's. */
export class CuttingPreset implements CuttingPresetProps {
  private constructor(
    readonly name: string,
    readonly materialClass: Option<MaterialClass>,
    readonly spindleSpeed: Quantity,
    readonly feedRate: Quantity,
    readonly plungeRate: Quantity,
    readonly stepdown: Option<Quantity>,
    readonly stepover: Option<Quantity>,
    readonly recommended: boolean,
  ) {
    invariants('CuttingPreset', (c) => {
      checkText(c, ['name'], name, 1, PRESET_NAME_MAX)
      checkPositive(c, ['spindleSpeed'], spindleSpeed, 'spindleSpeed')
      checkPositive(c, ['feedRate'], feedRate, 'feedRate')
      checkPositive(c, ['plungeRate'], plungeRate, 'feedRate')
      if (stepdown.isSome()) checkPositive(c, ['stepdown'], stepdown.unwrap(), 'length')
      if (stepover.isSome()) checkPositive(c, ['stepover'], stepover.unwrap(), 'length')
      c.check(
        !recommended || materialClass.isSome(),
        ['recommended'],
        'recommendedNeedsClass',
        'needs a material class to follow the calculator',
      )
    })
    Object.freeze(this)
  }

  static create(p: CuttingPresetProps): AppResult<CuttingPreset> {
    return construct(
      'CuttingPreset',
      () =>
        new CuttingPreset(
          p.name,
          p.materialClass,
          p.spindleSpeed,
          p.feedRate,
          p.plungeRate,
          p.stepdown,
          p.stepover,
          p.recommended ?? false,
        ),
    )
  }

  static fromDTO(dto: CuttingPresetDTO): AppResult<CuttingPreset> {
    return collectFields({
      spindleSpeed: quantityFromDTO(dto.spindleSpeed, 'spindleSpeed'),
      feedRate: quantityFromDTO(dto.feedRate, 'feedRate'),
      plungeRate: quantityFromDTO(dto.plungeRate, 'plungeRate'),
      stepdown: optionalQuantityFromDTO(dto.stepdown, 'stepdown'),
      stepover: optionalQuantityFromDTO(dto.stepover, 'stepover'),
    }).andThen((q) =>
      CuttingPreset.create({
        name: dto.name,
        materialClass: toOption(dto.materialClass),
        recommended: dto.recommended === true,
        ...q,
      }),
    )
  }

  toDTO(): CuttingPresetDTO {
    return {
      name: this.name,
      ...optionalField('materialClass', this.materialClass),
      spindleSpeed: this.spindleSpeed.toDTO(),
      feedRate: this.feedRate.toDTO(),
      plungeRate: this.plungeRate.toDTO(),
      ...optionalQuantityDTO('stepdown', this.stepdown),
      ...optionalQuantityDTO('stepover', this.stepover),
      ...(this.recommended ? { recommended: true } : {}),
    } as CuttingPresetDTO // quantity kinds are model invariants
  }
}

export interface ToolProps {
  readonly name: string
  readonly notes: Option<string>
  readonly type: ToolType
  readonly diameter: Quantity
  /** Bull nose only; flat (0) and ball (DC/2) are derived – see `effectiveCornerRadius`. */
  readonly cornerRadius: Option<Quantity>
  readonly fluteLength: Quantity
  readonly overallLength: Quantity
  readonly stickout: Option<Quantity>
  readonly shankDiameter: Option<Quantity>
  readonly fluteCount: Quantity
  /** Drill only. */
  readonly pointAngle: Option<Quantity>
  /** Chamfer mill only (required): included angle, 10°–150°. */
  readonly angle: Option<Quantity>
  /** Chamfer mill only: smallest cutting diameter, 0 ≤ tip < DC; None = pointed (0). */
  readonly tipDiameter: Option<Quantity>
  readonly toolMaterial: Option<ToolMaterial>
  readonly coating: Option<string>
  readonly presets: readonly CuttingPreset[]
}

const TWO = Rational.int(2n)

export class Tool implements ToolProps {
  readonly kind = 'tool'

  private constructor(
    readonly name: string,
    readonly notes: Option<string>,
    readonly type: ToolType,
    readonly diameter: Quantity,
    readonly cornerRadius: Option<Quantity>,
    readonly fluteLength: Quantity,
    readonly overallLength: Quantity,
    readonly stickout: Option<Quantity>,
    readonly shankDiameter: Option<Quantity>,
    readonly fluteCount: Quantity,
    readonly pointAngle: Option<Quantity>,
    readonly angle: Option<Quantity>,
    readonly tipDiameter: Option<Quantity>,
    readonly toolMaterial: Option<ToolMaterial>,
    readonly coating: Option<string>,
    readonly presets: readonly CuttingPreset[],
  ) {
    invariants('Tool', (c) => {
      checkNameAndNotes(c, name, notes)
      checkPositive(c, ['diameter'], diameter, 'length')
      if (type === 'bullNoseEndMill') {
        c.check(cornerRadius.isSome(), ['cornerRadius'], 'required', 'is required for a bull nose')
        if (
          cornerRadius.isSome() &&
          checkKind(c, ['cornerRadius'], cornerRadius.unwrap(), 'length')
        ) {
          const re = cornerRadius.unwrap()
          c.check(
            re.exact.compare(Rational.ZERO) > 0 && re.exact.mul(TWO).compare(diameter.exact) < 0,
            ['cornerRadius'],
            'range',
            'must be greater than 0 and less than half the diameter',
            { min: 0, max: diameter.canonical / 2, actual: re.canonical },
          )
        }
      } else {
        c.check(
          cornerRadius.isNone(),
          ['cornerRadius'],
          'notAllowed',
          'is only stored for a bull nose end mill (flat = 0, ball = diameter/2)',
        )
      }
      checkPositive(c, ['fluteLength'], fluteLength, 'length')
      checkPositive(c, ['overallLength'], overallLength, 'length')
      if (stickout.isSome()) checkPositive(c, ['stickout'], stickout.unwrap(), 'length')
      if (shankDiameter.isSome())
        checkPositive(c, ['shankDiameter'], shankDiameter.unwrap(), 'length')
      if (checkKind(c, ['fluteCount'], fluteCount, 'scalar')) {
        c.check(
          fluteCount.exact.den === 1n && fluteCount.exact.num >= 1n,
          ['fluteCount'],
          'integer',
          'must be a whole number of at least 1',
          { min: 1, actual: fluteCount.canonical },
        )
      }
      if (type === 'drill') {
        c.check(pointAngle.isSome(), ['pointAngle'], 'required', 'is required for a drill')
        if (pointAngle.isSome() && checkKind(c, ['pointAngle'], pointAngle.unwrap(), 'angle')) {
          const sig = pointAngle.unwrap().canonical
          c.check(sig > 0 && sig < 180, ['pointAngle'], 'range', 'must be between 0° and 180°', {
            min: 0,
            max: 180,
            actual: sig,
          })
        }
      } else {
        c.check(pointAngle.isNone(), ['pointAngle'], 'notAllowed', 'is only stored for a drill')
      }
      if (type === 'chamferMill') {
        c.check(angle.isSome(), ['angle'], 'required', 'is required for a chamfer mill')
        if (angle.isSome() && checkKind(c, ['angle'], angle.unwrap(), 'angle')) {
          const a = angle.unwrap().canonical
          const { min, max } = CHAMFER_MILL_ANGLE
          c.check(a >= min && a <= max, ['angle'], 'range', `must be between ${min}° and ${max}°`, {
            min,
            max,
            actual: a,
          })
        }
        if (tipDiameter.isSome() && checkKind(c, ['tipDiameter'], tipDiameter.unwrap(), 'length')) {
          const dt = tipDiameter.unwrap()
          c.check(
            dt.exact.compare(Rational.ZERO) >= 0 &&
              (diameter.kind !== 'length' || dt.exact.compare(diameter.exact) < 0),
            ['tipDiameter'],
            'range',
            'must be at least 0 and less than the diameter',
            { min: 0, max: diameter.canonical, actual: dt.canonical },
          )
        }
      } else {
        c.check(angle.isNone(), ['angle'], 'notAllowed', 'is only stored for a chamfer mill')
        c.check(
          tipDiameter.isNone(),
          ['tipDiameter'],
          'notAllowed',
          'is only stored for a chamfer mill',
        )
      }
      if (coating.isSome()) checkText(c, ['coating'], coating.unwrap(), 0, COATING_MAX)

      // Cross-field rules (kinds compared only when both are lengths).
      const lengths = (...qs: Quantity[]) => qs.every((q) => q.kind === 'length')
      if (lengths(fluteLength, overallLength))
        c.check(
          lessThan(fluteLength, overallLength),
          ['overallLength'],
          'greaterThanFluteLength',
          'must be greater than the flute length',
          { min: fluteLength.canonical, actual: overallLength.canonical },
        )
      if (stickout.isSome() && lengths(stickout.unwrap(), overallLength))
        c.check(
          lessThan(stickout.unwrap(), overallLength),
          ['stickout'],
          'lessThanOverallLength',
          'must be less than the overall length',
          { max: overallLength.canonical, actual: stickout.unwrap().canonical },
        )
      const seen = new Set<string>()
      presets.forEach((p, i) => {
        if (p.stepover.isSome() && lengths(diameter))
          c.check(
            p.stepover.unwrap().exact.compare(diameter.exact) <= 0,
            ['presets', i, 'stepover'],
            'atMostDiameter',
            'must not exceed the tool diameter',
            { max: diameter.canonical, actual: p.stepover.unwrap().canonical },
          )
        c.check(!seen.has(p.name), ['presets', i, 'name'], 'unique', 'is used by another preset', {
          actual: p.name,
        })
        seen.add(p.name)
      })
    })
    Object.freeze(presets)
    Object.freeze(this)
  }

  static create(p: ToolProps): AppResult<Tool> {
    return construct(
      'Tool',
      () =>
        new Tool(
          p.name,
          p.notes,
          p.type,
          p.diameter,
          p.cornerRadius,
          p.fluteLength,
          p.overallLength,
          p.stickout,
          p.shankDiameter,
          p.fluteCount,
          p.pointAngle,
          p.angle,
          p.tipDiameter,
          p.toolMaterial,
          p.coating,
          [...p.presets],
        ),
    )
  }

  /** Load shape-checked values (`parseWith(ToolValuesDtoSchema, …)` first). */
  static fromDTO(dto: ToolValuesDTO): AppResult<Tool> {
    const presets = collect(
      dto.presets.map((p, i) =>
        CuttingPreset.fromDTO(p).mapErr((e) => e.prefixIssues('presets', i)),
      ),
    )
    return collectFields({
      diameter: quantityFromDTO(dto.diameter, 'diameter'),
      cornerRadius: optionalQuantityFromDTO(dto.cornerRadius, 'cornerRadius'),
      fluteLength: quantityFromDTO(dto.fluteLength, 'fluteLength'),
      overallLength: quantityFromDTO(dto.overallLength, 'overallLength'),
      stickout: optionalQuantityFromDTO(dto.stickout, 'stickout'),
      shankDiameter: optionalQuantityFromDTO(dto.shankDiameter, 'shankDiameter'),
      fluteCount: quantityFromDTO(dto.fluteCount, 'fluteCount'),
      pointAngle: optionalQuantityFromDTO(dto.pointAngle, 'pointAngle'),
      angle: optionalQuantityFromDTO(dto.angle, 'angle'),
      tipDiameter: optionalQuantityFromDTO(dto.tipDiameter, 'tipDiameter'),
      presets,
    }).andThen((q) =>
      Tool.create({
        name: dto.name,
        notes: toOption(dto.notes),
        type: dto.type,
        toolMaterial: toOption(dto.toolMaterial),
        coating: toOption(dto.coating),
        ...q,
      }),
    )
  }

  /** RE as used for tip geometry: stored for bull nose, 0 for flat and drill, DC/2 for ball. */
  get effectiveCornerRadius(): Rational {
    if (this.type === 'ballEndMill') return this.diameter.exact.div(TWO).unwrap()
    return this.cornerRadius.isSome() ? this.cornerRadius.unwrap().exact : Rational.ZERO
  }

  /** Chamfer mill: the tip diameter in mm (0 when pointed); 0 for other types. */
  get tipDiameterMm(): number {
    return this.tipDiameter.mapOr(0, (q) => q.canonical)
  }

  with(patch: Partial<ToolProps>): AppResult<Tool> {
    return Tool.create({ ...this.props(), ...patch })
  }

  toDTO(): ToolValuesDTO {
    // Quantity kinds are model invariants, so the kind-specific DTO type holds.
    return {
      kind: 'tool',
      name: this.name,
      ...optionalField('notes', this.notes),
      type: this.type,
      diameter: this.diameter.toDTO(),
      ...optionalQuantityDTO('cornerRadius', this.cornerRadius),
      fluteLength: this.fluteLength.toDTO(),
      overallLength: this.overallLength.toDTO(),
      ...optionalQuantityDTO('stickout', this.stickout),
      ...optionalQuantityDTO('shankDiameter', this.shankDiameter),
      fluteCount: this.fluteCount.toDTO(),
      ...optionalQuantityDTO('pointAngle', this.pointAngle),
      ...optionalQuantityDTO('angle', this.angle),
      ...optionalQuantityDTO('tipDiameter', this.tipDiameter),
      ...optionalField('toolMaterial', this.toolMaterial),
      ...optionalField('coating', this.coating),
      presets: this.presets.map((p) => p.toDTO()),
    } as ToolValuesDTO
  }

  private props(): ToolProps {
    return { ...this }
  }
}
