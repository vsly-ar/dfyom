// The Run controller settings table (v0.5 RV2). Doc: docs/conventions/ui.md#run-settings-v05-rv2
import { describe, expect, it } from 'vitest'
import { len, machineValues, rpm } from '../../library/library.fixture'
import { machineSettingsDiff } from '../../library/grbl-import'
import type { MachineValuesDTO } from '../../library/machine.dto'
import { controllerSettingsTable, GRBL_SETTINGS } from './settings-catalog'
import { parseSettingsText } from './settings'
import { GRBL_11H_DEFAULTS } from './settings.fixture'

const settingsOf = (text: string): Record<string, number> =>
  Object.fromEntries([...parseSettingsText(text).settings].map(([n, v]) => [String(n), v]))

const machine = (): MachineValuesDTO =>
  ({
    ...machineValues(),
    spindle: { control: 'gcode', maxSpeed: rpm('24000'), minSpeed: rpm('6200') },
    softLimits: true,
    homingCorner: 'backLeft',
    pullOff: len('1'),
  }) as MachineValuesDTO

describe('controllerSettingsTable (v0.5 RV2)', () => {
  it('names every GRBL 1.1 setting of a default $$ with its unit; without a machine nothing maps', () => {
    const settings = settingsOf(GRBL_11H_DEFAULTS)
    const rows = controllerSettingsTable(settings)
    expect(rows.map((r) => r.n)).toEqual(
      Object.keys(settings)
        .map(Number)
        .sort((a, b) => a - b),
    )
    for (const r of rows) {
      expect(r.name, r.setting).toBe(GRBL_SETTINGS.get(r.n)?.name)
      expect(r.unit).toBeDefined()
      expect(r.differs).toBe(false)
      expect(r.field).toBeUndefined()
    }
    expect(rows.find((r) => r.n === 110)).toMatchObject({
      name: 'X max rate',
      unit: 'mm/min',
      controller: '500',
    })
  })

  it('maps every setting the $$ import maps, marks its differences and offers the copy line', () => {
    const settings = {
      ...settingsOf(GRBL_11H_DEFAULTS),
      '20': 1,
      '22': 1,
      '23': 0, // X/Y back right
      '27': 1,
      '30': 24000,
      '31': 6200,
      '110': 5000,
      '111': 4000,
      '130': 400,
      '999': 7,
    }
    const m = machine()
    const rows = controllerSettingsTable(settings, m)
    const row = (n: number) => rows.find((r) => r.n === n)!
    // every setting the import maps has its field (the diff's changes, unchanged and skipped)
    const diff = machineSettingsDiff(m, new Map(Object.entries(settings).map(([k, v]) => [+k, v])))
    const mapped = [
      ...diff.changes.map((c) => c.setting),
      ...diff.unchanged,
      ...diff.skipped.map((s) => s.setting),
    ]
    for (const s of mapped) expect(rows.find((r) => r.setting === s)?.field, s).toBeDefined()
    // equal: no mark
    expect(row(110)).toMatchObject({
      field: 'maxFeedRate.x',
      machine: '5000 mm/min',
      differs: false,
    })
    expect(row(110).copy).toBeUndefined()
    // different: marked, the machine's value to copy in GRBL's unit
    expect(row(111)).toMatchObject({ differs: true, copy: '$111=5000', machine: '5000 mm/min' })
    expect(row(130)).toMatchObject({ field: 'travel.x', differs: true, copy: '$130=800' })
    // the homing corner: back left is bit 1 (Y homes −)
    expect(row(23)).toMatchObject({ field: 'homingCorner', differs: true, copy: '$23=1' })
    // Z homing down is skipped by the import: shown, never compared
    expect(controllerSettingsTable({ '23': 5 }, m)[0]).toMatchObject({ differs: false })
    // a setting GRBL 1.1 does not define: number and value only
    expect(row(999)).toMatchObject({
      name: undefined,
      unit: undefined,
      controller: '7',
      differs: false,
    })
    expect(row(32)).toMatchObject({ name: 'Laser-mode enable', unit: 'boolean' })
  })

  it('a manual spindle: $30 maps but is not compared (the import skips it)', () => {
    const m = { ...machineValues() } as MachineValuesDTO
    const rows = controllerSettingsTable({ '30': 1000, '110': 4000 }, m)
    expect(rows[0]).toMatchObject({ n: 30, field: 'spindle.maxSpeed', differs: false })
    expect(rows[1]).toMatchObject({ n: 110, differs: true, copy: '$110=5000' })
  })
})
