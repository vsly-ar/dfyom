// MCP server over the SDK's in-memory transport: list, call, errors, progress, resources.
// Spec: docs/architecture/llm-api.md#testing (MCP server)
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'
import { filterAreas, toMcpName } from '../../core/agent/tools'
import { PRIMER } from '../../core/agent/primer'
import { uiSource } from '../../core/commands/testing'
import { noopLogger } from '../../shared/logging'
import type { AppHost } from '../host/app-host'
import { buildSmallPlan, tempDir, testHost } from '../host/host.fixture'
import { createMcpServer } from './server'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

interface Result {
  isError?: boolean
  structuredContent?: { value?: unknown; error?: { code: string; issues: { rule: string }[] } }
  content: { text: string }[]
  _meta?: Record<string, unknown>
}

async function connect(o: { areas?: string[]; host?: AppHost } = {}) {
  const t = tempDir()
  cleanups.push(t.cleanup)
  const host = o.host ?? (await testHost(t.dir))
  cleanups.push(() => host.shutdown())
  const session = host.openSession({ kind: 'agent', id: host.nextSourceId('stdio') })
  const server = createMcpServer({
    host,
    session,
    listed: filterAreas(host.tools, o.areas),
    version: '0.0.0',
    log: noopLogger,
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientSide)
  cleanups.push(() => client.close())
  const raw = async (name: string, args: object = {}) =>
    (await client.callTool({
      name: toMcpName(name),
      arguments: args as Record<string, unknown>,
    })) as Result
  const call = async (name: string, args: object = {}) => {
    const r = await raw(name, args)
    expect(r.isError, `${name}: ${r.content[0]?.text}`).toBe(false)
    return r.structuredContent?.value
  }
  return { host, session, client, raw, call }
}

describe('MCP server', () => {
  it('lists every tool (no output schemas), names the session in the GUI and sends the primer', async () => {
    const { host, client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(host.tools.map((t) => t.mcpName))
    expect(
      tools.every((t) => t.outputSchema === undefined && t.inputSchema.type === 'object'),
    ).toBe(true)
    expect(client.getInstructions()).toBe(PRIMER)
    expect(host.sessions()).toEqual([
      { source: { kind: 'agent', id: 'stdio-1' }, client: 'test-client' },
    ])
  })

  it('--areas restricts the list; every tool stays callable', async () => {
    const { client, call } = await connect({ areas: ['plan'] })
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('plan_create')
    expect(names).toContain('job_wait')
    expect(names).not.toContain('library_tool_add')
    expect(await call('library.tool.list')).toMatchObject({ items: [] })
  })

  it('returns AppErrors as tool results and unknown tools as protocol errors', async () => {
    const { raw, client } = await connect()
    const r = await raw('design.part.list')
    expect(r.isError).toBe(true)
    expect(r.structuredContent?.error?.issues[0]?.rule).toBe('noProject')
    expect(r.content[0]?.text).toMatch(/^input\.malformed: /)
    await expect(client.callTool({ name: 'nope_x_y', arguments: {} })).rejects.toThrow(
      /unknown tool/,
    )
  })

  it('sends progress notifications for job_wait and reports the finished job in the digest', async () => {
    const { call, client } = await connect()
    const { planId } = await buildSmallPlan(call)
    const { jobId } = (await call('plan.toolpath.generate', { planId })) as { jobId: string }
    const ticks: { progress: number; total?: number | undefined }[] = []
    const r = (await client.callTool({ name: 'job_wait', arguments: { jobId } }, undefined, {
      onprogress: (p) => ticks.push(p),
    })) as Result
    expect(r.structuredContent?.value).toMatchObject({ state: 'finished', outcome: { ok: true } })
    expect(ticks.length).toBeGreaterThan(0)
    expect(ticks.at(-1)).toMatchObject({ progress: 2, total: 2 })
    expect(r.content.at(-1)?.text).toContain('plan.toolpath.generate finished')
    expect(r._meta?.['dfyom/actions']).toMatchObject({ count: 1 })
  })

  it('serves the action log as a subscribable resource and the schemas', async () => {
    const { host, client, call } = await connect()
    const { key } = (await call('project.create', { name: 'P', unitSystem: 'mm' })) as {
      key: string
    }
    const uri = `dfyom://project/${key}/log`
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual([
      'dfyom://run/status',
      uri,
    ])
    const updated: string[] = []
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updated.push(n.params.uri)
    })
    await client.subscribeResource({ uri })
    const d = host.project(key).unwrap()
    await d.dispatch('library.stock.list', {}, uiSource()) // unknown here: still logged
    await d.dispatch('history.undo', {}, uiSource())
    await expect.poll(() => updated, { timeout: 5000 }).toEqual([uri])
    const read = await client.readResource({ uri: `${uri}?after=1` })
    const log = JSON.parse((read.contents[0] as { text: string }).text) as {
      events: { seq: number }[]
    }
    expect(log.events.map((e) => e.seq)).toEqual([2])
    const schema = await client.readResource({ uri: 'dfyom://schema/design_pocket_add' })
    const descriptor = JSON.parse((schema.contents[0] as { text: string }).text) as Record<
      string,
      unknown
    >
    expect(descriptor).toMatchObject({
      name: 'design.pocket.add',
      outputSchema: { type: 'object' },
    })
  })
})
