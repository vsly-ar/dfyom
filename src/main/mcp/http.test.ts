// Local HTTP on a real loopback server: token, Host/Origin checks, sessions, discovery file,
// on by default and the setting.
// Spec: docs/architecture/llm-api.md#testing (HTTP), #local-http
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { request } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterEach, describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { noopLogger } from '../../shared/logging'
import type { AppHost } from '../host/app-host'
import { InstanceRecordSchema, listInstances } from '../host/discovery'
import { tempDir, testHost } from '../host/host.fixture'
import { connectTransport } from './bridge'
import {
  createLocalHttpControl,
  IDLE_MS,
  LOOPBACK,
  MAX_BODY_BYTES,
  MAX_SESSIONS,
  localHttpSetting,
  startMcpHttp,
  type McpHttpServer,
} from './http'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function setup(
  o: { now?: () => number } = {},
): Promise<{ host: AppHost; server: McpHttpServer; dir: string }> {
  const t = tempDir()
  cleanups.push(t.cleanup)
  const host = await testHost(t.dir)
  cleanups.push(() => host.shutdown())
  const server = expectOk(
    await startMcpHttp({
      host,
      appVersion: '0.0.0',
      log: noopLogger,
      ...(o.now === undefined ? {} : { now: o.now }),
    }),
  )
  cleanups.push(() => server.stop())
  return { host, server, dir: t.dir }
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw', version: '1' },
  },
}

/** A raw POST with full control of the headers (fetch cannot set Host). */
function post(
  port: number,
  headers: Record<string, string>,
  body: unknown = INIT,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = request(
      {
        host: LOOPBACK,
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('error', reject)
    req.end(data)
  })
}

async function client(server: McpHttpServer, host: AppHost, name: string) {
  const c = new Client({ name, version: '1.0.0' })
  const transport = connectTransport({
    instanceId: host.instanceId,
    pid: process.pid,
    port: server.port,
    token: server.token,
    startedAt: '',
    appVersion: '',
  })
  await c.connect(transport)
  cleanups.push(() => c.close())
  return { c, transport }
}

describe('local HTTP', () => {
  it('listens on 127.0.0.1 only and needs the bearer token (401)', async () => {
    const { server } = await setup()
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/mcp`)
    const host = `127.0.0.1:${server.port}`
    expect(await post(server.port, { host })).toBe(401)
    expect(await post(server.port, { host, authorization: 'Bearer wrong' })).toBe(401)
    expect(await post(server.port, { host, authorization: server.token })).toBe(401)
    expect(await post(server.port, { host, authorization: `Bearer ${server.token}` })).toBe(200)
  })

  it('rejects a foreign Host and any Origin (DNS rebinding, browsers): 403', async () => {
    const { server } = await setup()
    const auth = { authorization: `Bearer ${server.token}` }
    expect(await post(server.port, { ...auth, host: `evil.example:${server.port}` })).toBe(403)
    expect(await post(server.port, { ...auth, host: `127.0.0.1:${server.port + 1}` })).toBe(403)
    expect(
      await post(server.port, {
        ...auth,
        host: `127.0.0.1:${server.port}`,
        origin: 'http://127.0.0.1',
      }),
    ).toBe(403)
    expect(await post(server.port, { ...auth, host: `localhost:${server.port}` })).toBe(200)
  })

  it('two sessions are two sources; ending one unbinds it', async () => {
    const { host, server } = await setup()
    const a = await client(server, host, 'agent-a')
    const b = await client(server, host, 'agent-b')
    await a.c.callTool({ name: 'project_list', arguments: {} })
    await b.c.callTool({ name: 'project_list', arguments: {} })
    expect(host.sessions().map((s) => [s.source.id, s.client])).toEqual([
      ['http-1', 'agent-a'],
      ['http-2', 'agent-b'],
    ])
    expect(server.sessionCount()).toBe(2)
    await a.transport.terminateSession()
    await expect.poll(() => host.sessions().map((s) => s.source.id)).toEqual(['http-2'])
  })

  it('writes an owner-only discovery file and deletes it on stop', async () => {
    const { host, server, dir } = await setup()
    const rec = InstanceRecordSchema.parse(JSON.parse(readFileSync(server.discoveryFile, 'utf8')))
    expect(rec).toMatchObject({
      instanceId: host.instanceId,
      pid: process.pid,
      port: server.port,
      token: server.token,
    })
    if (process.platform !== 'win32')
      expect(statSync(server.discoveryFile).mode & 0o777).toBe(0o600)
    expect((await listInstances(dir)).map((r) => r.instanceId)).toEqual([host.instanceId])
    await server.stop()
    expect(existsSync(server.discoveryFile)).toBe(false)
  })

  it('ignores and removes stale discovery files (dead PID)', async () => {
    const { host, dir } = await setup()
    expect((await listInstances(dir, () => false)).map((r) => r.instanceId)).toEqual([])
    expect(await listInstances(dir)).toEqual([])
    expect(host.instanceId).toBeTruthy()
  })

  it('is on by default; --mcp-http=off|<port> overrides the setting for one run', () => {
    expect(localHttpSetting([])).toEqual({ enabled: true })
    expect(localHttpSetting([], false)).toEqual({ enabled: false })
    expect(localHttpSetting(['--mcp-http=off'])).toEqual({ enabled: false })
    expect(localHttpSetting(['--mcp-http', '4321'], false)).toEqual({ enabled: true, port: 4321 })
    expect(localHttpSetting(['--mcp-http'], false)).toEqual({ enabled: true })
  })

  it('turning the setting off stops the server, ends the sessions and deletes the file', async () => {
    const t = tempDir()
    cleanups.push(t.cleanup)
    const host = await testHost(t.dir)
    cleanups.push(() => host.shutdown())
    const control = createLocalHttpControl({ host, appVersion: '0.0.0', log: noopLogger })
    cleanups.push(async () => void (await control.setEnabled(false)))
    expectOk(await control.setEnabled(true))
    const server = control.server!
    const { c } = await client(server, host, 'agent')
    await c.callTool({ name: 'project_list', arguments: {} })
    expect(host.sessions()).toHaveLength(1)
    expectOk(await control.setEnabled(false))
    expect(control.server).toBeUndefined()
    expect(existsSync(server.discoveryFile)).toBe(false)
    expect(host.sessions()).toEqual([])
    await expect(post(server.port, { host: `127.0.0.1:${server.port}` })).rejects.toThrow()
    // on again: a new token
    expectOk(await control.setEnabled(true))
    expect(control.server!.token).not.toBe(server.token)
  })

  it('refuses bodies over 4 MB (413) and closes that connection; the server stays usable', async () => {
    const { server } = await setup()
    const ok = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${server.token}` }
    expect(await post(server.port, ok, { pad: ' '.repeat(MAX_BODY_BYTES) })).toBe(413)
    expect(await post(server.port, ok)).toBe(200)
  })

  it('a rejected initialize (406: no event-stream accept) leaves no session behind', async () => {
    const { host, server } = await setup()
    const headers = {
      host: `127.0.0.1:${server.port}`,
      authorization: `Bearer ${server.token}`,
      accept: 'application/json',
    }
    for (let i = 0; i < 3; i++) expect(await post(server.port, headers)).toBe(406)
    expect(host.sessions()).toEqual([])
    expect(server.sessionCount()).toBe(0)
  })

  it(`allows at most ${MAX_SESSIONS} sessions, also under concurrent initializes (503)`, async () => {
    const { host, server } = await setup()
    const ok = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${server.token}` }
    const codes = await Promise.all(
      Array.from({ length: MAX_SESSIONS + 8 }, () => post(server.port, ok)),
    )
    expect(codes.filter((c) => c === 200)).toHaveLength(MAX_SESSIONS)
    expect(codes.filter((c) => c === 503)).toHaveLength(8)
    expect(server.sessionCount()).toBe(MAX_SESSIONS)
    expect(host.sessions()).toHaveLength(MAX_SESSIONS)
  })

  it('ends sessions idle for 30 minutes', async () => {
    let t = 0
    const { host, server } = await setup({ now: () => t })
    const ok = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${server.token}` }
    expect(await post(server.port, ok)).toBe(200)
    t = IDLE_MS - 1
    server.sweepIdle()
    expect(server.sessionCount()).toBe(1)
    t = IDLE_MS + 1
    server.sweepIdle()
    await expect.poll(() => server.sessionCount()).toBe(0)
    await expect.poll(() => host.sessions()).toEqual([])
  })

  it('refuses an instances folder other users can read', async () => {
    if (process.platform === 'win32') return
    const t = tempDir()
    cleanups.push(t.cleanup)
    mkdirSync(join(t.dir, 'instances'), { mode: 0o755 })
    chmodSync(join(t.dir, 'instances'), 0o755)
    const host = await testHost(t.dir)
    cleanups.push(() => host.shutdown())
    const r = await startMcpHttp({ host, appVersion: '0', log: noopLogger })
    expect(expectErrCode(r, 'persist.io').message).toContain('accessible by other users')
  })
})
