// Test-only CLI entry: the same `runCli` with the worker entries from the environment (bundled by
// the Vitest global setup, which cannot use electron-vite's `?modulePath`). Not app code.
// Doc: docs/architecture/llm-api.md#testing
import { runCli } from './main'

const worker = process.env['DFYOM_TEST_WORKER_ENTRY']
const machine = process.env['DFYOM_TEST_MACHINE_ENTRY']
if (worker === undefined || machine === undefined)
  throw new Error('DFYOM_TEST_WORKER_ENTRY and DFYOM_TEST_MACHINE_ENTRY must be set')

void runCli(
  process.argv.slice(2),
  {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    exit: (code) => process.exit(code),
  },
  { worker, machine },
).then((code) => {
  process.stdout.write('', () => process.exit(code))
})
