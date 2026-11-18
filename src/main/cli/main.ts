/**
 * The `dfyom` CLI: one-shot calls, `batch` (JSON lines), `mcp` (stdio server or `--connect`
 * bridge) and `tools`. Same names, descriptors, results and session tools as MCP; only the
 * framing differs. Stdout carries only results; logs go to the log file and `warn`+ to stderr.
 * Doc: docs/architecture/llm-api.md#cli
 */
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { EXIT, exitCodeOf } from '../../core/agent/exit-codes'
import { agentError, errorText } from '../../core/agent/results'
import { SESSION_TOOLS, type AgentSession } from '../../core/agent/session'
import { buildAgentTools, filterAreas, toMcpName, type AgentTool } from '../../core/agent/tools'
import type { CommandOutcome } from '../../core/commands/dispatcher'
import { createAppScopeRegistry, createProjectRegistry } from '../../core/commands/registry'
import { AppError, type AppErrorData } from '../../shared/errors/app-error'
import { Err, fail, fromWire, Ok, type AppResult, type ResultWire } from '../../shared/result'
import { findInstance } from '../host/discovery'
import { connectTransport, runBridge } from '../mcp/bridge'
import { startMcpHttp, type McpHttpServer } from '../mcp/http'
import { createMcpServer, describeTool, whenIdle } from '../mcp/server'
import { defaultAppData, resolveAppData } from '../persistence/paths'
import {
  APP_VERSION,
  startCliLogging,
  startHeadless,
  type Headless,
  type WorkerEntries,
} from './runtime'

export interface CliIo {
  readonly stdin: Readable
  readonly stdout: Writable
  readonly stderr: Writable
  readonly env: NodeJS.ProcessEnv
  /** Hard exit after an uncaught error (logged at `fatal` first). */
  readonly exit: (code: number) => void
}

const VALUE_OPTIONS = new Set([
  '--data-dir',
  '--log-level',
  '--project',
  '--new',
  '--save-as',
  '--expected-revision',
  '--areas',
])
const FLAGS = new Set(['--json', '--no-save', '--confirm', '--no-wait', '--help'])
/** Options whose value is optional: only `--x=v`, or `--x v` when `v` looks like one. */
const OPTIONAL_VALUE: Record<string, RegExp> = {
  '--connect': /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/,
  '--mcp-http': /^(off|\d{1,5})$/,
}

interface Parsed {
  readonly positionals: string[]
  readonly opts: Map<string, string | true>
}

export const USAGE = `Usage:
  dfyom <name> [<json> | @file.json | -] [--project <file> | --new <name> [--save-as <file>]]
        [--no-save] [--json] [--expected-revision <n>] [--confirm] [--connect [<instance>] [--no-wait]]
  dfyom batch [--project <file> | --new <name> [--save-as <file>]] [--no-save]
  dfyom mcp [--areas a,b] [--connect [<instance>]] [--mcp-http[=<port>]]
  dfyom tools [--json] [<name>]
Common: --data-dir <dir>, --log-level <level>. Names: dfyom tools.`

function parse(argv: readonly string[]): AppResult<Parsed> {
  const positionals: string[] = []
  const opts = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (!a.startsWith('--') || a === '-') {
      positionals.push(a)
      continue
    }
    const eq = a.indexOf('=')
    const name = eq < 0 ? a : a.slice(0, eq)
    const inline = eq < 0 ? undefined : a.slice(eq + 1)
    if (VALUE_OPTIONS.has(name)) {
      const v = inline ?? argv[++i]
      if (v === undefined) return usage(`${name} needs a value`)
      opts.set(name, v)
    } else if (FLAGS.has(name)) {
      if (inline !== undefined) return usage(`${name} takes no value`)
      opts.set(name, true)
    } else if (name in OPTIONAL_VALUE) {
      const next = argv[i + 1]
      if (inline !== undefined) opts.set(name, inline)
      else if (next !== undefined && OPTIONAL_VALUE[name]?.test(next) === true)
        opts.set(name, argv[++i] ?? '')
      else opts.set(name, true)
    } else return usage(`unknown option ${name}`)
  }
  return Ok({ positionals, opts })
}

function usage(message: string): AppResult<never> {
  return fail('input.malformed', message, { where: 'cli.usage' })
}

const str = (p: Parsed, name: string): string | undefined => {
  const v = p.opts.get(name)
  return typeof v === 'string' ? v : undefined
}

/** Runs one CLI invocation; returns the exit code. */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  entries: WorkerEntries,
): Promise<number> {
  const out = (value: unknown) => io.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  const printError = (e: AppError) => io.stderr.write(`${errorText(e)}\n`)
  const parsed = parse(argv)
  if (parsed.isErr()) {
    printError(parsed.unwrapErr())
    io.stderr.write(`${USAGE}\n`)
    return EXIT.input
  }
  const p = parsed.unwrap()
  const [command, ...rest] = p.positionals
  if (command === undefined || p.opts.has('--help')) {
    io.stderr.write(`${USAGE}\n`)
    return command === undefined && !p.opts.has('--help') ? EXIT.input : EXIT.ok
  }
  const dataDir = resolveAppData(argv) ?? defaultAppData()
  const ctx: Ctx = { p, io, entries, dataDir, out, printError }
  if (command === 'tools') return toolsCommand(ctx, rest)
  if (command === 'mcp') return mcpCommand(ctx)
  if (command === 'batch') return batchCommand(ctx)
  if (!command.includes('.')) {
    printError(usage(`unknown command ${command}`).unwrapErr())
    io.stderr.write(`${USAGE}\n`)
    return EXIT.input
  }
  return oneShot(ctx, command, rest)
}

interface Ctx {
  readonly p: Parsed
  readonly io: CliIo
  readonly entries: WorkerEntries
  readonly dataDir: string
  readonly out: (value: unknown) => void
  readonly printError: (e: AppError) => void
}

function allTools(): AppResult<AgentTool[]> {
  const app = createAppScopeRegistry()
  if (app.isErr()) return app
  const project = createProjectRegistry()
  if (project.isErr()) return project
  return buildAgentTools({ app: app.unwrap(), project: project.unwrap() }, SESSION_TOOLS)
}

// --- tools --------------------------------------------------------------------------------

function toolsCommand(c: Ctx, rest: readonly string[]): number {
  const tools = allTools()
  if (tools.isErr()) {
    c.printError(tools.unwrapErr())
    return EXIT.internal
  }
  const name = rest[0]
  if (name !== undefined) {
    const t = tools.unwrap().find((x) => x.name === name || x.mcpName === name)
    if (t === undefined) {
      c.printError(fail('command.unknown', `unknown tool ${name}`).unwrapErr())
      return EXIT.input
    }
    c.out(describeTool(t))
    return EXIT.ok
  }
  if (c.p.opts.has('--json')) c.out(tools.unwrap().map(describeTool))
  else for (const t of tools.unwrap()) c.io.stdout.write(`${t.name.padEnd(30)} ${t.description}\n`)
  return EXIT.ok
}

// --- mcp ----------------------------------------------------------------------------------

async function mcpCommand(c: Ctx): Promise<number> {
  const connect = c.p.opts.get('--connect')
  if (connect !== undefined) {
    const { logging } = await startCliLogging(c.dataDir, { argv: [], env: c.io.env })
    const found = await findInstance(c.dataDir, connect === true ? undefined : connect)
    if (found.isErr()) {
      c.printError(found.unwrapErr())
      logging.flushSync()
      return exitCodeOf(found.unwrapErr().code)
    }
    await runBridge({
      instance: found.unwrap(),
      stdin: c.io.stdin,
      stdout: c.io.stdout,
      log: logging.log,
    })
    logging.flushSync()
    return EXIT.ok
  }
  const h = await headless(c)
  if (h === undefined) return EXIT.internal
  const areas = str(c.p, '--areas')
    ?.split(',')
    .map((a) => a.trim())
    .filter((a) => a !== '')
  const session = h.host.openSession({ kind: 'agent', id: h.host.nextSourceId('stdio') })
  const server = createMcpServer({
    host: h.host,
    session,
    listed: filterAreas(h.host.tools, areas),
    version: APP_VERSION,
    log: h.log,
    machine: h.machine,
  })
  let http: McpHttpServer | undefined
  const httpOpt = c.p.opts.get('--mcp-http')
  if (httpOpt !== undefined && httpOpt !== 'off') {
    const started = await startMcpHttp({
      host: h.host,
      appVersion: APP_VERSION,
      log: h.log,
      machine: h.machine,
      ...(httpOpt === true ? {} : { port: Number(httpOpt) }),
    })
    if (started.isErr()) h.report(started.unwrapErr(), { kind: 'system', name: 'mcp.http' })
    else http = started.unwrap()
  }
  const ended = new Promise<void>((resolve) => {
    c.io.stdin.once('end', resolve)
    c.io.stdin.once('close', resolve)
  })
  await server.connect(new StdioServerTransport(c.io.stdin, c.io.stdout))
  await ended
  // End of stdin: answer the calls in flight, then abort running jobs, close every project
  // (unsaved changes stay recoverable) and exit 0.
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  await tick() // the requests read last start their handlers
  await whenIdle(server)
  await tick() // their responses are written
  await server.close().catch(() => undefined)
  await http?.stop()
  await h.shutdown()
  return EXIT.ok
}

async function headless(c: Ctx): Promise<Headless | undefined> {
  const h = await startHeadless({
    dataDir: c.dataDir,
    entries: c.entries,
    argv: logArgs(c.p),
    env: c.io.env,
    exit: c.io.exit,
  })
  if (h.isErr()) {
    c.printError(h.unwrapErr())
    return undefined
  }
  return h.unwrap()
}

const logArgs = (p: Parsed): string[] => {
  const level = str(p, '--log-level')
  return level === undefined ? [] : ['--log-level', level]
}

// --- one-shot and batch --------------------------------------------------------------------

const cliSource = () => ({ kind: 'cli' as const, id: `cli-${process.pid}` })

/** The project of the run: `--project <file>` opens, `--new <name>` creates (both bind). */
async function openProject(c: Ctx, s: AgentSession): Promise<AppResult<string | undefined>> {
  const file = str(c.p, '--project')
  const name = str(c.p, '--new')
  if (file !== undefined && name !== undefined) return usage('use --project or --new, not both')
  if (file === undefined && name === undefined) return Ok(undefined)
  const r =
    file !== undefined
      ? await s.call('project.open', { file })
      : await s.call('project.create', { name, unitSystem: 'mm' })
  return r.result.map((o) => (o.value as { key: string }).key)
}

/**
 * Ends the run's project: saves if the document changed (`--no-save` discards: the changes are
 * dropped and the file is unchanged), then closes it. An untitled project is saved only with
 * `--save-as`; otherwise its changes are discarded.
 */
async function finishProject(c: Ctx, s: AgentSession, key: string): Promise<AppResult<void>> {
  const listed = await s.call('project.list', {})
  if (listed.result.isErr()) return listed.result.map(() => undefined)
  const info = (
    listed.result.unwrap().value as {
      projects: { key: string; dirty: boolean; file: string | null }[]
    }
  ).projects.find((x) => x.key === key)
  if (info === undefined) return Ok(undefined) // closed by the call itself
  const saveAs = str(c.p, '--save-as')
  const discard = c.p.opts.has('--no-save') || (info.file === null && saveAs === undefined)
  if (info.dirty && !discard) {
    const saved = await s.call('project.save', info.file === null ? { target: saveAs } : {})
    if (saved.result.isErr()) return saved.result.map(() => undefined)
  }
  const closed = await s.call('project.close', { key, confirm: true })
  if (closed.result.isErr()) return closed.result.map(() => undefined)
  if (!info.dirty || !discard) return Ok(undefined)
  // Discard: drop the working folder; a saved project is reopened from its file, so close it.
  const resolved = await s.call('project.recovery.resolve', {
    key,
    action: 'discard',
    confirm: true,
  })
  if (resolved.result.isErr()) return resolved.result.map(() => undefined)
  const reopened = (resolved.result.unwrap().value as { key: string | null }).key
  if (reopened === null) return Ok(undefined)
  return (await s.call('project.close', { key: reopened, confirm: true })).result.map(
    () => undefined,
  )
}

async function readArgs(
  c: Ctx,
  spec: string | undefined,
): Promise<AppResult<Record<string, unknown>>> {
  let text: string
  try {
    if (spec === undefined) return Ok({})
    if (spec === '-') text = await streamText(c.io.stdin)
    else if (spec.startsWith('@')) text = await readFile(spec.slice(1), 'utf8')
    else text = spec
  } catch (cause) {
    return fail('input.malformed', `cannot read the args: ${String(cause)}`, { where: 'cli.args' })
  }
  try {
    const v = JSON.parse(text) as unknown
    if (typeof v === 'object' && v !== null && !Array.isArray(v))
      return Ok(v as Record<string, unknown>)
  } catch {
    // reported below
  }
  return usage('the args must be a JSON object')
}

async function streamText(s: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of s) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks).toString('utf8')
}

/** `--confirm` sets `confirm: true` only if the args schema has it; `--expected-revision`. */
function withOptions(
  c: Ctx,
  tool: AgentTool,
  args: Record<string, unknown>,
): AppResult<Record<string, unknown>> {
  const out = { ...args }
  const props = tool.inputSchema['properties'] as Record<string, unknown> | undefined
  if (c.p.opts.has('--confirm') && props !== undefined && 'confirm' in props) out['confirm'] = true
  const rev = str(c.p, '--expected-revision')
  if (rev !== undefined) {
    if (!/^\d+$/.test(rev)) return usage('--expected-revision needs a revision number')
    out['expectedRevision'] = Number(rev)
  }
  return Ok(out)
}

/** Prints a result (value, or the `ResultWire` with `--json`) and returns its exit code. */
function report(c: Ctx, r: AppResult<unknown>): number {
  const json = c.p.opts.has('--json')
  if (r.isOk()) {
    c.out(json ? { ok: true, value: r.unwrap() } : r.unwrap())
    return EXIT.ok
  }
  const e = r.unwrapErr()
  if (json) c.out({ ok: false, ...agentError(e) })
  else c.printError(e)
  return exitCodeOf(e.code)
}

/** A job's final value: waits with `job.wait` until it finished (the process owns the job). */
async function waitJob(s: AgentSession, jobId: string): Promise<AppResult<unknown>> {
  for (;;) {
    const w = await s.call('job.wait', { jobId, timeoutSeconds: 300 })
    if (w.result.isErr()) return w.result
    const info = w.result.unwrap().value as { state: string; outcome?: ResultWire<unknown> }
    if (info.state === 'finished' && info.outcome !== undefined) return fromWire(info.outcome)
  }
}

async function oneShot(c: Ctx, name: string, rest: readonly string[]): Promise<number> {
  const tools = allTools()
  if (tools.isErr()) return report(c, tools)
  const tool = tools.unwrap().find((t) => t.name === name)
  if (tool === undefined)
    return report(c, fail('command.unknown', `unknown tool ${name}; see dfyom tools`))
  if (rest.length > 1) return report(c, usage('expected one args value'))
  const raw = await readArgs(c, rest[0])
  if (raw.isErr()) return report(c, raw)
  const args = withOptions(c, tool, raw.unwrap())
  if (args.isErr()) return report(c, args)
  if (c.p.opts.has('--connect')) return connectedOneShot(c, tool, args.unwrap())
  if (c.p.opts.has('--no-wait'))
    return report(c, usage('--no-wait needs --connect (this process owns its jobs)'))
  const h = await headless(c)
  if (h === undefined) return EXIT.internal
  const s = h.host.openSession(cliSource())
  let result: AppResult<unknown>
  const key = await openProject(c, s)
  if (key.isErr()) result = key
  else {
    const call = await s.call(name, args.unwrap())
    result = call.result.map((o: CommandOutcome) => o.value)
    if (call.result.isOk() && call.kind === 'job')
      result = await waitJob(s, (call.result.unwrap().value as { jobId: string }).jobId)
    const projectKey = key.unwrap()
    if (projectKey !== undefined) {
      const finished = await finishProject(c, s, projectKey)
      if (finished.isErr() && result.isOk()) result = finished
      else if (finished.isErr()) c.printError(finished.unwrapErr())
    }
  }
  s.end()
  const code = report(c, result)
  await h.shutdown()
  return code
}

async function connectedOneShot(
  c: Ctx,
  tool: AgentTool,
  args: Record<string, unknown>,
): Promise<number> {
  const connect = c.p.opts.get('--connect')
  const found = await findInstance(c.dataDir, connect === true ? undefined : (connect as string))
  if (found.isErr()) return report(c, found)
  const transport = connectTransport(found.unwrap())
  const client = new Client({ name: 'dfyom-cli', version: APP_VERSION })
  try {
    await client.connect(transport)
  } catch (cause) {
    return report(
      c,
      fail('external.failure', `cannot connect to instance ${found.unwrap().instanceId}`, {
        data: { cause: String(cause) },
      }),
    )
  }
  const call = async (name: string, a: Record<string, unknown>): Promise<AppResult<unknown>> => {
    const r = await client.callTool({ name: toMcpName(name), arguments: a }, undefined, {
      timeout: 3_600_000,
    })
    const sc = r.structuredContent as { value?: unknown; error?: AppErrorData } | undefined
    if (r.isError === true)
      return Err(
        sc?.error === undefined
          ? new AppError('internal.unexpected', 'tool error without details')
          : AppError.fromJSON(sc.error),
      )
    return Ok(sc?.value)
  }
  let result: AppResult<unknown> = Ok(undefined)
  const file = str(c.p, '--project')
  if (file !== undefined) result = await call('project.open', { file })
  if (result.isOk()) result = await call(tool.name, args)
  if (result.isOk() && tool.kind === 'job' && !c.p.opts.has('--no-wait')) {
    const { jobId } = result.unwrap() as { jobId: string }
    for (;;) {
      const w = await call('job.wait', { jobId, timeoutSeconds: 300 })
      if (w.isErr()) {
        result = w
        break
      }
      const info = w.unwrap() as { state: string; outcome?: ResultWire<unknown> }
      if (info.state === 'finished' && info.outcome !== undefined) {
        result = fromWire(info.outcome)
        break
      }
    }
  }
  await transport.terminateSession().catch(() => undefined)
  await client.close().catch(() => undefined)
  return report(c, result)
}

async function batchCommand(c: Ctx): Promise<number> {
  const h = await headless(c)
  if (h === undefined) return EXIT.internal
  const s = h.host.openSession(cliSource())
  let code: number = EXIT.ok
  const fail1 = (e: AppError) => {
    if (code === EXIT.ok) code = exitCodeOf(e.code)
  }
  const line = (r: AppResult<CommandOutcome>) => {
    if (r.isOk()) c.io.stdout.write(`${JSON.stringify({ ok: true, ...r.unwrap() })}\n`)
    else {
      fail1(r.unwrapErr())
      c.io.stdout.write(`${JSON.stringify({ ok: false, ...agentError(r.unwrapErr()) })}\n`)
    }
  }
  const key = await openProject(c, s)
  if (key.isErr()) {
    c.printError(key.unwrapErr())
    fail1(key.unwrapErr())
  } else {
    const rl = createInterface({ input: c.io.stdin, crlfDelay: Infinity })
    for await (const text of rl) {
      if (text.trim() === '') continue
      const req = parseLine(text)
      if (req.isErr()) {
        line(req.map(() => ({ value: null, revision: 0 })))
        continue
      }
      const { name, args, expectedRevision } = req.unwrap()
      const call = await s.call(
        name,
        expectedRevision === undefined ? args : { ...(args as object), expectedRevision },
      )
      line(call.result)
    }
    const projectKey = key.unwrap()
    if (projectKey !== undefined) {
      const finished = await finishProject(c, s, projectKey)
      if (finished.isErr()) {
        c.printError(finished.unwrapErr())
        fail1(finished.unwrapErr())
      }
    }
  }
  s.end()
  await h.shutdown()
  return code
}

function parseLine(
  text: string,
): AppResult<{ name: string; args: unknown; expectedRevision?: unknown }> {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return usage('each line must be a JSON object { "name", "args", "expectedRevision"? }')
  }
  if (typeof v !== 'object' || v === null || typeof (v as { name?: unknown }).name !== 'string')
    return usage('each line must be a JSON object { "name", "args", "expectedRevision"? }')
  const o = v as { name: string; args?: unknown; expectedRevision?: unknown }
  return Ok({
    name: o.name,
    args: o.args ?? {},
    ...(o.expectedRevision === undefined ? {} : { expectedRevision: o.expectedRevision }),
  })
}
