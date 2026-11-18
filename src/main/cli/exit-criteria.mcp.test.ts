// The v0.1 exit criteria headless, through MCP: an SDK client spawns `dfyom mcp` (the bundled
// CLI, temp data dir) over stdio and runs the exit-criteria flow (exit-criteria.fixture.ts):
// create → design → plan → toolpaths → export (golden gCode) → virtual run at `max` with tool
// changes and progress → save → close → reopen. Also checks the CI criterion.
// Spec: docs/plans/v0.1.md#exit-criteria, docs/architecture/llm-api.md#testing,
// docs/conventions/testing.md#end-to-end
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Progress } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, describe, expect, inject, it } from 'vitest'
import { toMcpName } from '../../core/agent/tools'
import { type CallResult, exitCriteriaFlow } from './exit-criteria.fixture'

const dir = mkdtempSync(join(tmpdir(), 'dfyom-e2e-mcp-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

interface ToolResult {
  isError?: boolean
  structuredContent?: { value?: unknown; revision?: number; error?: { code: string } }
  content: { type: string; text: string }[]
}

describe('exit criteria headless: dfyom mcp (stdio)', { timeout: 180_000 }, () => {
  it('runs the v0.1 flow through MCP tools, with progress notifications', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [inject('cliEntry'), 'mcp', '--data-dir', dir],
      env: {
        ...(process.env as Record<string, string>),
        DFYOM_TEST_WORKER_ENTRY: inject('productionWorkerEntry'),
        DFYOM_TEST_MACHINE_ENTRY: inject('machineEntry'),
      },
      stderr: 'pipe',
    })
    const stderr: string[] = []
    transport.stderr?.on('data', (d: Buffer) => stderr.push(d.toString()))
    const client = new Client({ name: 'exit-criteria-test', version: '1.0.0' })
    await client.connect(transport)

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'project_create',
        'design_pocket_add',
        'job_wait',
        'run_job_continue',
      ]),
    )
    expect(tools.every((t) => t.outputSchema === undefined)).toBe(true)

    const notifications: { name: string; p: Progress }[] = []
    const call = async (name: string, args: object = {}): Promise<CallResult> => {
      const mcpName = toMcpName(name)
      const r = (await client.callTool(
        { name: mcpName, arguments: args as Record<string, unknown> },
        undefined,
        { timeout: 120_000, onprogress: (p) => notifications.push({ name: mcpName, p }) },
      )) as ToolResult
      const sc = r.structuredContent
      if (r.isError === true)
        return { ok: false, error: sc?.error ?? { code: 'unknown', message: r.content[0]?.text } }
      return { ok: true, value: sc?.value, revision: sc?.revision }
    }

    const { runProgress } = await exitCriteriaFlow(call, dir)

    // the run's progress also reaches the client as MCP progress notifications of job_wait,
    // incl. the tool-change label. Not asserted: that the last one is complete. The SDK client
    // handles a notification a microtask after a response read in the same chunk, so it drops
    // a final tick sent just before the response (the job_wait result carries it).
    const lines = runProgress.at(-1)!.total!
    const runNotes = notifications.filter((n) => n.name === 'job_wait' && n.p.total === lines)
    expect(runNotes.length).toBeGreaterThan(0)
    const notified = runNotes.map((n) => n.p.progress)
    expect(notified).toEqual([...notified].sort((a, b) => a - b))
    expect(runNotes.some((n) => n.p.message?.startsWith('Tool change ') === true)).toBe(true)
    await client.close()
    // no CLI errors and no "unsaved changes kept for recovery" notice (logs go to the log file)
    expect(stderr.join('')).toBe('')
  })
})

describe('exit criteria: npm run check green in CI', () => {
  const root = resolve(import.meta.dirname, '../../..')
  it('CI runs npm run check, which runs these tests', () => {
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
    expect(ci).toMatch(/^\s*-\s*run:\s*npm ci\s*$/m)
    expect(ci).toMatch(/^\s*-\s*run:\s*npm run check\s*$/m)
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['check']).toMatch(/npm run typecheck && npm run lint && .*npm run test/)
    expect(pkg.scripts['test']).toBe('vitest run')
  })
})
