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
  'benchMill',
  'rigidMill',
] as const
export type Rigidity = (typeof RIGIDITY_PRESETS)[number]
export const RigiditySchema = z.enum(RIGIDITY_PRESETS)

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
  programUnits: z.enum(['mm', 'in']).describe('G21/G20 in exported gCode'),
  toolChanger: z.literal('none').describe('Manual tool change (M0)'),
})

export type MachineValuesDTO = z.output<typeof MachineValuesDtoSchema>
