// The headless agent flow through `dfyom mcp` (the bundled CLI, spawned by an SDK client over
// stdio): create a project, add design operations, plan, generate toolpaths, export GRBL gCode,
// run it on the virtual machine through its tool changes, save, close and reopen.
// Spec: docs/architecture/llm-api.md#testing (the 3.11 end-to-end test builds on this one)
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, describe, expect, inject, it } from 'vitest'
import { machineValues } from '../../core/library/library.fixture'
import { bull6, drill6, flat4, flat6 } from '../../core/plan/plan.fixture'
import { testStock } from '../../core/design/design.fixture'

const dir = mkdtempSync(join(tmpdir(), 'dfyom-mcp-flow-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

interface ToolResult {
  isError?: boolean
  structuredContent?: { value?: unknown; revision?: number; error?: { code: string } }
  content: { type: string; text: string }[]
}

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [inject('cliEntry'), 'mcp', '--data-dir', dir, '--log-level', 'warn'],
    env: {
      ...(process.env as Record<string, string>),
      DFYOM_TEST_WORKER_ENTRY: inject('productionWorkerEntry'),
      DFYOM_TEST_MACHINE_ENTRY: inject('machineEntry'),
    },
    stderr: 'pipe',
  })
  const stderr: string[] = []
  transport.stderr?.on('data', (d: Buffer) => stderr.push(d.toString()))
  const client = new Client({ name: 'mcp-flow-test', version: '1.0.0' })
  await client.connect(transport)
  /** Calls a tool that must succeed; returns `{ value, revision }`. */
  const ok = async <T = unknown>(name: string, args: object = {}) => {
    const r = (await client.callTool(
      { name, arguments: args as Record<string, unknown> },
      undefined,
      {
        timeout: 120_000,
      },
    )) as ToolResult
    expect(r.isError, `${name}: ${r.content[0]?.text ?? ''}\n${stderr.join('')}`).toBe(false)
    return r.structuredContent as { value: T; revision: number }
  }
  return { client, transport, ok, stderr }
}

/** Waits for a job; continues tool changes and program pauses of a run job on the way. */
async function waitJob(
  ok: Awaited<ReturnType<typeof connect>>['ok'],
  jobId: string,
  onWait?: (phase: string) => Promise<void>,
) {
  for (;;) {
    const { value } = await ok<{ state: string; outcome?: { ok: boolean; value?: unknown } }>(
      'job_wait',
      { jobId, timeoutSeconds: onWait === undefined ? 120 : 1 },
    )
    if (value.state === 'finished') return value.outcome
    if (onWait !== undefined) {
      const st = (await ok<{ job?: { phase: string } }>('run_status_get')).value
      if (st.job !== undefined) await onWait(st.job.phase)
    }
  }
}

describe('dfyom mcp (headless, stdio)', { timeout: 180_000 }, () => {
  it('runs the whole flow: create → design → plan → toolpaths → export → virtual run → save', async () => {
    const { client, ok } = await connect()
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

    // Library (app scope, no project needed)
    const stock = (await ok<{ id: string }>('library_stock_add', { values: testStock() })).value.id
    for (const t of [flat6(), flat4(), bull6(), drill6()])
      await ok('library_tool_add', { values: t })
    const { kind: _k, ...m } = machineValues()
    const machine = (await ok<{ id: string }>('library_machine_add', { values: m })).value.id

    // Project and design (the geometry test part); the create result's revision is the baseline
    const created = await ok<{ key: string; revision: number }>('project_create', {
      name: 'Bracket',
      unitSystem: 'mm',
    })
    const { partId } = (
      await ok<{ partId: string }>('design_part_add', {
        name: 'Bracket',
        stockLibraryItemId: stock,
        expectedRevision: created.value.revision,
      })
    ).value
    await ok('design_facing_add', { partId, depth: '0.5' })
    await ok('design_pocket_add', {
      partId,
      shape: {
        kind: 'rectangle',
        center: ['50', '30'],
        length: '40',
        width: '25',
        cornerRadius: '4',
      },
      depth: '8',
      floorRadius: '2',
    })
    for (const [x, y, extra] of [
      ['15', '15', {}],
      ['85', '15', { bottom: 'flat', depth: '12' }],
      ['15', '45', { bottom: 'drillPoint', depth: '12' }],
      ['85', '45', { bottom: 'drillPoint', depth: '12', pointAngle: '118' }],
    ] as const)
      await ok('design_drilling_add', { partId, center: [x, y], diameter: '6', ...extra })
    await ok('design_profile_add', {
      partId,
      shape: {
        kind: 'rectangle',
        center: ['50', '30'],
        length: '84',
        width: '44',
        cornerRadius: '5',
      },
      slotWidth: '6',
      tabs: { count: '4', width: '8', thickness: '3' },
    })
    const evaluated = await ok<{ jobId: string }>('design_part_evaluate', { partId })
    expect(await waitJob(ok, evaluated.value.jobId)).toMatchObject({
      ok: true,
      value: { evaluation: 'done' },
    })

    // Plan; the drilling tool has no preset: give its operations cutting values
    const { planId } = (
      await ok<{ planId: string }>('plan_create', { partId, machineLibraryItemId: machine })
    ).value
    const { plan } = (
      await ok<{ plan: { setups: { operations: { id: string; tool: string }[] }[] } }>('plan_get', {
        planId,
      })
    ).value
    const ops = plan.setups[0]!.operations
    for (const op of ops.filter((o) => o.tool === ops[1]!.tool))
      await ok('plan_operation_update', {
        planId,
        planOperationId: op.id,
        overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
      })

    // Toolpaths (a job; job_wait reports its outcome)
    const gen = await ok<{ jobId: string }>('plan_toolpath_generate', { planId })
    const generated = (await waitJob(ok, gen.value.jobId)) as {
      ok: boolean
      value: { operations: { status: string }[] }
    }
    expect(generated.ok).toBe(true)
    expect(generated.value.operations.every((o) => o.status === 'generated')).toBe(true)

    // Virtual machine (deny by default: an agent may open only the virtual one), export at its G54
    await ok('run_connection_open', { target: 'virtual', planId, timeScale: 'max', prepare: true })
    const gcode = join(dir, 'bracket.nc')
    const exported = await ok<{ softLimitChecked: boolean }>('plan_export', {
      planId,
      target: gcode,
    })
    expect(exported.value.softLimitChecked).toBe(true)
    expect(readFileSync(gcode, 'utf8')).toMatch(/G21/)

    // Run through every tool change and spindle pause
    const run = await ok<{ jobId: string }>('run_job_start', { planId })
    const waits: string[] = []
    const ended = (await waitJob(ok, run.value.jobId, async (phase) => {
      if (phase !== 'toolChange' && phase !== 'programPause') return
      const st = (
        await ok<{ job: { phase: string; toolChange?: { n: number }; pause?: number } }>(
          'run_status_get',
        )
      ).value.job
      waits.push(st.phase)
      await ok('run_job_continue', {
        jobId: run.value.jobId,
        ...(st.phase === 'toolChange' ? { toolChange: st.toolChange!.n } : { pause: st.pause }),
      })
    })) as { ok: boolean; value: { toolChanges: number; lines: number } }
    expect(ended.ok).toBe(true)
    expect(ended.value.toolChanges).toBeGreaterThan(0)
    expect(waits.filter((w) => w === 'toolChange')).toHaveLength(ended.value.toolChanges)
    await ok('run_connection_close')

    // Save, close, reopen and compare
    const file = join(dir, 'bracket.dfyom')
    await ok('project_save', { target: file })
    const before = (await ok('design_part_get', { partId })).value
    await ok('project_close', { key: created.value.key })
    expect(
      ((await client.callTool({ name: 'design_part_list', arguments: {} })) as ToolResult).isError,
    ).toBe(true)
    const reopened = await ok<{ key: string; alreadyOpen: boolean }>('project_open', { file })
    expect(reopened.value.alreadyOpen).toBe(false)
    expect((await ok('design_part_get', { partId })).value).toEqual(before)
    expect(existsSync(file)).toBe(true)
    await client.close()
  })
})
