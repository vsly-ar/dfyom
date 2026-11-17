// Test-only inputs for the post-processor. Not app code. Doc: docs/architecture/grbl.md
import { expectOk } from '../../shared/testing/result'
import { Some } from '../../shared/result'
import { machineValues, num, rpm } from '../library/library.fixture'
import { Machine } from '../library/machine'
import type { MachineValuesDTO } from '../library/machine.dto'
import type { Toolpath, ToolpathTool } from '../toolpath/model'
import { testPartToolpaths } from '../toolpath/testing/test-part'
import type { ExportInput, ExportOperation } from './export'
import type { PostOptions } from './grbl/post'
import type { ProgramTool } from './program'

/** Fixed generator string: golden files never change with the app version. */
export const OPTS: PostOptions = { generator: 'DFYOM test' }

/** A desktop router: 800 × 800 × 100 travel, 5000/5000/1000 mm/min, 400/400/200 mm/s². */
export function testMachine(over: Partial<MachineValuesDTO> = {}): Machine {
  return expectOk(
    Machine.fromDTO({
      ...machineValues(),
      acceleration: { x: num('400'), y: num('400'), z: num('200') },
      spindle: { control: 'gcode', maxSpeed: rpm('24000') },
      ...over,
    }),
  )
}

const TYPE_NAMES: Readonly<Record<ToolpathTool['type'], string>> = {
  flatEndMill: 'flat end mill',
  bullNoseEndMill: 'bull nose end mill',
  ballEndMill: 'ball end mill',
  drill: 'drill',
}

export function programTool(t: ToolpathTool): ProgramTool {
  return { name: `${t.diameter} mm ${TYPE_NAMES[t.type]}`, diameter: t.diameter }
}

export function operation(toolpath: Toolpath, tool: ToolpathTool, label?: string): ExportOperation {
  return { toolpath, tool: programTool(tool), label: label ?? toolpath.planOperationId }
}

export function exportInput(
  operations: readonly ExportOperation[],
  machine = testMachine(),
  over: Partial<ExportInput> = {},
): ExportInput {
  return {
    name: 'Plan 1',
    setup: { name: 'Setup 1', clearanceHeight: 10 },
    operations,
    machine: Some(machine),
    ...over,
  }
}

/** The geometry test part in design order: 5 tools, the 6 mm drill used twice. */
export function testPartExport(machine = testMachine()): ExportInput {
  return exportInput(
    testPartToolpaths().map(({ tool, tp }) => operation(tp, tool)),
    machine,
  )
}
