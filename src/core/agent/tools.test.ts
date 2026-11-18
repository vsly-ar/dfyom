// Tool mapping: names, parity with both registries, annotations, size budget, compact schemas.
// Spec: docs/architecture/llm-api.md#testing (Mapping (core))
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { expectOk } from '../../shared/testing/result'
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
} from './tools'

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

  it('no command or query has an arg named expectedRevision; project commands get it', () => {
    const { app, project } = registries()
    for (const def of [...app.commands, ...app.queries, ...project.commands, ...project.queries]) {
      const schema = expectOk(toolDescriptor(def)).inputSchema
      expect(Object.keys((schema['properties'] as object) ?? {}), def.name).not.toContain(
        EXPECTED_REVISION,
      )
    }
    const tools = allTools()
    const props = (t: AgentTool) => Object.keys(t.inputSchema['properties'] as object)
    expect(props(tool(tools, 'design.pocket.add'))).toContain(EXPECTED_REVISION)
    expect(props(tool(tools, 'history.undo'))).toContain(EXPECTED_REVISION)
    expect(props(tool(tools, 'design.part.list'))).not.toContain(EXPECTED_REVISION)
    expect(props(tool(tools, 'library.tool.add'))).not.toContain(EXPECTED_REVISION)
  })

  it('every input schema is an object schema', () => {
    for (const t of allTools()) expect(t.inputSchema['type'], t.name).toBe('object')
  })

  it('derives annotations and kind lines from the definitions', () => {
    const tools = allTools()
    expect(tool(tools, 'design.part.list')).toMatchObject({
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

  it('tools/list has no output schema and no title', () => {
    for (const t of mcpToolList(allTools())) {
      expect(t).not.toHaveProperty('outputSchema')
      expect(t).not.toHaveProperty('title')
    }
  })

  it('compact schemas are equivalent to the generated ones', () => {
    const { app, project } = registries()
    for (const def of [...app.commands, ...project.commands, ...project.queries]) {
      const d = expectOk(toolDescriptor(def))
      for (const s of [d.inputSchema, d.outputSchema]) {
        const { $schema: _, ...plain } = s
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
})
