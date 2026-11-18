/**
 * Agent tools derived from the registries: name mapping, descriptors with `expectedRevision`,
 * annotations, the `--areas` filter and compact schemas (shared `$defs`).
 * Doc: docs/architecture/llm-api.md#exposure-commands-and-queries-as-mcp-tools
 *
 * Never hand-written: every command and query of both registries is a tool, plus the session
 * tools (`SESSION_TOOLS`), so parity with the UI is structural.
 */
import { z } from 'zod'
import { Ok, type AppResult } from '../../shared/result'
import type { AnyCommand, QueryDef } from '../commands/define'
import { toolDescriptor } from '../commands/json-schema'
import type { Registry } from '../commands/registry'

export type JsonObject = Record<string, unknown>

/** Where a tool runs: the app-scope dispatcher, the bound project's, or the session itself. */
export type ToolScope = 'app' | 'project' | 'session'

/** MCP tool annotations (hints for clients), derived from the definition, never hand-set. */
export interface ToolAnnotations {
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

export interface AgentTool {
  /** Registry name (dotted); the CLI uses it. */
  readonly name: string
  /** MCP name: `.` → `_`. */
  readonly mcpName: string
  readonly scope: ToolScope
  /** First name segment (`design`, `plan`, …), for `--areas`. */
  readonly area: string
  readonly kind: AnyCommand['kind'] | 'query' | 'session'
  readonly description: string
  readonly inputSchema: JsonObject
  /** Served by `dfyom://schema/{name}` and `dfyom tools`, never listed in `tools/list`. */
  readonly outputSchema: JsonObject
  readonly annotations: ToolAnnotations
}

/** A tool that is not a registry entry: it acts on the session (docs: #session-tools). */
export interface SessionToolDef {
  readonly name: string
  readonly summary: string
  readonly args: z.ZodType
  readonly result: z.ZodType
}

/** Areas always listed, whatever `--areas` says (with the session tools). */
export const ALWAYS_LISTED_AREAS = ['history', 'job'] as const

/**
 * Budget of the serialized `tools/list` result (all tools), in characters: measured 76.6 K for
 * 85 tools in 3.10 (the doc's 60 K target is not reachable without dropping field
 * descriptions; docs/architecture/llm-api.md#implementation-task-310). Raise it deliberately.
 */
export const TOOLS_LIST_BUDGET_CHARS = 80_000

/** Reserved arg of every project-scope command (decision 12); the adapter strips it. */
export const EXPECTED_REVISION = 'expectedRevision'

/** `design.pocket.add` → `design_pocket_add`. Registry names contain no `_`, so it is bijective. */
export function toMcpName(name: string): string {
  return name.replaceAll('.', '_')
}

export function fromMcpName(mcpName: string): string {
  return mcpName.replaceAll('_', '.')
}

const KIND_LINES = {
  document: 'Undoable.',
  effect: 'Not undoable; writes app data.',
  job: 'Starts a job; returns { jobId }, wait with job_wait.',
} as const

function describe(def: AnyCommand | QueryDef, kind: AgentTool['kind']): string {
  const lines = [def.summary]
  if (kind === 'effect' && 'readOnly' in def && def.readOnly === true) lines.push('Read-only.')
  else if (kind === 'effect' && 'machine' in def && def.machine) lines.push('Not undoable.')
  else if (kind === 'document' || kind === 'effect' || kind === 'job') lines.push(KIND_LINES[kind])
  if ('machine' in def && def.machine) lines.push('Affects a machine.')
  if ('urgent' in def && def.urgent === true)
    lines.push('Runs immediately, even while other commands wait.')
  return lines.join(' ')
}

function hasConfirm(schema: JsonObject): boolean {
  const props = schema['properties']
  return typeof props === 'object' && props !== null && 'confirm' in props
}

/** Docs: #annotations-and-server-instructions. */
export function annotationsOf(
  def: AnyCommand | QueryDef,
  inputSchema: JsonObject,
): ToolAnnotations {
  if (!('kind' in def)) return { readOnlyHint: true, idempotentHint: true }
  const out: { -readonly [K in keyof ToolAnnotations]: ToolAnnotations[K] } = {}
  if (def.kind === 'effect' && def.readOnly === true) {
    out.readOnlyHint = true
    out.idempotentHint = true
  } else if (def.kind === 'document' || def.kind === 'builtin') out.destructiveHint = false
  else out.destructiveHint = hasConfirm(inputSchema) || def.machine
  if (def.machine) out.openWorldHint = true
  return out
}

function withExpectedRevision(schema: JsonObject): JsonObject {
  const props = (schema['properties'] as JsonObject | undefined) ?? {}
  return {
    ...schema,
    properties: {
      ...props,
      // No description: the primer explains it once (it is on ~45 tools, the size budget).
      [EXPECTED_REVISION]: { type: 'integer', minimum: 0 },
    },
  }
}

function registryTool(def: AnyCommand | QueryDef, scope: ToolScope): AppResult<AgentTool> {
  return toolDescriptor(def).map((d) => {
    const kind: AgentTool['kind'] = 'kind' in def ? def.kind : 'query'
    const input = compactSchema(d.inputSchema)
    return {
      name: def.name,
      mcpName: toMcpName(def.name),
      scope,
      area: def.name.split('.')[0] ?? def.name,
      kind,
      description: describe(def, kind),
      inputSchema: scope === 'project' && kind !== 'query' ? withExpectedRevision(input) : input,
      outputSchema: compactSchema(d.outputSchema),
      annotations: annotationsOf(def, d.inputSchema),
    }
  })
}

function sessionTool(def: SessionToolDef): AgentTool {
  return {
    name: def.name,
    mcpName: toMcpName(def.name),
    scope: 'session',
    area: def.name.split('.')[0] ?? def.name,
    kind: 'session',
    description: def.summary,
    inputSchema: compactSchema(z.toJSONSchema(def.args, { io: 'input' }) as JsonObject),
    outputSchema: compactSchema(z.toJSONSchema(def.result, { io: 'output' }) as JsonObject),
    annotations: { readOnlyHint: true, idempotentHint: true },
  }
}

/**
 * Every tool: app-scope commands and queries, project-scope commands and queries, then the
 * session tools. A schema that is not JSON-representable → `internal.unexpected` (a bug).
 */
export function buildAgentTools(
  registries: { readonly app: Registry; readonly project: Registry },
  sessionTools: readonly SessionToolDef[],
): AppResult<AgentTool[]> {
  const out: AgentTool[] = []
  for (const [scope, reg] of [
    ['app', registries.app],
    ['project', registries.project],
  ] as const)
    for (const def of [...reg.commands, ...reg.queries]) {
      const t = registryTool(def, scope)
      if (t.isErr()) return t
      out.push(t.unwrap())
    }
  for (const def of sessionTools) out.push(sessionTool(def))
  return Ok(out)
}

/** `--areas design,plan`: those areas plus the session tools and `history`/`job` (always). */
export function filterAreas(
  tools: readonly AgentTool[],
  areas: readonly string[] | undefined,
): AgentTool[] {
  if (areas === undefined || areas.length === 0) return [...tools]
  const keep = new Set<string>([...areas, ...ALWAYS_LISTED_AREAS])
  return tools.filter((t) => t.scope === 'session' || keep.has(t.area))
}

/** The `tools/list` entries: no `title`, no `outputSchema` (decision 2). */
export function mcpToolList(tools: readonly AgentTool[]) {
  return tools.map((t) => ({
    name: t.mcpName,
    description: t.description,
    inputSchema: t.inputSchema as { type: 'object'; [k: string]: unknown },
    annotations: { ...t.annotations },
  }))
}

// ---------------------------------------------------------------------------
// Compact schemas: repeated sub-schemas become `$defs` (`$ref`), `$schema` is dropped (MCP's
// default dialect is 2020-12, which allows siblings of `$ref`, so per-use descriptions stay).

/** Sub-schemas at least this long (serialized, without description) are shared if repeated. */
const SHARE_MIN_CHARS = 30

const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function withoutDescription(node: JsonObject): JsonObject {
  const { description: _d, ...rest } = node
  return rest
}

/** Child schema positions of a node (values that are schemas). */
function children(node: JsonObject): JsonObject[] {
  const out: JsonObject[] = []
  for (const [k, v] of Object.entries(node)) {
    if (k === 'properties' || k === '$defs' || k === 'patternProperties') {
      if (isObject(v)) for (const c of Object.values(v)) if (isObject(c)) out.push(c)
    } else if (k === 'items' || k === 'additionalProperties' || k === 'not') {
      if (isObject(v)) out.push(v)
    } else if (k === 'anyOf' || k === 'oneOf' || k === 'allOf' || k === 'prefixItems') {
      if (Array.isArray(v)) for (const c of v) if (isObject(c)) out.push(c)
    }
  }
  return out
}

function mapChildren(node: JsonObject, fn: (c: JsonObject) => JsonObject): JsonObject {
  const out: JsonObject = {}
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'properties' || k === 'patternProperties') && isObject(v))
      out[k] = Object.fromEntries(Object.entries(v).map(([p, c]) => [p, isObject(c) ? fn(c) : c]))
    else if ((k === 'items' || k === 'additionalProperties' || k === 'not') && isObject(v))
      out[k] = fn(v)
    else if (
      (k === 'anyOf' || k === 'oneOf' || k === 'allOf' || k === 'prefixItems') &&
      Array.isArray(v)
    )
      out[k] = v.map((c: unknown) => (isObject(c) ? fn(c) : c))
    else out[k] = v
  }
  return out
}

/**
 * Extracts repeated sub-schemas into `$defs` and drops `$schema`. Schemas that already use
 * `$ref`/`$defs` (recursive Zod schemas) are returned with only `$schema` dropped.
 */
export function compactSchema(schema: JsonObject): JsonObject {
  const { $schema: _s, ...root } = schema
  if (JSON.stringify(root).includes('"$ref"')) return root
  // A repeated node is shared whole (description included) if it repeats as is, else without
  // its description, which then stays beside the `$ref`.
  const counts = new Map<string, number>()
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
  const count = (node: JsonObject) => {
    const full = JSON.stringify(node)
    if (full.length >= SHARE_MIN_CHARS) {
      bump(`=${full}`)
      if ('description' in node) bump(`~${JSON.stringify(withoutDescription(node))}`)
      else bump(`~${full}`)
    }
    for (const c of children(node)) count(c)
  }
  for (const c of children(root)) count(c)
  const defs = new Map<string, { name: string; body: JsonObject }>()
  const share = (key: string, body: JsonObject) => {
    let def = defs.get(key)
    if (def === undefined) {
      def = { name: `d${defs.size + 1}`, body: {} }
      defs.set(key, def)
      def.body = mapChildren(body, rewrite)
    }
    return `#/$defs/${def.name}`
  }
  const rewrite = (node: JsonObject): JsonObject => {
    const full = JSON.stringify(node)
    if ((counts.get(`=${full}`) ?? 0) >= 2) return { $ref: share(`~${full}`, node) }
    const bare = withoutDescription(node)
    const bareKey = `~${JSON.stringify(bare)}`
    if ((counts.get(bareKey) ?? 0) < 2) return mapChildren(node, rewrite)
    const ref = share(bareKey, bare)
    const desc = node['description']
    return desc === undefined ? { $ref: ref } : { $ref: ref, description: desc }
  }
  const body = mapChildren(root, rewrite)
  if (defs.size === 0) return body
  return { ...body, $defs: Object.fromEntries([...defs.values()].map((d) => [d.name, d.body])) }
}
