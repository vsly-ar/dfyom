// The bundled CLI, spawned with a temp --data-dir: one-shot save / --no-save, batch across lines,
// exit codes, tools, and stdout holding only results (no log lines).
// Spec: docs/architecture/llm-api.md#testing (CLI), #cli
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, inject, it } from 'vitest'
import { testStock } from '../../core/design/design.fixture'
import { tempDir } from '../host/host.fixture'

const t = tempDir('dfyom-cli-')
afterAll(() => t.cleanup())

interface Run {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

function cli(args: readonly string[], stdin = ''): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [inject('cliEntry'), ...args, '--data-dir', t.dir], {
      env: {
        ...process.env,
        DFYOM_TEST_WORKER_ENTRY: inject('productionWorkerEntry'),
        DFYOM_TEST_MACHINE_ENTRY: inject('machineEntry'),
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(stdin)
  })
}

/** One-shot that must succeed; stdout is exactly one JSON value. */
async function ok(args: readonly string[]): Promise<unknown> {
  const r = await cli(args)
  expect(r.code, r.stderr).toBe(0)
  return JSON.parse(r.stdout) as unknown
}

const file = join(t.dir, 'cli.dfyom')

describe('dfyom CLI', { timeout: 60_000 }, () => {
  let stock = ''
  let partId = ''

  it('tools lists names and summaries; tools <name> prints the full descriptor', async () => {
    const list = await cli(['tools'])
    expect(list.code).toBe(0)
    expect(list.stdout).toMatch(/^design\.pocket\.add +Add a pocket/m)
    const one = (await ok(['tools', 'design.pocket.add'])) as Record<string, unknown>
    expect(one).toMatchObject({
      name: 'design.pocket.add',
      mcpName: 'design_pocket_add',
      outputSchema: { type: 'object' },
    })
  })

  it('app-scope one-shot without a project (library is app data)', async () => {
    stock = (
      (await ok(['library.stock.add', JSON.stringify({ values: testStock() })])) as { id: string }
    ).id
    const listed = (await ok(['library.stock.list'])) as { items: { id: string }[] }
    expect(listed.items.map((i) => i.id)).toEqual([stock])
  })

  it('batch: one session across lines (revisions, undo/redo), saved as a new file', async () => {
    const lines = [
      {
        name: 'design.part.add',
        args: { name: 'Part', stockLibraryItemId: stock },
        expectedRevision: 0,
      },
      { name: 'design.part.list', args: {} },
      { name: 'nope.x.y', args: {} },
      'not json',
      { name: 'history.undo', args: {} },
      { name: 'history.redo', args: {} },
      { name: 'history.list', args: {} },
    ].map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
    const r = await cli(['batch', '--new', 'Batch', '--save-as', file], lines.join('\n'))
    const out = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(out.map((o) => o['ok'])).toEqual([true, true, false, false, true, true, true])
    expect(out[0]).toMatchObject({ revision: 1 })
    partId = (out[0]?.['value'] as { partId: string }).partId
    expect(out[2]).toMatchObject({ error: { code: 'command.unknown' }, retryable: false })
    expect(out[3]).toMatchObject({ error: { code: 'input.malformed' } })
    expect(out[5]).toMatchObject({ revision: 3 })
    expect((out[6]?.['value'] as { undo: unknown[] }).undo).toHaveLength(1)
    expect(r.code).toBe(2) // the first failing line's exit code
    expect(existsSync(file)).toBe(true)
  })

  it('one-shot on a project: saves on change, --no-save discards', async () => {
    const get = async () =>
      (
        (await ok(['design.part.get', JSON.stringify({ partId }), '--project', file])) as {
          part: { name: string }
        }
      ).part.name
    expect(await get()).toBe('Part')
    // opening is a read: the edit needs no query first; the change is saved
    await ok(['design.part.update', JSON.stringify({ partId, name: 'Kept' }), '--project', file])
    expect(await get()).toBe('Kept')
    await ok([
      'design.part.update',
      JSON.stringify({ partId, name: 'Dropped' }),
      '--project',
      file,
      '--no-save',
    ])
    expect(await get()).toBe('Kept')
    // --json prints the ResultWire; a stale --expected-revision is a retryable conflict (3)
    const stale = await cli([
      'design.part.update',
      JSON.stringify({ partId, name: 'X' }),
      '--project',
      file,
      '--expected-revision',
      '9999',
      '--json',
    ])
    expect(stale.code).toBe(3)
    expect(JSON.parse(stale.stdout)).toMatchObject({
      ok: false,
      error: { code: 'command.conflict' },
      retryable: true,
    })
    expect(await get()).toBe('Kept')
  })

  it('exit codes: usage and input 2, permission 4', async () => {
    expect((await cli([])).code).toBe(2)
    expect((await cli(['--bogus'])).code).toBe(2)
    expect((await cli(['nope.x.y'])).code).toBe(2)
    expect((await cli(['design.part.list', '{bad'])).code).toBe(2)
    const noProject = await cli(['design.part.list'])
    expect(noProject.code).toBe(2)
    expect(noProject.stderr).toContain('(noProject)')
    expect((await cli(['plan.toolpath.generate', '{}', '--no-wait'])).code).toBe(2)
    // --connect takes an instance id only if one follows; none is running here
    const connect = await cli(['project.list', '--connect'])
    expect(connect.code).toBe(2)
    expect(connect.stderr).toContain('no running DFYOM instance')
    const denied = await cli(['run.machine.unlock', '{}', '--project', file])
    expect(denied.code).toBe(4)
    expect(denied.stdout).toBe('')
  })

  it('stdout holds only results, never log lines (even at debug)', async () => {
    const r = await cli(['library.stock.list', '--log-level', 'debug'])
    expect(r.code).toBe(0)
    expect(() => JSON.parse(r.stdout) as unknown).not.toThrow()
    expect(r.stdout).not.toMatch(/"level":/)
  })

  it('dfyom mcp exits 0 at the end of stdin', async () => {
    const r = await cli(['mcp'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
  })
})
