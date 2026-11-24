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
import type { AnyCommand, AnyQueryDef } from '../commands/define'
import { toolDescriptor } from '../commands/json-schema'
import type { Registry } from '../commands/registry'
import { OPERATION_ID_PATTERN, RECORD_ID_PATTERN } from '../design/part.dto'
import { FEATURE_ID_PATTERN } from '../design/feature.dto'
import { SHAPE_ID_PATTERN } from '../design/shape.dto'
import { ITEM_ID_PATTERN } from '../library/item'
import { PROJECT_KEY } from '../project/storage'

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
  /** As listed in `tools/list`: args in `listedArgs` are sketches (llm-api.md#schemas). */
  readonly inputSchema: JsonObject
  /** Every arg in full; served by `dfyom://schema/{name}` and `dfyom tools`. */
  readonly fullInputSchema: JsonObject
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
  /** Default: read-only and idempotent (waits and reads); `project.bind` changes the session. */
  readonly annotations?: ToolAnnotations
}

/** Areas always listed, whatever `--areas` says (with the session tools). */
export const ALWAYS_LISTED_AREAS = ['history', 'job'] as const

/**
 * Budget of the serialized `tools/list` result (all tools), in characters: measured 76.6 K for
 * 85 tools in 3.10 (the doc's 60 K target is not reachable without dropping field
 * descriptions; docs/architecture/llm-api.md#implementation-task-310). v0.2: 77.3 K for 89 tools
 * after the reserved keys left the schemas; 79.6 K after D20, E1, A4 and R2, raised to 100 K
 * for the rest of v0.2's commands (decision D21 in docs/plans/v0.2.md). v0.4: 98.8 K for 111
 * tools at the end of v0.3; raised to 120 K for v0.4's feature tools (Q32 option A, task M1 in
 * docs/plans/v0.4.md), new tools designed folded (`get` as a `list` filter). Hardening A8: 106.8 K
 * for 124 tools after `withoutValidationOnlyKeywords` and shared descriptions moved to the primer.
 * Hardening headroom work: 119.9 → 100.7 K for 133 tools (listed sketches, no id/name
 * descriptions, sharing only where it pays, equivalent short forms, no hints beside readOnlyHint).
 * Raise it deliberately.
 */
export const TOOLS_LIST_BUDGET_CHARS = 120_000

/**
 * Reserved arg of every project-scope command (decision 12); the adapter strips it. Not in the
 * tool schemas: the primer explains it once (size budget, llm-api.md#schemas).
 */
export const EXPECTED_REVISION = 'expectedRevision'

/**
 * Reserved arg of every project-scope document command: `false` leaves the change pending for a
 * later `project_apply` (docs/architecture/apply.md#agents-mcp-and-cli); the adapter strips it.
 * Not in the tool schemas: the primer explains it once; misuse names the accepting tools.
 */
export const APPLY_KEY = 'apply'

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

function describe(def: AnyCommand | AnyQueryDef, kind: AgentTool['kind']): string {
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
  def: AnyCommand | AnyQueryDef,
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

function registryTool(def: AnyCommand | AnyQueryDef, scope: ToolScope): AppResult<AgentTool> {
  return toolDescriptor(def).map((d) => {
    const kind: AgentTool['kind'] = 'kind' in def ? def.kind : 'query'
    return {
      name: def.name,
      mcpName: toMcpName(def.name),
      scope,
      area: def.name.split('.')[0] ?? def.name,
      kind,
      description: describe(def, kind),
      // The reserved keys (expectedRevision, apply) are not listed: the primer explains them
      // once, the session strips them (docs/architecture/llm-api.md#schemas).
      inputSchema: compactSchema(d.listedInputSchema),
      fullInputSchema: compactSchema(d.inputSchema),
      outputSchema: compactSchema(d.outputSchema),
      annotations: annotationsOf(def, d.inputSchema),
    }
  })
}

function sessionTool(def: SessionToolDef): AgentTool {
  const input = compactSchema(z.toJSONSchema(def.args, { io: 'input' }) as JsonObject)
  return {
    name: def.name,
    mcpName: toMcpName(def.name),
    scope: 'session',
    area: def.name.split('.')[0] ?? def.name,
    kind: 'session',
    description: def.summary,
    inputSchema: input,
    fullInputSchema: input,
    outputSchema: compactSchema(z.toJSONSchema(def.result, { io: 'output' }) as JsonObject),
    annotations: def.annotations ?? { readOnlyHint: true, idempotentHint: true },
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

/**
 * The annotations as listed: beside `readOnlyHint: true` the MCP spec gives `destructiveHint` and
 * `idempotentHint` no meaning, so they are left out (docs: #annotations-and-server-instructions).
 */
export function listedAnnotations(a: ToolAnnotations): ToolAnnotations {
  if (a.readOnlyHint !== true) return { ...a }
  const { destructiveHint: _d, idempotentHint: _i, ...rest } = a
  return rest
}

/** The `tools/list` entries: no `title`, no `outputSchema` (decision 2). */
export function mcpToolList(tools: readonly AgentTool[]) {
  return tools.map((t) => ({
    name: t.mcpName,
    description: t.description,
    inputSchema: t.inputSchema as { type: 'object'; [k: string]: unknown },
    annotations: listedAnnotations(t.annotations),
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
 * Drops Zod's `.int()` bounds `±Number.MAX_SAFE_INTEGER`: they say nothing an agent needs (the
 * command validates anyway) and repeat on every integer field.
 */
export function withoutSafeIntBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutSafeIntBounds)
  if (!isObject(node)) return node
  const out: JsonObject = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === 'maximum' && v === Number.MAX_SAFE_INTEGER) continue
    if (k === 'minimum' && v === Number.MIN_SAFE_INTEGER) continue
    out[k] = withoutSafeIntBounds(v)
  }
  return out
}

/**
 * Id patterns of records an agent only ever passes back (ids come from results; the server
 * generates them): the listing drops them, the command still validates and names the field.
 */
const RECORD_ID_PATTERNS = new Set(
  [
    RECORD_ID_PATTERN,
    ITEM_ID_PATTERN,
    PROJECT_KEY,
    OPERATION_ID_PATTERN,
    FEATURE_ID_PATTERN,
    SHAPE_ID_PATTERN,
  ].map((r) => r.source),
)

/** Strings at least this long are never hit by a sensible value; the bound is not listed. */
const LISTED_MAX_LENGTH_BELOW = 120

/**
 * Drops keywords that only guard the server, never guide a call (the command validates anyway
 * and names the field, docs/architecture/llm-api.md#implementation-task-310): record-id
 * patterns, `minLength: 1` and `maxLength` from 120 up (names, quantity strings, notes, pasted
 * text). Enums, consts, required keys, item counts and short length limits stay.
 */
export function withoutValidationOnlyKeywords(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutValidationOnlyKeywords)
  if (!isObject(node)) return node
  const out: JsonObject = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === 'pattern' && typeof v === 'string' && RECORD_ID_PATTERNS.has(v)) continue
    if (k === 'minLength' && v === 1) continue
    if (k === 'maxLength' && typeof v === 'number' && v >= LISTED_MAX_LENGTH_BELOW) continue
    out[k] = withoutValidationOnlyKeywords(v)
  }
  return out
}

/**
 * A tuple of equal items (`[x, y]` points: `prefixItems: [A, A], items: false`, `minItems` =
 * `maxItems` = 2) as the equivalent array of A with that length (JSON Schema 2020-12), shorter on
 * every point of every tool (docs/architecture/llm-api.md#implementation-task-310).
 */
export function withHomogeneousTuples(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withHomogeneousTuples)
  if (!isObject(node)) return node
  const out: JsonObject = {}
  for (const [k, v] of Object.entries(node)) out[k] = withHomogeneousTuples(v)
  const p = out['prefixItems']
  if (
    Array.isArray(p) &&
    p.length > 0 &&
    out['items'] === false &&
    out['minItems'] === p.length &&
    out['maxItems'] === p.length &&
    p.every((x) => JSON.stringify(x) === JSON.stringify(p[0]))
  ) {
    const { prefixItems: _p, ...rest } = out
    return { ...rest, items: p[0] as JsonObject }
  }
  return out
}

/**
 * `{ type: 'string', const: 'x' }` → `{ const: 'x' }`: a `const` already fixes the type, so the
 * schema accepts exactly the same values (docs/architecture/llm-api.md#schemas, compact emission).
 */
export function withoutConstTypes(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutConstTypes)
  if (!isObject(node)) return node
  const out: JsonObject = {}
  for (const [k, v] of Object.entries(node)) out[k] = withoutConstTypes(v)
  const c = out['const']
  const t = out['type']
  const jsonType = c === null ? 'null' : typeof c === 'number' ? 'number' : typeof c
  if (
    'const' in out &&
    typeof t === 'string' &&
    (t === jsonType || (t === 'integer' && Number.isInteger(c)))
  ) {
    const { type: _t, ...rest } = out
    return rest
  }
  return out
}

/**
 * Drops keywords that allow everything: `additionalProperties: {}` and, below the root (MCP
 * wants `properties` on the input schema itself), `properties: {}` (an "As <tool>" sketch is
 * then just `{ type: 'object' }`).
 */
export function withoutNoOpKeywords(node: unknown, root = true): unknown {
  if (Array.isArray(node)) return node.map((n) => withoutNoOpKeywords(n, false))
  if (!isObject(node)) return node
  const out: JsonObject = {}
  const empty = (v: unknown) => isObject(v) && Object.keys(v).length === 0
  for (const [k, v] of Object.entries(node)) {
    if (k === 'additionalProperties' && empty(v)) continue
    if (k === 'properties' && !root && empty(v)) continue
    // property names are not schemas: their values are, one level down
    out[k] =
      (k === 'properties' || k === '$defs' || k === 'patternProperties') && isObject(v)
        ? Object.fromEntries(Object.entries(v).map(([p, c]) => [p, withoutNoOpKeywords(c, false)]))
        : withoutNoOpKeywords(v, false)
  }
  return out
}

/**
 * Keywords that constrain every instance whatever its type: a branch with one of them cannot
 * take `null` into its `type` (the others, like `items` or `maxLength`, ignore a null).
 */
const NOT_TYPE_SPECIFIC = new Set([
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  '$ref',
  'if',
  'then',
  'else',
  'description',
  'default',
  '$defs',
])

/**
 * A nullable type, `anyOf: [{ type: T, …T's keywords }, { type: 'null' }]`, as the equivalent
 * `{ type: [T, 'null'], …T's keywords }` (JSON Schema 2020-12: `items`, `maxLength` and the like
 * ignore a null; with an enum, `null` joins it): the same values, about 20 chars shorter on every
 * nullable field (docs/architecture/llm-api.md#schemas).
 */
export function withNullableTypes(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withNullableTypes)
  if (!isObject(node)) return node
  const out: JsonObject = {}
  for (const [k, v] of Object.entries(node)) out[k] = withNullableTypes(v)
  const any = out['anyOf']
  if (!Array.isArray(any) || any.length !== 2 || 'type' in out || 'enum' in out) return out
  const isNull = (x: unknown) => isObject(x) && Object.keys(x).length === 1 && x['type'] === 'null'
  const nullAt = any.findIndex(isNull)
  const other: unknown = any[1 - nullAt]
  if (
    nullAt < 0 ||
    !isObject(other) ||
    typeof other['type'] !== 'string' ||
    other['type'] === 'null' ||
    Object.keys(other).some((k) => NOT_TYPE_SPECIFIC.has(k)) ||
    (other['enum'] !== undefined && !Array.isArray(other['enum']))
  )
    return out
  const { anyOf: _a, ...rest } = out
  if (Object.keys(other).some((k) => k in rest)) return out
  const merged: JsonObject = { ...rest, ...other, type: [other['type'], 'null'] }
  if (Array.isArray(other['enum'])) merged['enum'] = [...(other['enum'] as unknown[]), null]
  return merged
}

/** Serialized length of a `{"$ref":"#/$defs/dNN"}` use. */
const REF_CHARS = 22
/** Serialized length of a `$defs` entry's key and separators (`"dNN":` and a comma). */
const DEF_ENTRY_CHARS = 7

/**
 * Sharing a node of `chars` that occurs `uses` times pays only when its uses save more than the
 * definition costs: `{"type":"string"}` (17 chars) is never shared, it is shorter than its `$ref`.
 */
function sharingPays(chars: number, uses: number): boolean {
  return uses >= 2 && uses * (chars - REF_CHARS) > chars + DEF_ENTRY_CHARS
}

/**
 * Extracts repeated sub-schemas into `$defs` where that is shorter (`sharingPays`), drops
 * `$schema`, the safe-integer bounds and the validation-only keywords
 * (`withoutValidationOnlyKeywords`), and writes the equivalent shorter forms: tuples of equal items
 * as arrays (`withHomogeneousTuples`), `const` without its `type` (`withoutConstTypes`),
 * nullable simple types as type arrays (`withNullableTypes`), no allow-all keywords
 * (`withoutNoOpKeywords`).
 * Schemas that already use `$ref`/`$defs` (recursive Zod schemas) are returned without sharing.
 */
export function compactSchema(schema: JsonObject): JsonObject {
  const { $schema: _s, ...root } = equivalentShortForms(schema)
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
    if (sharingPays(full.length, counts.get(`=${full}`) ?? 0))
      return { $ref: share(`~${full}`, node) }
    const bare = withoutDescription(node)
    const bareText = JSON.stringify(bare)
    const bareKey = `~${bareText}`
    if (!sharingPays(bareText.length, counts.get(bareKey) ?? 0)) return mapChildren(node, rewrite)
    const ref = share(bareKey, bare)
    const desc = node['description']
    return desc === undefined ? { $ref: ref } : { $ref: ref, description: desc }
  }
  const body = mapChildren(root, rewrite)
  if (defs.size === 0) return body
  return { ...body, $defs: Object.fromEntries([...defs.values()].map((d) => [d.name, d.body])) }
}

/**
 * The schema with only the keywords an agent needs, in the shortest equivalent forms (everything
 * `compactSchema` does except sharing); the tests compare a compact schema with it.
 */
export function equivalentShortForms(schema: JsonObject): JsonObject {
  return withoutNoOpKeywords(
    withNullableTypes(
      withoutConstTypes(
        withHomogeneousTuples(withoutValidationOnlyKeywords(withoutSafeIntBounds(schema))),
      ),
    ),
  ) as JsonObject
}
