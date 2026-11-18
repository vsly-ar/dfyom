// Test-only worker tasks (registered only in test-entry.ts). Doc: docs/architecture/workers.md#testing
import { z } from 'zod'
import { Err, Ok } from '../../shared/result'
import type { AnyWorkerTask, WorkerTask } from '../../core/commands/jobs'

const busy = (ms: number) => {
  const end = performance.now() + ms
  while (performance.now() < end) {
    // burn CPU: a synchronous step that cannot be interrupted
  }
}

/** `steps` steps of `stepMs` each, with progress; ends `{ done }`. */
export const testLoop: WorkerTask<{ steps: number; stepMs: number }, { done: number }> = {
  name: 'test.loop',
  lane: 'toolpath',
  input: z.object({ steps: z.number().int(), stepMs: z.number() }),
  output: z.object({ done: z.number() }),
  timeoutMs: 60_000,
  run({ steps, stepMs }, ctl) {
    for (let i = 0; i < steps; i++) {
      busy(stepMs)
      const s = ctl.steps.step({ done: i + 1, total: steps, label: `step ${i + 1}` })
      if (s.isErr()) return Err(s.unwrapErr())
    }
    return Ok({ done: steps })
  },
}

export const testThrow: WorkerTask<null, null> = {
  name: 'test.throw',
  lane: 'toolpath',
  input: z.null(),
  output: z.null(),
  timeoutMs: 5_000,
  run() {
    throw new Error('test task threw')
  },
}

export const testExit: WorkerTask<{ code: number }, null> = {
  name: 'test.exit',
  lane: 'toolpath',
  input: z.object({ code: z.number().int() }),
  output: z.null(),
  timeoutMs: 5_000,
  run({ code }) {
    process.exit(code)
  },
}

/** Never returns and never steps (only `terminate()` ends it). */
export const testHang: WorkerTask<{ timeoutMs: number }, null> = {
  name: 'test.hang',
  lane: 'toolpath',
  input: z.object({ timeoutMs: z.number() }),
  output: z.null(),
  timeoutMs: 300,
  run() {
    for (;;) busy(1_000)
  },
}

/** Logs `count` info entries, then returns. */
export const testLog: WorkerTask<{ count: number }, { logged: number }> = {
  name: 'test.log',
  lane: 'toolpath',
  input: z.object({ count: z.number().int() }),
  output: z.object({ logged: z.number() }),
  timeoutMs: 5_000,
  run({ count }, ctl) {
    for (let i = 0; i < count; i++) ctl.log.info({ i }, 'hello from the worker')
    return Ok({ logged: count })
  },
}

export const TEST_TASKS: readonly AnyWorkerTask[] = [
  testLoop,
  testThrow,
  testExit,
  testHang,
  testLog,
]
