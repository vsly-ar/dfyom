// User-facing strings of the "New tool" and "New machine" forms in plan mode's pickers. Field
// names follow docs/architecture/library.md (ISO 13399 symbols in the hints); terms from
// docs/glossary.md. Doc: docs/conventions/ui.md#plan-mode-task-37, #internationalization
import type { Rigidity } from '../../../core/library/machine.dto'
import type { ToolMaterial, ToolType } from '../../../core/library/tool.dto'

export const libraryMessages = {
  cancel: 'Cancel',
  name: 'Name',
  failed: 'The item was not added to the library.',
  unnamed: 'Name it, or leave it empty for the suggested name.',

  tool: {
    open: 'New tool…',
    title: 'New tool',
    description:
      'Adds a tool to the library and assigns it to this operation. Feeds and speeds come from the calculator, or type them in the inspector.',
    add: 'Add tool',
    type: 'Type',
    types: {
      flatEndMill: 'Flat end mill',
      bullNoseEndMill: 'Bull nose end mill',
      ballEndMill: 'Ball end mill',
      drill: 'Drill',
    } satisfies Record<ToolType, string>,
    /** Short type word of the suggested name ("Flat 6"). */
    shortTypes: {
      flatEndMill: 'Flat',
      bullNoseEndMill: 'Bull',
      ballEndMill: 'Ball',
      drill: 'Drill',
    } satisfies Record<ToolType, string>,
    diameter: 'Diameter',
    cornerRadius: 'Corner radius',
    fluteLength: 'Flute length',
    overallLength: 'Overall length',
    fluteCount: 'Flutes',
    pointAngle: 'Point angle',
    toolMaterial: 'Tool material',
    materials: { carbide: 'Carbide', hss: 'HSS', other: 'Other' } satisfies Record<
      ToolMaterial,
      string
    >,
  },

  machine: {
    open: 'New machine…',
    title: 'New machine',
    description:
      'Adds a 3-axis GRBL machine to the library. Its limits are checked by the plan and used for feeds and speeds.',
    add: 'Add machine',
    defaultName: 'My machine',
    travel: 'Travel',
    travelAxis: (axis: string) => `Travel ${axis}`,
    maxFeed: 'Max feed rate',
    maxFeedAxis: (axis: string) => `Max feed rate ${axis}`,
    spindle: 'Spindle',
    control: 'Spindle control',
    controls: { manual: 'Manual dial', gcode: 'By gCode' },
    maxSpeed: 'Max spindle speed',
    minSpeed: 'Min spindle speed',
    power: 'Spindle power',
    minSpeedNote: 'Optional: flags speeds below the spindle’s range.',
    powerNote: 'Optional: enables the feeds-and-speeds power check.',
    rigidity: 'Rigidity',
    rigidities: {
      extrusion: 'Aluminium extrusion',
      hobby: 'Hobby router',
      prosumer: 'Prosumer router',
      benchMill: 'Bench mill',
      rigidMill: 'Rigid mill',
    } satisfies Record<Rigidity, string>,
    programUnits: 'gCode units',
    units: { mm: 'mm (G21)', in: 'inch (G20)' },
  },
}
