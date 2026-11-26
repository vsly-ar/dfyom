// Tool mapping: names, parity with both registries, annotations, size budget, compact schemas.
// Spec: docs/architecture/llm-api.md#testing (Mapping (core))
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { expectOk } from '../../shared/testing/result'
import { parseArgs } from '../commands/args'
import { toolDescriptor } from '../commands/json-schema'
import { createAppScopeRegistry, createProjectRegistry } from '../commands/registry'
import { SESSION_TOOLS } from './session'
import {
  buildAgentTools,
  compactSchema,
  EXPECTED_REVISION,
  filterAreas,
  fromMcpName,
  mcpToolList,
  TOOLS_LIST_BUDGET_CHARS,
  toMcpName,
  type AgentTool,
  type JsonObject,
  equivalentShortForms,
  listedAnnotations,
  withNullableTypes,
  withoutConstTypes,
  withoutNoOpKeywords,
  withoutValidationOnlyKeywords,
} from './tools'
import { PRIMER } from './primer'

const registries = () => ({
  app: expectOk(createAppScopeRegistry()),
  project: expectOk(createProjectRegistry()),
})
const allTools = () => expectOk(buildAgentTools(registries(), SESSION_TOOLS))
const tool = (tools: AgentTool[], name: string) => {
  const t = tools.find((x) => x.name === name)
  expect(t, name).toBeDefined()
  return t!
}

/** Inlines `$ref`s to `#/$defs/…` (siblings such as `description` win over the definition's). */
function expand(node: unknown, defs: JsonObject): unknown {
  if (Array.isArray(node)) return node.map((n) => expand(n, defs))
  if (typeof node !== 'object' || node === null) return node
  const o = node as JsonObject
  if (typeof o['$ref'] === 'string') {
    const { $ref, ...rest } = o
    const target = defs[($ref as string).replace('#/$defs/', '')]
    return { ...(expand(target, defs) as JsonObject), ...(expand(rest, defs) as JsonObject) }
  }
  return Object.fromEntries(
    Object.entries(o)
      .filter(([k]) => k !== '$defs')
      .map(([k, v]) => [k, expand(v, defs)]),
  )
}

describe('agent tools', () => {
  it('the name mapping is bijective for every registry and session name', () => {
    const tools = allTools()
    const mcp = new Set(tools.map((t) => t.mcpName))
    expect(mcp.size).toBe(tools.length)
    for (const t of tools) {
      expect(t.name).not.toContain('_')
      expect(fromMcpName(toMcpName(t.name))).toBe(t.name)
      expect(t.mcpName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    }
  })

  it('the tool list equals both registries plus the session tools (parity is structural)', () => {
    const { app, project } = registries()
    const names = allTools().map((t) => t.name)
    expect(names).toEqual([
      ...app.commands.map((c) => c.name),
      ...app.queries.map((q) => q.name),
      ...project.commands.map((c) => c.name),
      ...project.queries.map((q) => q.name),
      ...SESSION_TOOLS.map((s) => s.name),
    ])
    // names are unique across both registries and the session tools
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(
      expect.arrayContaining(['project.open', 'library.tool.add', 'history.list', 'job.wait']),
    )
  })

  it('no command, query or tool schema has an arg named expectedRevision (the primer has it)', () => {
    const { app, project } = registries()
    for (const def of [...app.commands, ...app.queries, ...project.commands, ...project.queries]) {
      const schema = expectOk(toolDescriptor(def)).inputSchema
      expect(Object.keys((schema['properties'] as object) ?? {}), def.name).not.toContain(
        EXPECTED_REVISION,
      )
    }
    for (const t of allTools())
      expect(Object.keys((t.inputSchema['properties'] as object) ?? {}), t.name).not.toContain(
        EXPECTED_REVISION,
      )
    expect(PRIMER).toContain(EXPECTED_REVISION)
  })

  it('every input schema is an object schema', () => {
    for (const t of allTools()) expect(t.inputSchema['type'], t.name).toBe('object')
  })

  it('derives annotations and kind lines from the definitions', () => {
    const tools = allTools()
    expect(tool(tools, 'design.part.list')).toMatchObject({
      annotations: { readOnlyHint: true, idempotentHint: true },
    })
    // an async query (ADR 0021) is a read-only tool like any query
    expect(tool(tools, 'design.reference.find')).toMatchObject({
      annotations: { readOnlyHint: true, idempotentHint: true },
    })
    expect(tool(tools, 'design.pocket.add')).toMatchObject({
      annotations: { destructiveHint: false },
      description: expect.stringMatching(/ Undoable\.$/),
    })
    // effect with confirm → destructive
    expect(tool(tools, 'library.tool.remove').annotations).toEqual({ destructiveHint: true })
    expect(tool(tools, 'library.tool.add')).toMatchObject({
      annotations: { destructiveHint: false },
      description: expect.stringMatching(/Not undoable; writes app data\.$/),
    })
    expect(tool(tools, 'project.recovery.list')).toMatchObject({
      annotations: { readOnlyHint: true, idempotentHint: true },
      description: expect.stringMatching(/Read-only\.$/),
    })
    expect(tool(tools, 'plan.toolpath.generate').description).toMatch(
      /Starts a job; returns \{ jobId \}, wait with job_wait\.$/,
    )
    // machine commands: destructive, open world
    expect(tool(tools, 'run.machine.home').annotations).toMatchObject({
      destructiveHint: true,
      openWorldHint: true,
    })
    expect(tool(tools, 'run.machine.reset').description).toContain(
      'Runs immediately, even while other commands wait.',
    )
    expect(tool(tools, 'job.abort').description).toContain('Runs immediately')
    expect(tool(tools, 'job.wait').annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
    })
    expect(tool(tools, 'project.bind').annotations).toEqual({
      destructiveHint: false,
      idempotentHint: true,
    })
  })

  it('--areas keeps the listed areas, the session tools and history/job', () => {
    const tools = allTools()
    const design = filterAreas(tools, ['design'])
    const areas = new Set(design.map((t) => t.area))
    expect([...areas].sort()).toEqual(['design', 'history', 'job', 'project'])
    expect(design.filter((t) => t.area === 'project').map((t) => t.scope)).toEqual(
      expect.arrayContaining(['session']),
    )
    expect(design.some((t) => t.name === 'project.open')).toBe(false)
    expect(filterAreas(tools, undefined)).toHaveLength(tools.length)
  })

  it(`tools/list stays under the size budget (${TOOLS_LIST_BUDGET_CHARS} chars)`, () => {
    const size = JSON.stringify({ tools: mcpToolList(allTools()) }).length
    expect(size).toBeLessThan(TOOLS_LIST_BUDGET_CHARS)
  })

  it('tools/list has no output schema, no title and no safe-integer bounds', () => {
    const list = mcpToolList(allTools())
    expect(JSON.stringify(list)).not.toContain(String(Number.MAX_SAFE_INTEGER))
    for (const t of list) {
      expect(t).not.toHaveProperty('outputSchema')
      expect(t).not.toHaveProperty('title')
    }
  })

  it('tools/list has no record-id patterns and no validation-only string bounds (A8)', () => {
    const text = JSON.stringify(mcpToolList(allTools()))
    expect(text).not.toContain('"minLength":1,')
    expect(text).not.toMatch(/"maxLength":(12\d|1[3-9]\d|[2-9]\d\d|\d{4,})\b/)
    expect(text).not.toContain('{1,128}')
    expect(text).not.toContain('^shape[')
    // constraints an agent needs stay: enums, required keys, item counts, short length limits
    expect(text).toContain('"enum":')
    expect(text).toContain('"maxItems":20')
    expect(text).toContain('"maxLength":64')
    const b = withoutValidationOnlyKeywords({
      type: 'string',
      pattern: '^[a-z0-9_-]{1,120}$',
      minLength: 1,
      maxLength: 256,
    })
    expect(b).toEqual({ type: 'string' })
    expect(
      withoutValidationOnlyKeywords({ type: 'string', pattern: '^x$', maxLength: 60 }),
    ).toEqual({ type: 'string', pattern: '^x$', maxLength: 60 })
  })

  it('compact schemas are equivalent to the generated ones', () => {
    const { app, project } = registries()
    for (const def of [...app.commands, ...app.queries, ...project.commands, ...project.queries]) {
      const d = expectOk(toolDescriptor(def))
      for (const s of [d.inputSchema, d.listedInputSchema, d.outputSchema]) {
        const { $schema: _, ...plain } = equivalentShortForms(s)
        if (JSON.stringify(plain).includes('"$ref"')) continue // recursive: kept as generated
        const compact = compactSchema(s)
        expect(expand(compact, (compact['$defs'] as JsonObject) ?? {}), def.name).toEqual(
          expand(plain, (plain['$defs'] as JsonObject) ?? {}),
        )
      }
    }
  })

  it('compactSchema shares repeated sub-schemas and keeps per-use descriptions', () => {
    const q = z.object({ source: z.string().min(1).max(256), unit: z.enum(['mm', 'in', 'deg']) })
    const s = z.object({ a: q.describe('first'), b: q.describe('second'), c: q })
    const compact = compactSchema(z.toJSONSchema(s, { io: 'input' }) as JsonObject)
    expect(compact['$schema']).toBeUndefined()
    expect(compact['properties']).toEqual({
      a: { $ref: '#/$defs/d1', description: 'first' },
      b: { $ref: '#/$defs/d1', description: 'second' },
      c: { $ref: '#/$defs/d1' },
    })
  })

  it('compactSchema shares a node only where the $ref is shorter (tools/list budget)', () => {
    const s = z.object({
      a: z.string().describe('a'),
      b: z.string().describe('b'),
      c: z.string(),
      d: z.string(),
    })
    const compact = compactSchema(z.toJSONSchema(s, { io: 'input' }) as JsonObject)
    expect(compact['$defs']).toBeUndefined()
    expect(compact['properties']).toEqual({
      a: { type: 'string', description: 'a' },
      b: { type: 'string', description: 'b' },
      c: { type: 'string' },
      d: { type: 'string' },
    })
  })

  it('writes the equivalent short forms: const without type, nullable type arrays, no allow-all', () => {
    expect(withoutConstTypes({ type: 'string', const: 'line' })).toEqual({ const: 'line' })
    expect(withoutConstTypes({ type: 'boolean', const: true })).toEqual({ const: true })
    expect(withoutConstTypes({ type: 'integer', const: 2 })).toEqual({ const: 2 })
    // a type the const does not have stays (that schema accepts nothing; keep it as generated)
    expect(withoutConstTypes({ type: 'string', const: 2 })).toEqual({ type: 'string', const: 2 })

    expect(
      withNullableTypes({ description: 'd', anyOf: [{ type: 'string' }, { type: 'null' }] }),
    ).toEqual({ description: 'd', type: ['string', 'null'] })
    expect(
      withNullableTypes({ anyOf: [{ type: 'string', enum: ['x', 'y'] }, { type: 'null' }] }),
    ).toEqual({ type: ['string', 'null'], enum: ['x', 'y', null] })
    // keywords of the type ignore a null, so they move along
    expect(
      withNullableTypes({
        anyOf: [{ type: 'array', items: { type: 'string' }, maxItems: 4 }, { type: 'null' }],
      }),
    ).toEqual({ type: ['array', 'null'], items: { type: 'string' }, maxItems: 4 })
    // keywords that constrain a null too (const, $ref, unions, …) keep the union
    for (const branch of [
      { type: 'string', const: 'x' },
      { type: 'object', anyOf: [{ required: ['a'] }, { required: ['b'] }] },
      { type: 'string', description: 'own' },
    ]) {
      const kept = { anyOf: [branch, { type: 'null' }] }
      expect(withNullableTypes(kept)).toEqual(kept)
    }
    const clash = { maxItems: 2, anyOf: [{ type: 'array', maxItems: 4 }, { type: 'null' }] }
    expect(withNullableTypes(clash)).toEqual(clash)

    expect(
      withoutNoOpKeywords({
        type: 'object',
        properties: {
          a: { type: 'object', properties: {}, additionalProperties: {} },
          properties: { type: 'string' },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'object' }, properties: { type: 'string' } },
    })
    // the root keeps its (empty) properties
    expect(withoutNoOpKeywords({ type: 'object', properties: {} })).toEqual({
      type: 'object',
      properties: {},
    })
  })

  it('lists no idempotent or destructive hint beside readOnlyHint (meaningless per MCP)', () => {
    expect(listedAnnotations({ readOnlyHint: true, idempotentHint: true })).toEqual({
      readOnlyHint: true,
    })
    expect(listedAnnotations({ destructiveHint: false, idempotentHint: true })).toEqual({
      destructiveHint: false,
      idempotentHint: true,
    })
    const list = mcpToolList(allTools())
    expect(list.find((t) => t.name === 'design_part_list')?.annotations).toEqual({
      readOnlyHint: true,
    })
  })

  it('listed sketches ("As <tool> <arg>") only shorten the listing: the full args validate', () => {
    const { app, project } = registries()
    const tools = allTools()
    const sketched = [...app.commands, ...app.queries, ...project.commands, ...project.queries]
      .filter((def) => def.listedArgs !== undefined)
      .map((def) => def.name)
    expect(sketched.sort()).toEqual([
      'design.clones.preview',
      'design.clones.update',
      'design.engraving.add',
      'design.engraving.update',
      'design.line.update',
      'design.part.update',
      'design.pattern.update',
      'design.shape.item.update',
      'design.shape.update',
      'library.machine.update',
      'library.stock.update',
      'library.tool.update',
    ])
    for (const def of [...app.commands, ...app.queries, ...project.commands, ...project.queries]) {
      if (def.listedArgs === undefined) continue
      const t = tool(tools, def.name)
      const defs = (t.inputSchema['$defs'] as JsonObject | undefined) ?? {}
      const listed = (expand(t.inputSchema, defs) as JsonObject)['properties'] as Record<
        string,
        JsonObject
      >
      const full = expectOk(toolDescriptor(def)).inputSchema['properties'] as JsonObject
      for (const key of Object.keys(def.listedArgs)) {
        // the sketch names the tool that lists the arg in full, and it exists
        const as = /^As ([a-z.]+[a-zA-Z.]*) /.exec(String(listed[key]?.['description']))
        expect(as, `${def.name}.${key}`).not.toBeNull()
        tool(tools, as![1]!)
        expect(full[key], `${def.name}.${key}`).toBeDefined()
        // an object the sketch accepts but the full arg refuses is refused, under that key
        const bogus = { bogusKey: 1 }
        const value = listed[key]?.['type'] === 'array' ? [bogus] : bogus
        const parsed = parseArgs(def.args, { [key]: value }, def.name)
        expect(parsed.isErr(), `${def.name}.${key}`).toBe(true)
        expect(
          parsed.unwrapErr().issues.some((i) => i.path[0] === key),
          `${def.name}.${key}`,
        ).toBe(true)
      }
      // dfyom://schema/{name} serves the full input schema
      expect(t.fullInputSchema).toEqual(compactSchema(expectOk(toolDescriptor(def)).inputSchema))
      expect(JSON.stringify(t.fullInputSchema).length).toBeGreaterThan(
        JSON.stringify(t.inputSchema).length,
      )
    }
    expect(PRIMER).toContain('As <tool> <arg>')
  })
})
