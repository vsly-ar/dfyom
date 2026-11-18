/**
 * `dfyom mcp --connect [instance]`: a stdio MCP server that forwards every message to the local
 * HTTP endpoint of a running instance, so stdio-only clients attach to the app the user has open.
 * The HTTP session is the source (`agent:http-<n>`).
 * Doc: docs/architecture/llm-api.md#coexistence-with-a-running-gui
 */
import type { Readable, Writable } from 'node:stream'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Logger } from '../../shared/logging'
import type { InstanceRecord } from '../host/discovery'
import { LOOPBACK, MCP_PATH } from './http'

export function instanceUrl(rec: InstanceRecord): URL {
  return new URL(`http://${LOOPBACK}:${rec.port}${MCP_PATH}`)
}

/** HTTP client transport to an instance, with its bearer token. */
export function connectTransport(rec: InstanceRecord): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(instanceUrl(rec), {
    requestInit: { headers: { Authorization: `Bearer ${rec.token}` } },
  })
}

/** Longest wait for answers still in flight when stdin ends. */
export const BRIDGE_DRAIN_MS = 30_000

type Id = string | number

const requestId = (m: JSONRPCMessage): Id | undefined =>
  'method' in m && 'id' in m ? (m.id as Id) : undefined
const responseId = (m: JSONRPCMessage): Id | undefined =>
  !('method' in m) && 'id' in m ? (m.id as Id) : undefined

/**
 * Runs until stdin ends (then waits for the answers in flight, bounded) or the instance goes
 * away; then ends the HTTP session. Resolves `true` after a clean end, `false` if the instance
 * failed (pending requests are answered with a JSON-RPC error).
 */
export async function runBridge(o: {
  readonly instance: InstanceRecord
  readonly stdin: Readable
  readonly stdout: Writable
  readonly log: Logger
  readonly drainMs?: number
}): Promise<boolean> {
  const log = o.log.child({ scope: 'mcp.bridge', instance: o.instance.instanceId })
  const http = connectTransport(o.instance)
  const stdio = new StdioServerTransport(o.stdin, o.stdout)
  const pending = new Set<Id>()
  let drained: (() => void) | undefined
  let failed = false
  let closing = false
  const answerPending = (message: string) => {
    for (const id of pending)
      void stdio
        .send({ jsonrpc: '2.0', id, error: { code: -32603, message } })
        .catch(() => undefined)
    pending.clear()
  }
  const done = new Promise<void>((resolve) => {
    const close = (ok: boolean) => {
      if (closing) return
      closing = true
      failed ||= !ok
      void (async () => {
        if (ok && pending.size > 0)
          await new Promise<void>((r) => {
            drained = r
            setTimeout(r, o.drainMs ?? BRIDGE_DRAIN_MS).unref()
          })
        if (pending.size > 0) answerPending('the DFYOM instance did not answer before the end')
        await http.terminateSession().catch(() => undefined)
        await http.close().catch(() => undefined)
        await stdio.close().catch(() => undefined)
        resolve()
      })()
    }
    stdio.onmessage = (m) => {
      const id = requestId(m)
      if (id !== undefined) pending.add(id)
      http.send(m).catch((e: unknown) => {
        log.warn({ err: e }, 'forwarding to the instance failed')
        if (id !== undefined) {
          pending.delete(id)
          void stdio
            .send({
              jsonrpc: '2.0',
              id,
              error: { code: -32603, message: 'the DFYOM instance could not be reached' },
            })
            .catch(() => undefined)
        }
        failed = true
      })
    }
    http.onmessage = (m) => {
      const id = responseId(m)
      if (id !== undefined) pending.delete(id)
      void stdio.send(m).catch(() => close(false))
      if (pending.size === 0) drained?.()
    }
    stdio.onclose = () => close(true)
    // The instance went away (quit, HTTP switched off): answer what is pending, end.
    http.onclose = () => {
      if (!closing) answerPending('the DFYOM instance closed the connection')
      close(false)
    }
    http.onerror = (e) => log.warn({ err: e }, 'instance connection error')
    stdio.onerror = (e) => log.warn({ err: e }, 'stdio error')
    o.stdin.once('end', () => close(true))
  })
  await http.start()
  await stdio.start()
  log.info('bridge started')
  await done
  log.info({ failed }, 'bridge ended')
  return !failed
}
