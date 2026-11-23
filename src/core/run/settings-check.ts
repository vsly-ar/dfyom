/**
 * The settings check of a real-machine connection: the controller's `$$` against the machine copy
 * the connection was opened with, through the `$$` import's diff. A difference does not refuse the
 * connection but refuses real runs. Pure. Doc: docs/modes/run-machine.md#settings-check
 */
import { z } from 'zod'
import { machineSettingsDiff } from '../library/grbl-import'
import type { MachineValuesDTO } from '../library/machine.dto'

export const SettingsCheckSchema = z.object({
  /** The plan's machine copy, or the library machine (manual control). */
  against: z.enum(['plan', 'machine']),
  /** No difference and homing enabled: a real run may start. */
  matches: z.boolean(),
  /** Settings the machine copy sets to another value than the controller: they block real runs. */
  differences: z.array(
    z.object({
      setting: z.string().describe('e.g. $130'),
      field: z.string().describe('Machine field path, e.g. travel.x'),
      controller: z.string().describe("The controller's value, with unit"),
      machine: z.string().describe("The machine copy's value"),
    }),
  ),
  /**
   * Mapped settings the machine copy leaves unset (e.g. acceleration): the controller's value
   * applies; informational, they do not block (`$$` import fills them).
   */
  notInMachine: z.array(z.string().describe('e.g. $120')),
  /** `$22 = 1`: DFYOM runs only on a homed machine. */
  homingEnabled: z.boolean(),
})
export type SettingsCheck = z.output<typeof SettingsCheckSchema>

/** `settings`: the handshake's `$$` by setting number (`ControllerInfo.settings`). */
export function settingsCheck(
  machine: MachineValuesDTO,
  settings: Readonly<Record<string, number>>,
  against: SettingsCheck['against'],
): SettingsCheck {
  const map = new Map<number, number>()
  for (const [k, v] of Object.entries(settings)) map.set(Number(k), v)
  const diff = machineSettingsDiff(machine, map)
  const differences: SettingsCheck['differences'] = []
  const notInMachine: string[] = []
  for (const c of diff.changes)
    if (c.from === null) notInMachine.push(c.setting)
    else differences.push({ setting: c.setting, field: c.field, controller: c.to, machine: c.from })
  const homingEnabled = (settings['22'] ?? 0) !== 0
  return {
    against,
    matches: differences.length === 0 && homingEnabled,
    differences,
    notInMachine,
    homingEnabled,
  }
}
