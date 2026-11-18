/**
 * Streamable HTTP MCP on loopback: `127.0.0.1` only, a per-start bearer token in an owner-only
 * discovery file, `Host`/`Origin` checks, 4 MB bodies, at most 16 sessions, 30 min idle end.
 * Doc: docs/architecture/llm-api.md#local-http
 *
 * None of the protections can be turned off; the whole server can (the app setting, `--mcp-http`).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { filterAreas } from '../../core/agent/tools'
import type { MachineService } from '../../core/run/service'
import type { Logger } from '../../shared/logging'
import { AppError } from '../../shared/errors/app-error'
import { Err, Ok, type AsyncAppResult } from '../../shared/result'
import type { AppHost } from '../host/app-host'
import { removeDiscovery, writeDiscovery } from '../host/discovery'
import { createMcpServer } from './server'

export const LOOPBACK = '127.0.0.1'
export const MCP_PATH = '/mcp'
export const MAX_BODY_BYTES = 4 * 2 ** 20
export const MAX_SESSIONS = 16
export const IDLE_MS = 30 * 60_000

export interface McpHttpOptions {
  readonly host: AppHost
  readonly appVersion: string
  readonly log: Logger
  readonly machine?: MachineService
  /** Fixed port; default random. */
  readonly port?: number
  readonly areas?: readonly string[]
  /** Idle sessions are ended after this (default 30 min). */
  readonly idleMs?: number
  readonly now?: () => number
}

export interface McpHttpServer {
  readonly port: number
  readonly url: string
  /** Bearer token of this start (also in the discovery file). Never log it. */
  readonly token: string
  readonly discoveryFile: string
  sessionCount(): number
  /** Ends idle sessions now (also runs every minute). */
  sweepIdle(): void
  /** Ends every session, stops listening and deletes the discovery file. */
  stop(): Promise<void>
}

interface HttpSession {
  readonly transport: StreamableHTTPServerTransport
  readonly server: Server
  lastSeen: number
}

const digest = (s: string) => createHash('sha256').update(s).digest()

function deny(res: ServerResponse, status: number, message: string): void {
  res
    .writeHead(status, { 'content-type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

async function readBody(
  req: IncomingMessage,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) return { ok: false, status: 413 }
    chunks.push(chunk as Buffer)
  }
  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  } catch {
    return { ok: false, status: 400 }
  }
}

/** Starts the server and writes the discovery file. */
export async function startMcpHttp(o: McpHttpOptions): AsyncAppResult<McpHttpServer> {
  const log = o.log.child({ scope: 'mcp.http' })
  const now = o.now ?? (() => Date.now())
  const token = randomBytes(32).toString('base64url')
  const tokenDigest = digest(token)
  const sessions = new Map<string, HttpSession>()
  const listed = filterAreas(o.host.tools, o.areas)
  let port = 0

  const authorized = (req: IncomingMessage): boolean => {
    const h = req.headers.authorization
    if (h === undefined || !h.startsWith('Bearer ')) return false
    // Hashes have equal length, so the comparison is constant-time whatever the input.
    return timingSafeEqual(digest(h.slice('Bearer '.length)), tokenDigest)
  }

  const endSession = async (id: string) => {
    const s = sessions.get(id)
    if (s === undefined) return
    sessions.delete(id)
    await s.server.close().catch(() => undefined)
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // DNS-rebinding guard: only our own loopback names, and never a browser (any Origin).
    const hostHeader = req.headers.host
    if (hostHeader !== `${LOOPBACK}:${port}` && hostHeader !== `localhost:${port}`)
      return deny(res, 403, 'forbidden host')
    if (req.headers.origin !== undefined) return deny(res, 403, 'browser requests are not allowed')
    if (!authorized(req)) return deny(res, 401, 'unauthorized')
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`)
    if (url.pathname !== MCP_PATH) return deny(res, 404, 'not found')
    let body: unknown
    if (req.method === 'POST') {
      const read = await readBody(req)
      if (!read.ok)
        return deny(res, read.status, read.status === 413 ? 'body too large' : 'malformed JSON')
      body = read.body
    }
    const sid = req.headers['mcp-session-id']
    if (typeof sid === 'string') {
      const s = sessions.get(sid)
      if (s === undefined) return deny(res, 404, 'unknown session')
      s.lastSeen = now()
      return s.transport.handleRequest(req, res, body)
    }
    if (req.method !== 'POST' || !isInitializeRequest(body))
      return deny(res, 400, 'no session: send initialize first')
    if (sessions.size >= MAX_SESSIONS) return deny(res, 503, 'too many sessions')
    const source = { kind: 'agent' as const, id: o.host.nextSourceId('http') }
    const session = o.host.openSession(source)
    const server = createMcpServer({
      host: o.host,
      session,
      listed,
      version: o.appVersion,
      log: o.log,
      ...(o.machine === undefined ? {} : { machine: o.machine }),
    })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, lastSeen: now() })
      },
    })
    transport.onclose = () => {
      const id = transport.sessionId
      if (id !== undefined) sessions.delete(id)
    }
    await server.connect(transport)
    return transport.handleRequest(req, res, body)
  }

  const http: HttpServer = createServer((req, res) => {
    handle(req, res).catch((cause: unknown) => {
      log.error({ err: cause }, 'request failed')
      if (!res.headersSent) deny(res, 500, 'internal error')
    })
  })
  const listening = await new Promise<Error | undefined>((resolve) => {
    http.once('error', resolve)
    http.listen(o.port ?? 0, LOOPBACK, () => resolve(undefined))
  })
  if (listening !== undefined) {
    return Err(
      new AppError('external.failure', 'the local MCP server could not listen', {
        cause: listening,
        where: 'startMcpHttp',
        data: { port: o.port ?? 0 },
      }),
    )
  }
  port = (http.address() as AddressInfo).port
  const sweep = () => {
    const limit = now() - (o.idleMs ?? IDLE_MS)
    for (const [id, s] of sessions) if (s.lastSeen < limit) void endSession(id)
  }
  const sweeper = setInterval(sweep, 60_000)
  sweeper.unref()
  const written = await writeDiscovery(o.host.appData, {
    instanceId: o.host.instanceId,
    pid: process.pid,
    port,
    token,
    startedAt: new Date(now()).toISOString(),
    appVersion: o.appVersion,
  })
  if (written.isErr()) {
    clearInterval(sweeper)
    http.close()
    return Err(written.unwrapErr())
  }
  log.info({ port }, 'local MCP server listening')
  let stopped = false
  return Ok({
    port,
    url: `http://${LOOPBACK}:${port}${MCP_PATH}`,
    token,
    discoveryFile: written.unwrap(),
    sessionCount: () => sessions.size,
    sweepIdle: sweep,
    async stop() {
      if (stopped) return
      stopped = true
      clearInterval(sweeper)
      await Promise.all([...sessions.keys()].map(endSession))
      await new Promise<void>((resolve) => {
        http.close(() => resolve())
        http.closeAllConnections()
      })
      await removeDiscovery(o.host.appData, o.host.instanceId).catch(() => undefined)
      log.info('local MCP server stopped')
    },
  })
}

/**
 * The "Allow local agents to connect" switch: on starts a server with a new token, off stops it
 * (sessions end, their running jobs keep running in their dispatchers) and deletes the file.
 */
export interface LocalHttpControl {
  readonly server: McpHttpServer | undefined
  setEnabled(enabled: boolean): AsyncAppResult<void>
}

export function createLocalHttpControl(o: McpHttpOptions): LocalHttpControl {
  let server: McpHttpServer | undefined
  let tail: Promise<unknown> = Promise.resolve()
  const apply = async (enabled: boolean): AsyncAppResult<void> => {
    if (!enabled) {
      const s = server
      server = undefined
      await s?.stop()
      return Ok(undefined)
    }
    if (server !== undefined) return Ok(undefined)
    const started = await startMcpHttp(o)
    if (started.isErr()) return Err(started.unwrapErr())
    server = started.unwrap()
    return Ok(undefined)
  }
  return {
    get server() {
      return server
    },
    setEnabled(enabled) {
      const run = tail.then(() => apply(enabled))
      tail = run.catch(() => undefined)
      return run
    },
  }
}

export const MCP_HTTP_FLAG = '--mcp-http'

/**
 * Whether the GUI serves local HTTP this run: `--mcp-http=off|<port>` overrides the setting
 * ("Allow local agents to connect", default on) for one run.
 */
export function localHttpSetting(
  argv: readonly string[],
  settingEnabled = true,
): { readonly enabled: boolean; readonly port?: number } {
  let flag: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a.startsWith(`${MCP_HTTP_FLAG}=`)) flag = a.slice(MCP_HTTP_FLAG.length + 1)
    else if (a === MCP_HTTP_FLAG)
      flag = /^(off|\d{1,5})$/.test(argv[i + 1] ?? '') ? argv[i + 1] : 'on'
  }
  if (flag === 'off') return { enabled: false }
  if (flag !== undefined && /^\d{1,5}$/.test(flag)) return { enabled: true, port: Number(flag) }
  if (flag === 'on') return { enabled: true }
  return { enabled: settingEnabled }
}
