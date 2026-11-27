/**
 * Tool holder: the collet nut and the spindle body above it, each a diameter (and the nut a
 * length), with the built-in presets. Part of the machine and of a tool's override (H6).
 * Doc: docs/modes/tool-holder.md#model
 */
import type { InvariantChecker } from '../../shared/model'
import { fail, None, Some, type AppResult, type Option } from '../../shared/result'
import { Quantity } from '../quantity/quantity'
import type { QuantityDTO } from '../quantity/quantity.dto'
import {
  checkKind,
  checkPositive,
  collectFields,
  optionalQuantityDTO,
  optionalQuantityFromDTO,
} from './item'
import { HOLDER_PRESET_IDS, type HolderDTO, type HolderPresetId } from './holder.dto'

export interface Holder {
  /** The preset the sizes came from (display only; edited sizes keep it). */
  readonly preset: Option<HolderPresetId>
  /** Largest diameter of the collet nut (across the hex or the round nut). */
  readonly nutDiameter: Quantity
  /** From the nut face (the spindle nose, where stickout is measured) up to the body. */
  readonly nutLength: Quantity
  /** The spindle or router body above the nut; it counts to infinity upward. ≥ nutDiameter. */
  readonly bodyDiameter: Quantity
  /** Largest shank the collet system takes (warning only, Q183). */
  readonly maxShank: Option<Quantity>
}

export type HolderSize = 'nutDiameter' | 'nutLength' | 'bodyDiameter' | 'maxShank'
export const HOLDER_SIZES: readonly HolderSize[] = [
  'nutDiameter',
  'nutLength',
  'bodyDiameter',
  'maxShank',
]
const REQUIRED: readonly HolderSize[] = ['nutDiameter', 'nutLength', 'bodyDiameter']

/**
 * Preset sizes as entered (sources). ER nut diameters and collet capacities follow the ISO 15488
 * (DIN 6499) nut drawings (standard hex/round nut "A", mini nut "M"); nut lengths, spindle bodies
 * and the router values are typical, approximate sizes (tool-holder.md § Presets says which).
 */
export const HOLDER_PRESETS: Readonly<
  Record<HolderPresetId, Readonly<Record<HolderSize, string>>>
> = {
  er11: { nutDiameter: '19 mm', nutLength: '12 mm', bodyDiameter: '52 mm', maxShank: '7 mm' },
  er11Mini: { nutDiameter: '16 mm', nutLength: '11 mm', bodyDiameter: '52 mm', maxShank: '7 mm' },
  er16: { nutDiameter: '32 mm', nutLength: '18 mm', bodyDiameter: '65 mm', maxShank: '10 mm' },
  er16Mini: {
    nutDiameter: '22 mm',
    nutLength: '17 mm',
    bodyDiameter: '65 mm',
    maxShank: '10 mm',
  },
  er20: { nutDiameter: '35 mm', nutLength: '20 mm', bodyDiameter: '80 mm', maxShank: '13 mm' },
  er20Mini: {
    nutDiameter: '28 mm',
    nutLength: '19 mm',
    bodyDiameter: '80 mm',
    maxShank: '13 mm',
  },
  trimRouter: {
    nutDiameter: '24 mm',
    nutLength: '20 mm',
    bodyDiameter: '65 mm',
    maxShank: '1/4"',
  },
  plungeRouter: {
    nutDiameter: '30 mm',
    nutLength: '25 mm',
    bodyDiameter: '80 mm',
    maxShank: '1/2"',
  },
}

/** Short preset names for plan messages ("Collet nut (ER11, Ø19)", DF132 H2). */
export const HOLDER_PRESET_NAMES: Readonly<Record<HolderPresetId, string>> = {
  er11: 'ER11',
  er11Mini: 'ER11 mini',
  er16: 'ER16',
  er16Mini: 'ER16 mini',
  er20: 'ER20',
  er20Mini: 'ER20 mini',
  trimRouter: 'trim router',
  plungeRouter: 'router',
}

/** A length quantity DTO (the holder's sizes; the kind is a model invariant). */
type LengthDTO = QuantityDTO & { kind: 'length' }

/** A preset size as stored: "19 mm" as the bare "19" in mm (as a user types it in a mm form). */
const parseSize = (source: string): LengthDTO =>
  Quantity.parse(source.replace(/ mm$/, ''), { kind: 'length', defaultUnit: 'mm' })
    .unwrap()
    .toDTO() as LengthDTO

/** A preset's sizes as quantity DTOs (all four). */
export function presetHolderSizes(id: HolderPresetId): Record<HolderSize, LengthDTO> {
  const p = HOLDER_PRESETS[id]
  return {
    nutDiameter: parseSize(p.nutDiameter),
    nutLength: parseSize(p.nutLength),
    bodyDiameter: parseSize(p.bodyDiameter),
    maxShank: parseSize(p.maxShank),
  }
}

/** A preset as a full holder DTO (what choosing it in the form stores). */
export function presetHolderDTO(id: HolderPresetId): HolderDTO {
  return { preset: id, ...presetHolderSizes(id) }
}

/** The holder's rules, inside a model constructor's `invariants()` body, below `path`. */
export function checkHolder(c: InvariantChecker, path: readonly string[], h: Holder): void {
  c.check(
    h.preset.isNone() || (HOLDER_PRESET_IDS as readonly string[]).includes(h.preset.unwrap()),
    [...path, 'preset'],
    'unknownPreset',
    'is not a holder preset',
  )
  checkPositive(c, [...path, 'nutDiameter'], h.nutDiameter, 'length')
  checkPositive(c, [...path, 'nutLength'], h.nutLength, 'length')
  checkPositive(c, [...path, 'bodyDiameter'], h.bodyDiameter, 'length')
  if (h.maxShank.isSome()) checkPositive(c, [...path, 'maxShank'], h.maxShank.unwrap(), 'length')
  if (
    checkKind(c, [...path, 'bodyDiameter'], h.bodyDiameter, 'length') &&
    h.nutDiameter.kind === 'length'
  )
    c.check(
      h.bodyDiameter.exact.compare(h.nutDiameter.exact) >= 0,
      [...path, 'bodyDiameter'],
      'atLeastNutDiameter',
      'must be at least the nut diameter',
      { min: h.nutDiameter.canonical, actual: h.bodyDiameter.canonical },
    )
}

/**
 * The holder of shape-checked values: sizes not given come from `preset`; without a preset the
 * nut and body sizes are `required` (issues below `path`). Other rules: `checkHolder`.
 */
export function holderFromDTO(dto: HolderDTO, ...path: string[]): AppResult<Holder> {
  const preset = dto.preset === undefined ? undefined : presetHolderSizes(dto.preset)
  const missing = REQUIRED.filter((f) => dto[f] === undefined && preset === undefined)
  if (missing.length > 0)
    return fail('model.invariant', 'a holder without a preset needs its sizes', {
      issues: missing.map((f) => ({
        path: [...path, f],
        rule: 'required',
        message: 'enter the size or choose a preset',
      })),
    })
  const size = (f: HolderSize) => optionalQuantityFromDTO(dto[f] ?? preset?.[f], ...path, f)
  return collectFields({
    nutDiameter: size('nutDiameter'),
    nutLength: size('nutLength'),
    bodyDiameter: size('bodyDiameter'),
    maxShank: size('maxShank'),
  }).map((q) => ({
    preset: dto.preset === undefined ? None : Some(dto.preset),
    // present: given or from the preset (checked above)
    nutDiameter: q.nutDiameter.unwrap(),
    nutLength: q.nutLength.unwrap(),
    bodyDiameter: q.bodyDiameter.unwrap(),
    maxShank: q.maxShank,
  }))
}

export function holderToDTO(h: Holder): HolderDTO {
  // the sizes' kind is a model invariant, so the length DTO type holds
  return {
    ...(h.preset.isSome() ? { preset: h.preset.unwrap() } : {}),
    nutDiameter: h.nutDiameter.toDTO(),
    nutLength: h.nutLength.toDTO(),
    bodyDiameter: h.bodyDiameter.toDTO(),
    ...optionalQuantityDTO('maxShank', h.maxShank),
  } as HolderDTO
}

/**
 * Whether a holder's sizes differ from its preset's ("ER11, edited"); false without a preset.
 * Compares exact values, so a preset entered in inches is not "edited".
 */
export function holderEdited(dto: HolderDTO): boolean {
  if (dto.preset === undefined) return false
  const p = presetHolderSizes(dto.preset)
  return HOLDER_SIZES.some((f) => {
    const v = dto[f]
    if (v === undefined) return f === 'maxShank'
    return v.exact.num !== p[f].exact.num || v.exact.den !== p[f].exact.den
  })
}

/** Anything that may carry a holder: a library tool (its override) or a machine. */
interface HolderCarrier {
  readonly holder: Option<Holder>
}

/**
 * The holder a tool runs in (DF132 H6, docs/modes/tool-holder.md#model): the tool's own override,
 * else the machine's holder, else none (the WH-F cylinder). The override holds on every machine,
 * also on a plan without one.
 */
export function resolveHolder(
  tool: HolderCarrier | undefined,
  machine: Option<HolderCarrier>,
): Option<Holder> {
  if (tool !== undefined && tool.holder.isSome()) return tool.holder
  return machine.andThen((m) => m.holder)
}
