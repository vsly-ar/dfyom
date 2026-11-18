/**
 * `dfyom mcp --connect [instance]`: a stdio MCP server that forwards every message to the local
 * HTTP endpoint of a running instance, so stdio-only clients attach to the app the user has open.
 * The HTTP session is the source (`agent:http-<n>`).
 * Doc: docs/architecture/llm-api.md#coexistence-with-a-running-gui
 */
import type { Readable, Writable } from 'node:stream'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
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

/** Runs until stdin ends or the instance goes away; then ends the HTTP session. */
export async function runBridge(o: {
  readonly instance: InstanceRecord
  readonly stdin: Readable
  readonly stdout: Writable
  readonly log: Logger
}): Promise<void> {
  const log = o.log.child({ scope: 'mcp.bridge', instance: o.instance.instanceId })
  const http = connectTransport(o.instance)
  const stdio = new StdioServerTransport(o.stdin, o.stdout)
  let closing = false
  const done = new Promise<void>((resolve) => {
    const close = () => {
      if (closing) return
      closing = true
      void (async () => {
        await http.terminateSession().catch(() => undefined)
        await http.close().catch(() => undefined)
        await stdio.close().catch(() => undefined)
        resolve()
      })()
    }
    stdio.onmessage = (m) => {
      http.send(m).catch((e: unknown) => {
        log.warn({ err: e }, 'forwarding to the instance failed')
        close()
      })
    }
    http.onmessage = (m) => void stdio.send(m).catch(() => close())
    stdio.onclose = close
    http.onclose = close
    http.onerror = (e) => log.warn({ err: e }, 'instance connection error')
    stdio.onerror = (e) => log.warn({ err: e }, 'stdio error')
    o.stdin.once('end', close)
  })
  await http.start()
  await stdio.start()
  log.info('bridge started')
  await done
  log.info('bridge ended')
}
