// Two instances on one data dir: one owner per project, the connect hint, same-instance re-open,
// and the `dfyom mcp --connect` bridge reaching the owner's dispatcher.
// Spec: docs/architecture/llm-api.md#testing (Coexistence), #coexistence-with-a-running-gui
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, describe, expect, inject, it } from 'vitest'
import { uiSource } from '../../core/commands/testing'
import { noopLogger } from '../../shared/logging'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { startMcpHttp } from '../mcp/http'
import { INITIALIZE, INITIALIZED, spawnCli, toolCall } from '../cli/cli.fixture'
import { tempDir, testHost } from './host.fixture'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function twoHosts() {
  const t = tempDir()
  cleanups.push(t.cleanup)
  const a = await testHost(t.dir, { instanceId: 'aaaaaaaa-0001' })
  const b = await testHost(t.dir, { instanceId: 'bbbbbbbb-0002' })
  cleanups.push(
    () => a.shutdown(),
    () => b.shutdown(),
  )
  const sa = a.openSession({ kind: 'agent', id: 'stdio-1' })
  const created = expectOk(
    (await sa.call('project.create', { name: 'Shared', unitSystem: 'mm' })).result,
  )
  const { key } = created.value as { key: string }
  const file = join(t.dir, 'shared.dfyom')
  expectOk((await sa.call('project.save', { target: file })).result)
  return { dir: t.dir, a, b, sa, key, file }
}

describe('coexistence', { timeout: 60_000 }, () => {
  it('a second instance gets persist.locked with the holder; with HTTP also the connect hint', async () => {
    const { a, b, file } = await twoHosts()
    const sb = b.openSession({ kind: 'agent', id: 'stdio-1' })
    let e = expectErrCode((await sb.call('project.open', { file })).result, 'persist.locked')
    const hint = (err: typeof e) => err.frames.find((f) => f.where === 'project.open')?.data
    expect(hint(e)).toEqual({ holder: a.instanceId })
    const http = expectOk(await startMcpHttp({ host: a, appVersion: '0', log: noopLogger }))
    cleanups.push(() => http.stop())
    e = expectErrCode((await sb.call('project.open', { file })).result, 'persist.locked')
    expect(hint(e)).toEqual({
      holder: a.instanceId,
      connect: `dfyom mcp --connect ${a.instanceId}`,
    })
  })

  it('re-opening a file open in this instance returns its key (alreadyOpen)', async () => {
    const { a, key, file } = await twoHosts()
    const other = a.openSession({ kind: 'agent', id: 'http-9' })
    const r = expectOk((await other.call('project.open', { file })).result)
    expect(r.value).toEqual({ key, revision: expect.any(Number), alreadyOpen: true })
    expect(other.boundKey).toBe(key)
    expect(a.list().map((p) => [p.key, p.sources.map((s) => s.source)])).toEqual([
      [key, ['agent:stdio-1', 'agent:http-9']],
    ])
    // someone else's open project is not a read: no undo of their step without a query
    expectErrCode((await other.call('history.undo', {})).result, 'command.conflict')
  })

  it('dfyom mcp --connect bridges stdio to the owner instance (same dispatcher)', async () => {
    const { dir, a, key } = await twoHosts()
    const http = expectOk(await startMcpHttp({ host: a, appVersion: '0', log: noopLogger }))
    cleanups.push(() => http.stop())
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [inject('cliEntry'), 'mcp', '--connect', a.instanceId, '--data-dir', dir],
      env: {
        ...(process.env as Record<string, string>),
        DFYOM_TEST_WORKER_ENTRY: inject('productionWorkerEntry'),
        DFYOM_TEST_MACHINE_ENTRY: inject('machineEntry'),
      },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'bridged', version: '1' })
    await client.connect(transport)
    cleanups.push(() => client.close())
    const listed = (await client.callTool({ name: 'project_list', arguments: {} })) as unknown as {
      structuredContent: { value: { projects: { key: string }[] } }
    }
    expect(listed.structuredContent.value.projects.map((p) => p.key)).toEqual([key])
    await client.callTool({ name: 'project_bind', arguments: { key } })
    // the user edits in the owner; the bridged agent sees it in its digest
    const d = a.project(key).unwrap()
    expectOk(await d.dispatch('history.undo', {}, uiSource('win-1')))
    const r = (await client.callTool({ name: 'history_list', arguments: {} })) as unknown as {
      isError: boolean
      content: { text: string }[]
    }
    expect(r.isError).toBe(false)
    expect(r.content.at(-1)?.text).toContain('1 action by ui:win-1 (history.undo)')
    expect(
      a.sessions().some((s) => s.source.id.startsWith('http-') && s.client === 'bridged'),
    ).toBe(true)
  })

  it('a --connect one-shot on a project open in the GUI conflicts until the agent reads', async () => {
    const { dir, a, file, key } = await twoHosts()
    const http = expectOk(await startMcpHttp({ host: a, appVersion: '0', log: noopLogger }))
    cleanups.push(() => http.stop())
    const p = spawnCli(['history.undo', '--connect', a.instanceId, '--project', file], dir)
    p.end()
    const r = await p.exited
    expect(r.code).toBe(3)
    expect(r.stderr).toMatch(/^command\.conflict: /m)
    expect(a.list().map((p) => p.key)).toEqual([key]) // left open in the owner
  })

  it('the bridge drains answers in flight when stdin ends', async () => {
    const { dir, a } = await twoHosts()
    const http = expectOk(await startMcpHttp({ host: a, appVersion: '0', log: noopLogger }))
    cleanups.push(() => http.stop())
    const p = spawnCli(['mcp', '--connect', a.instanceId], dir)
    p.send(INITIALIZE)
    expect((await p.next())['id']).toBe(1)
    p.send(INITIALIZED)
    p.send(toolCall(2, 'project_list'))
    p.end()
    expect(await p.next()).toMatchObject({ id: 2, result: { isError: false } })
    expect((await p.exited).code).toBe(0)
    await expect.poll(() => http.sessionCount()).toBe(0) // the HTTP session was ended
  })

  it('the bridge answers pending requests with an error when the instance goes away (exit 6)', async () => {
    const { dir, a } = await twoHosts()
    const http = expectOk(await startMcpHttp({ host: a, appVersion: '0', log: noopLogger }))
    const p = spawnCli(['mcp', '--connect', a.instanceId], dir)
    p.send(INITIALIZE)
    expect((await p.next())['id']).toBe(1)
    p.send(INITIALIZED)
    await http.stop()
    p.send(toolCall(2, 'project_list'))
    expect(await p.next()).toMatchObject({ id: 2, error: { code: -32603 } })
    p.end()
    const exit = await p.exited
    expect(exit.code).toBe(6)
    expect(exit.stderr).toContain('external.failure')
  })

  it('a --connect one-shot maps a lost instance to external.failure (exit 6)', async () => {
    const { dir, a } = await twoHosts()
    const http = expectOk(await startMcpHttp({ host: a, appVersion: '0', log: noopLogger }))
    // the discovery file still names the instance, but nothing listens any more
    const rec = readFileSync(http.discoveryFile, 'utf8')
    await http.stop()
    writeFileSync(http.discoveryFile, rec, { mode: 0o600 })
    const p = spawnCli(['project.list', '--connect', a.instanceId], dir)
    p.end()
    const r = await p.exited
    expect(r.code).toBe(6)
    expect(r.stderr).toMatch(/^external\.failure: /m)
  })
})
