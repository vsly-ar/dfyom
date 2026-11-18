// Entry of the headless `dfyom` CLI / MCP server: a separate build output with no Electron
// import (docs/architecture/llm-api.md decision 15). Run by `node out/main/cli.js` in development
// and by the app's binary with `ELECTRON_RUN_AS_NODE=1` when packaged.
import { MACHINE_WORKER_ENTRY_PATH } from '../machine/bundled'
import { WORKER_ENTRY_PATH } from '../workers/bundled'
import { runCli } from './main'

void runCli(
  process.argv.slice(2),
  {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    exit: (code) => process.exit(code),
  },
  { worker: WORKER_ENTRY_PATH, machine: MACHINE_WORKER_ENTRY_PATH },
).then((code) => {
  // Let stdout drain, then exit (idle workers are unref'ed, but sockets may linger).
  process.stdout.write('', () => process.exit(code))
})
