// The v0.1 exit criteria headless, through MCP: an SDK client spawns `dfyom mcp` (the bundled
// CLI, temp data dir) over stdio and runs the exit-criteria flow (exit-criteria.fixture.ts):
// create → design → plan → toolpaths → export (golden gCode) → virtual run at `max` with tool
// changes and progress → save → close → reopen; and the v0.2 flow (exit-criteria.v02.fixture.ts:
// reference, three faces, a program per setup run in turn); and the v0.3 flow
// (exit-criteria.v03.fixture.ts: SVG shapes, Shape Editor commands, shape operations, two setups,
// the deviation check); and the v0.4 flow (exit-criteria.v04.fixture.ts: the enclosure lid with
// holes, Clones and countersink chamfers); and the alignment phase 1 flow
// (exit-criteria.alignment.fixture.ts, DF78); and the split parts 4a flow
// (exit-criteria.split.fixture.ts, DF91). Also checks the CI criterion.
// Spec: docs/plans/v0.1.md#exit-criteria, docs/plans/v0.2.md#exit-criteria,
// docs/plans/v0.3.md#exit-criteria, docs/plans/v0.4.md#exit-criteria,
// docs/architecture/llm-api.md#testing,
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
import { exitCriteriaV02Flow } from './exit-criteria.v02.fixture'
import { exitCriteriaV03Flow } from './exit-criteria.v03.fixture'
import { CALL_BUDGET, exitCriteriaV04Flow } from './exit-criteria.v04.fixture'
import { exitCriteriaAlignmentFlow } from './exit-criteria.alignment.fixture'
import { exitCriteriaSplitFlow } from './exit-criteria.split.fixture'

const dir = mkdtempSync(join(tmpdir(), 'dfyom-e2e-mcp-'))
// the v0.2 flow in its own data dir: a fresh library, so its auto tool choice sees only its tools
const dirV02 = mkdtempSync(join(tmpdir(), 'dfyom-e2e-mcp-v02-'))
const dirV03 = mkdtempSync(join(tmpdir(), 'dfyom-e2e-mcp-v03-'))
const dirV04 = mkdtempSync(join(tmpdir(), 'dfyom-e2e-mcp-v04-'))
const dirAlign = mkdtempSync(join(tmpdir(), 'dfyom-e2e-mcp-align-'))
const dirSplit = mkdtempSync(join(tmpdir(), 'dfyom-e2e-mcp-split-'))
afterAll(() => {
  rmSync(dirAlign, { recursive: true, force: true })
  rmSync(dirSplit, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
  rmSync(dirV02, { recursive: true, force: true })
  rmSync(dirV03, { recursive: true, force: true })
  rmSync(dirV04, { recursive: true, force: true })
})

interface ToolResult {
  isError?: boolean
  structuredContent?: { value?: unknown; revision?: number; error?: { code: string } }
  content: { type: string; text: string }[]
}

/** An MCP SDK client of a spawned `dfyom mcp` (temp data dir), with its stderr and progress. */
async function connect(dataDir: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [inject('cliEntry'), 'mcp', '--data-dir', dataDir],
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
  return { client, call, stderr, notifications }
}

describe('exit criteria headless: dfyom mcp (stdio)', { timeout: 180_000 }, () => {
  it('runs the v0.1 flow through MCP tools, with progress notifications', async () => {
    const { client, call, stderr, notifications } = await connect(dir)

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

  it('runs the v0.2 flow (reference, three faces, a program per setup) through MCP tools', async () => {
    const { client, call, stderr } = await connect(dirV02)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'design_reference_import',
        'design_reference_list',
        'design_tool_candidates',
        'plan_design_operation_update',
      ]),
    )
    await exitCriteriaV02Flow(call, dirV02)
    await client.close()
    expect(stderr.join('')).toBe('')
  })

  it('runs the v0.3 flow (SVG shapes, Shape Editor, shape operations, two setups) through MCP tools', async () => {
    const { client, call, stderr } = await connect(dirV03)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'design_shape_import',
        'design_shape_add',
        'design_shape_item_update',
        'design_shape_get',
      ]),
    )
    await exitCriteriaV03Flow(call, dirV03)
    await client.close()
    expect(stderr.join('')).toBe('')
  })
})

describe('exit criteria headless: dfyom mcp, v0.4', { timeout: 180_000 }, () => {
  it('runs the v0.4 flow (holes, Clones, chamfers, the lid) through MCP tools', async () => {
    const { client, call, stderr } = await connect(dirV04)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'design_fastener_list',
        'design_hole_add',
        'design_hole_update',
        'design_clones_preview',
        'design_clones_add',
        'design_clones_update',
        'design_feature_list',
      ]),
    )
    // the same golden program as the batch run (exit-criteria.v04.fixture.ts): byte-equal
    const { stats } = await exitCriteriaV04Flow(call, dirV04)
    await client.close()
    expect(stderr.join('')).toBe('')
    expect(stats.calls - stats.polls).toBeLessThanOrEqual(CALL_BUDGET.calls)
    expect(stats.largest.bytes, stats.largest.name).toBeLessThanOrEqual(CALL_BUDGET.resultBytes)
  })
})

// hardening DF78: docs/modes/alignment.md#implementation-slice-2
describe('exit criteria headless: dfyom mcp, alignment phase 1', { timeout: 180_000 }, () => {
  it('cuts aids in the Top, aligns the flipped Bottom on them and runs both setups', async () => {
    const { client, call, stderr } = await connect(dirAlign)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['plan_aid_set', 'plan_alignment_set', 'run_align_goto']),
    )
    await exitCriteriaAlignmentFlow(call, dirAlign)
    await client.close()
    expect(stderr.join('')).toBe('')
  })
})

// hardening DF91: docs/modes/split-parts.md#implementation-4a, #implementation-4b (dowels, keys), #implementation-4c (split to fit), #implementation-4d (fingers), #implementation-4e (shape lines)
describe('exit criteria headless: dfyom mcp, split parts 4a', { timeout: 300_000 }, () => {
  it('splits the enclosure by a level, the level and two lines, the level with dowels, the 600 × 400 panel with a puzzle key and its Test fit coupon, the enclosure split to fit a library board, a shelf longer than the travel with a finger joint, a round table top split by a curved line with keys; every piece runs', async () => {
    const { client, call, stderr } = await connect(dirSplit)
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('design_split_set')
    const r = await exitCriteriaSplitFlow(call, dirSplit)
    await client.close()
    expect(stderr.join('')).toBe('')
    expect(r.pieces).toBe(30)
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
