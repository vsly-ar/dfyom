// Test-only app hosts in temp data dirs (in-process workers, no machine unless given), and a
// small part with a plan built through tool calls. Not app code. Doc: docs/architecture/llm-api.md#testing
import { mkdtempSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { createInProcessWorkers, type FileSource } from '../../core/commands/jobs'
import { testStock } from '../../core/design/design.fixture'
import { libraryInput, machineValues } from '../../core/library/library.fixture'
import { flat6 } from '../../core/plan/plan.fixture'
import type { MachineService } from '../../core/run/service'
import { noopLogger } from '../../shared/logging'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { testFs } from '../persistence/fs.testing'
import { createProjectStorage } from '../persistence/storage'
import { createGcodeFiles } from '../persistence/gcode-file'
import { createAppHost, type AppHost } from './app-host'

/** A temp folder removed by `cleanup()`. */
export function tempDir(prefix = 'dfyom-host-'): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

let instances = 0

export async function testHost(
  appData: string,
  o: { machine?: MachineService; instanceId?: string; files?: FileSource } = {},
): Promise<AppHost> {
  const instanceId = o.instanceId ?? `test-instance-${process.pid}-${++instances}`
  return expectOk(
    await createAppHost({
      appData,
      appVersion: '0.0.0-test',
      instanceId,
      log: noopLogger,
      // The host's default project storage, without disk flushes (load-stable, see `testFs`).
      storage: createProjectStorage({
        fs: testFs,
        appData,
        appVersion: '0.0.0-test',
        owner: { instanceId, pid: process.pid, host: hostname() },
        log: noopLogger,
      }),
      report: () => {},
      workers: createInProcessWorkers(o.files === undefined ? {} : { files: o.files }),
      exportFiles: { write: async (target) => Ok({ filePath: target }) },
      gcodeFiles: createGcodeFiles(),
      ...(o.machine === undefined ? {} : { machine: o.machine }),
    }),
  )
}

/** Calls a tool that must succeed (any adapter: session, MCP client, …); returns its value. */
export type Call = (name: string, args?: object) => Promise<unknown>

/**
 * A stock, one flat end mill, a machine, a project with a part (facing + pocket) and a draft plan,
 * through tool calls. Returns the ids.
 */
export async function buildSmallPlan(call: Call) {
  const stock = ((await call('library.stock.add', { values: testStock() })) as { id: string }).id
  await call('library.tool.add', { values: libraryInput(flat6()) })
  const m = libraryInput(machineValues())
  const machine = ((await call('library.machine.add', { values: m })) as { id: string }).id
  const created = (await call('project.create', { name: 'Small', unitSystem: 'mm' })) as {
    key: string
    revision: number
  }
  const { partId } = (await call('design.part.add', {
    name: 'Small',
    stockLibraryItemId: stock,
    expectedRevision: created.revision,
  })) as { partId: string }
  await call('design.facing.add', { partId, depth: '0.5' })
  await call('design.pocket.add', {
    partId,
    shape: { kind: 'rectangle', center: ['50', '30'], length: '40', width: '25' },
    depth: '3',
  })
  const { planId } = (await call('plan.create', { partId, machineLibraryItemId: machine })) as {
    planId: string
  }
  expect(planId).toBeTruthy()
  return { key: created.key, partId, planId, stock, machine }
}
