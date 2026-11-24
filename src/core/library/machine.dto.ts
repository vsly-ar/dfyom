/**
 * Persisted shape of a machine item's values (limits mirror GRBL `$` settings).
 * Shape only; domain rules live in Machine. Doc: docs/architecture/library.md#machine
 */
import { z } from 'zod'
import { commonValuesShape, quantityDto } from './item'

/**
 * Machine rigidity presets, lowest first (the default when unset). Their factors live in the
 * calculator: docs/architecture/feeds-speeds.md#machine-rigidity-presets
 */
export const RIGIDITY_PRESETS = [
  'extrusion',
  'hobby',
  'prosumer',
  'fixedGantry',
  'benchMill',
  'rigidMill',
] as const
export type Rigidity = (typeof RIGIDITY_PRESETS)[number]
export const RigiditySchema = z.enum(RIGIDITY_PRESETS)

/**
 * XY corner the machine homes to (Z always homes up); GRBL `$23` bits 0 (X to −) and 1 (Y to −).
 * Doc: docs/modes/run.md#machine-coordinates-and-the-homing-corner-df33
 */
export const HOMING_CORNERS = ['backRight', 'backLeft', 'frontRight', 'frontLeft'] as const
export type HomingCorner = (typeof HOMING_CORNERS)[number]
export const HomingCornerSchema = z.enum(HOMING_CORNERS)

const axes = <S extends z.ZodType>(s: S) => z.object({ x: s, y: s, z: s })

export const MachineValuesDtoSchema = z.object({
  kind: z.literal('machine'),
  ...commonValuesShape,
  controller: z.literal('grbl').describe('grblHAL and FluidNC use the same value'),
  travel: axes(quantityDto('length')).describe('Work envelope ($130–$132)'),
  maxFeedRate: axes(quantityDto('feedRate')).describe('Also the G0 rapid rate ($110–$112)'),
  acceleration: axes(quantityDto('scalar'))
    .optional()
    .describe('Scalar values in mm/s² ($120–$122)'),
  junctionDeviation: quantityDto('length')
    .optional()
    .describe('$11: GRBL cornering model; unset = 0.010 mm'),
  arcTolerance: quantityDto('length')
    .optional()
    .describe('$12: arc chord tolerance; unset = 0.002 mm'),
  stepsPerMm: axes(quantityDto('scalar'))
    .optional()
    .describe('Scalar values in steps/mm ($100–$102); all three axes or none'),
  spindle: z.object({
    control: z.enum(['gcode', 'manual']).describe('manual: export pauses for a dial router'),
    maxSpeed: quantityDto('spindleSpeed').describe('$30'),
    minSpeed: quantityDto('spindleSpeed').optional().describe('$31; below maxSpeed'),
    power: quantityDto('power')
      .optional()
      .describe('Rated output power, for the feeds-and-speeds power check'),
  }),
  rigidity: RigiditySchema.optional().describe(
    'Frame rigidity preset for feeds and speeds; unset = extrusion (lowest)',
  ),
  homingCorner: HomingCornerSchema.optional().describe(
    'XY corner the machine homes to ($23; Z homes up); unset = backRight (GRBL $23=0)',
  ),
  pullOff: quantityDto('length').optional().describe('$27 homing pull-off; unset = 1 mm'),
  softLimits: z.boolean().optional().describe('$20 soft limits; unset = on'),
  noseToTable: quantityDto('length')
    .optional()
    .describe('Spindle nose to table top with Z homed; for the Z headroom check'),
  spoilboardThickness: quantityDto('length')
    .optional()
    .describe('Spoilboard on the table, 0 = none; for the Z headroom check'),
  probePlateSize: quantityDto('length')
    .optional()
    .describe('Largest extent of the Z touch plate; the touch-off spot leaves room for it'),
  // Z touch plate (docs/modes/run-machine.md#probing-and-re-zero-m4)
  probePlateThickness: quantityDto('length')
    .optional()
    .describe('Z touch plate thickness; unset = no plate, Run offers no Probe Z'),
  programUnits: z.enum(['mm', 'in']).describe('G21/G20 in exported gCode'),
  toolChanger: z.literal('none').describe('Manual tool change (M0)'),
})

export type MachineValuesDTO = z.output<typeof MachineValuesDtoSchema>
