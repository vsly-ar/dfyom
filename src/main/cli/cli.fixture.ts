// Test-only: the bundled CLI (Vitest global setup) spawned interactively, line by line.
// Not app code. Doc: docs/architecture/llm-api.md#testing
import { spawn } from 'node:child_process'
import { inject } from 'vitest'

export interface Exit {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

export interface CliProcess {
  /** Writes one JSON line to stdin. */
  send(message: unknown): void
  /** The next stdout line, parsed as JSON. */
  next(): Promise<Record<string, unknown>>
  end(): void
  kill(signal: NodeJS.Signals): void
  readonly exited: Promise<Exit>
}

export function spawnCli(args: readonly string[], dataDir: string): CliProcess {
  const child = spawn(process.execPath, [inject('cliEntry'), ...args, '--data-dir', dataDir], {
    env: {
      ...process.env,
      DFYOM_TEST_WORKER_ENTRY: inject('productionWorkerEntry'),
      DFYOM_TEST_MACHINE_ENTRY: inject('machineEntry'),
    },
  })
  let stdout = ''
  let stderr = ''
  let buffered = ''
  const lines: string[] = []
  const waiters: ((line: string) => void)[] = []
  child.stdout.on('data', (d: Buffer) => {
    stdout += d.toString()
    buffered += d.toString()
    for (let i = buffered.indexOf('\n'); i >= 0; i = buffered.indexOf('\n')) {
      const line = buffered.slice(0, i)
      buffered = buffered.slice(i + 1)
      const w = waiters.shift()
      if (w === undefined) lines.push(line)
      else w(line)
    }
  })
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
  const exited = new Promise<Exit>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) =>
      resolve({ code: code ?? (signal === null ? null : -1), stdout, stderr }),
    )
  })
  return {
    send: (m) => void child.stdin.write(`${JSON.stringify(m)}\n`),
    next: async () => {
      const line = lines.shift() ?? (await new Promise<string>((r) => waiters.push(r)))
      return JSON.parse(line) as Record<string, unknown>
    },
    end: () => child.stdin.end(),
    kill: (signal) => void child.kill(signal),
    exited,
  }
}

export const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw-test', version: '1' },
  },
}
export const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' }

export const toolCall = (id: number, name: string, args: object = {}) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
})
