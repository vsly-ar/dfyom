/**
 * MCP `Server` of one agent session: tools (one per command/query plus the session tools),
 * resources (action log, run status, schemas), progress and cancellation.
 * Doc: docs/architecture/llm-api.md#exposure-commands-and-queries-as-mcp-tools
 *
 * The SDK's low-level `Server` with our own JSON Schemas and `parseArgs` (not `McpServer` with
 * Zod shapes), so our Zod 4 schemas are not coupled to the SDK's Zod and unknown keys are refused.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolRequest,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import { PRIMER } from '../../core/agent/primer'
import { toToolResult } from '../../core/agent/results'
import { ResultShaper, splitDetail } from '../../core/agent/shape'
import type { AgentSession } from '../../core/agent/session'
import { fromMcpName, mcpToolList, type AgentTool } from '../../core/agent/tools'
import { systemTimers, type Timers } from '../../core/commands/context'
import type { MachineService } from '../../core/run/service'
import type { Logger } from '../../shared/logging'
import { Err } from '../../shared/result'
import type { AppHost } from '../host/app-host'

export const SERVER_NAME = 'dfyom'
/** Resource updates of a project log are debounced; run status throttled to 1 Hz. */
export const LOG_DEBOUNCE_MS = 250
export const RUN_STATUS_INTERVAL_MS = 1000

const RUN_STATUS_URI = 'dfyom://run/status'
const LOG_URI = /^dfyom:\/\/project\/([^/?#]+)\/log(?:\?after=(\d+))?$/
const SCHEMA_URI = /^dfyom:\/\/schema\/([A-Za-z0-9._-]+)$/

export interface McpServerOptions {
  readonly host: Pick<AppHost, 'project' | 'tools'>
  readonly session: AgentSession
  /** Listed tools (`--areas`); every tool of `host.tools` stays callable. */
  readonly listed: readonly AgentTool[]
  readonly version: string
  readonly log: Logger
  readonly machine?: MachineService
  readonly timers?: Timers
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

const inFlight = new WeakMap<Server, { count: number; idle: (() => void)[] }>()

/** Resolves once no tool call of `server` is running (stdin ended: finish them, then shut down). */
export function whenIdle(server: Server): Promise<void> {
  const f = inFlight.get(server)
  if (f === undefined || f.count === 0) return Promise.resolve()
  return new Promise((resolve) => f.idle.push(resolve))
}

/** Builds the server; the caller connects a transport and calls `session.end()` on close. */
export function createMcpServer(o: McpServerOptions): Server {
  const timers = o.timers ?? systemTimers
  const log = o.log.child({ scope: 'mcp', source: o.session.source })
  const server = new Server(
    { name: SERVER_NAME, version: o.version },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: true, listChanged: false },
      },
      instructions: PRIMER,
    },
  )
  const byMcpName = new Map(o.host.tools.map((t) => [t.mcpName, t]))
  const list = mcpToolList(o.listed)
  // summaries, warning changes and compact numbers (docs/architecture/llm-api.md#result-size)
  const shaper = new ResultShaper(o.session)

  server.oninitialized = () => {
    const client = server.getClientVersion()?.name
    if (client !== undefined) o.session.setClient(client)
    log.info({ client }, 'agent session started')
  }

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: list }))

  const flight = { count: 0, idle: [] as (() => void)[] }
  inFlight.set(server, flight)
  server.setRequestHandler(CallToolRequestSchema, async (req, extra: Extra) => {
    flight.count += 1
    try {
      return await callTool(req, extra)
    } finally {
      flight.count -= 1
      if (flight.count === 0) for (const r of flight.idle.splice(0)) r()
    }
  })

  const callTool = async (req: CallToolRequest, extra: Extra) => {
    const tool = byMcpName.get(req.params.name)
    if (tool === undefined)
      throw new McpError(ErrorCode.InvalidParams, `unknown tool ${req.params.name}`)
    const token = req.params._meta?.progressToken
    const name = fromMcpName(tool.mcpName)
    const split = splitDetail(name, req.params.arguments ?? {})
    if (split.isErr()) return toToolResult({ name, kind: 'query', result: Err(split.unwrapErr()) })
    const { args, view } = split.unwrap()
    const call = await o.session.call(name, args, {
      signal: extra.signal,
      ...(token === undefined
        ? {}
        : {
            onProgress: (p) =>
              void extra
                .sendNotification({
                  method: 'notifications/progress',
                  params: {
                    progressToken: token,
                    progress: p.done,
                    ...(p.total === undefined ? {} : { total: p.total }),
                    ...(p.label === undefined ? {} : { message: p.label }),
                  },
                })
                .catch(() => undefined),
          }),
    })
    return toToolResult(shaper.shape(call, args, view))
  }

  // --- resources ---------------------------------------------------------------------------

  server.setRequestHandler(ListResourcesRequestSchema, () => {
    const key = o.session.boundKey
    return {
      resources: [
        { uri: RUN_STATUS_URI, name: 'run status', mimeType: 'application/json' },
        ...(key === undefined
          ? []
          : [
              {
                uri: `dfyom://project/${key}/log`,
                name: 'action log',
                mimeType: 'application/json',
              },
            ]),
      ],
    }
  })

  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: [
      {
        uriTemplate: 'dfyom://project/{key}/log{?after}',
        name: 'action log',
        description: 'Action-log events of an open project after a seq (subscribable)',
        mimeType: 'application/json',
      },
      {
        uriTemplate: 'dfyom://schema/{name}',
        name: 'tool schema',
        description: 'Full descriptor of a tool, with its output schema',
        mimeType: 'application/json',
      },
    ],
  }))

  const json = (uri: string, value: unknown) => ({
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value) }],
  })

  server.setRequestHandler(ReadResourceRequestSchema, (req) => {
    const uri = req.params.uri
    if (uri === RUN_STATUS_URI) return json(uri, o.machine?.status() ?? null)
    const logMatch = LOG_URI.exec(uri)
    if (logMatch !== null) {
      const d = o.host.project(decodeURIComponent(logMatch[1] ?? ''))
      if (d.isNone()) throw new McpError(ErrorCode.InvalidParams, `no open project in ${uri}`)
      const log = d.unwrap().log
      const after = Number(logMatch[2] ?? 0)
      return json(uri, { events: log.since(after, { withPatches: false }), lastSeq: log.lastSeq })
    }
    const schemaMatch = SCHEMA_URI.exec(uri)
    if (schemaMatch !== null) {
      const name = schemaMatch[1] ?? ''
      const tool = byMcpName.get(name) ?? o.host.tools.find((t) => t.name === name)
      if (tool === undefined) throw new McpError(ErrorCode.InvalidParams, `no tool ${name}`)
      return json(uri, describeTool(tool))
    }
    throw new McpError(ErrorCode.InvalidParams, `unknown resource ${uri}`)
  })

  const subscriptions = new Map<string, () => void>()
  const updated = (uri: string) => void server.sendResourceUpdated({ uri }).catch(() => undefined)

  server.setRequestHandler(SubscribeRequestSchema, (req) => {
    const uri = req.params.uri
    if (subscriptions.has(uri)) return {}
    if (uri === RUN_STATUS_URI) {
      if (o.machine === undefined) return {}
      subscriptions.set(
        uri,
        throttled(timers, RUN_STATUS_INTERVAL_MS, o.machine, () => updated(uri)),
      )
      return {}
    }
    const m = LOG_URI.exec(uri)
    const d = m === null ? undefined : o.host.project(decodeURIComponent(m[1] ?? ''))
    if (d === undefined || d.isNone())
      throw new McpError(ErrorCode.InvalidParams, `not subscribable: ${uri}`)
    let timer: unknown
    const off = d.unwrap().log.subscribe({}, () => {
      timers.clear(timer)
      timer = timers.set(() => updated(uri), LOG_DEBOUNCE_MS)
    })
    subscriptions.set(uri, () => {
      timers.clear(timer)
      off()
    })
    return {}
  })

  server.setRequestHandler(UnsubscribeRequestSchema, (req) => {
    subscriptions.get(req.params.uri)?.()
    subscriptions.delete(req.params.uri)
    return {}
  })

  server.onclose = () => {
    for (const off of subscriptions.values()) off()
    subscriptions.clear()
    o.session.end()
    log.info('agent session ended')
  }
  return server
}

/** Status changes trigger `fn` at most once per interval (the last change always reported). */
function throttled(
  timers: Timers,
  intervalMs: number,
  machine: MachineService,
  fn: () => void,
): () => void {
  let timer: unknown
  let pending = false
  const off = machine.onStatus(() => {
    if (timer !== undefined) {
      pending = true
      return
    }
    fn()
    const tick = () => {
      if (pending) {
        pending = false
        fn()
        timer = timers.set(tick, intervalMs)
      } else timer = undefined
    }
    timer = timers.set(tick, intervalMs)
  })
  return () => {
    timers.clear(timer)
    off()
  }
}

/** The full descriptor (`dfyom://schema/{name}`, `dfyom tools --json <name>`). */
export function describeTool(t: AgentTool) {
  return {
    name: t.name,
    mcpName: t.mcpName,
    scope: t.scope,
    description: t.description,
    inputSchema: t.fullInputSchema,
    outputSchema: t.outputSchema,
    annotations: t.annotations,
  }
}
