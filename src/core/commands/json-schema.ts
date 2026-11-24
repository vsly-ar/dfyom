/**
 * Tool descriptors (MCP tools, CLI help) generated from the Zod schemas; no hand-written schemas.
 * Doc: docs/architecture/commands.md#json-schema-for-agent-tools
 */
import { z } from 'zod'
import { ctx, Ok, tryCatch, type AppResult } from '../../shared/result'
import type { AnyCommand, AnyQueryDef } from './define'
import type { Registry } from './registry'

export interface ToolDescriptor {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  /**
   * `inputSchema` with the definition's `listedArgs` sketches in place of those args (the
   * `tools/list` input schema, llm-api.md#schemas); `inputSchema` itself when it has none.
   */
  readonly listedInputSchema: Record<string, unknown>
  readonly outputSchema: Record<string, unknown>
}

type JsonSchema = Record<string, unknown>

/**
 * A `listedArgs` sketch of an arg another tool lists in full: an object, or an array of objects,
 * described "As <that tool's arg>" (`as`, e.g. `design.shape.add items`). It accepts any object,
 * so it never refuses what the full arg accepts; the dispatcher validates the full arg.
 */
export function listedAs(shape: 'object' | 'array', as: string): z.ZodType {
  const item = z.looseObject({})
  return (shape === 'object' ? item : z.array(item)).describe(`As ${as}`)
}

/** The full input schema with the sketched args replaced (their `required` entries stay). */
function withListedArgs(full: JsonSchema, def: AnyCommand | AnyQueryDef): JsonSchema {
  const listed = def.listedArgs
  if (listed === undefined) return full
  const props = { ...(full['properties'] as Record<string, unknown>) }
  for (const [k, sketch] of Object.entries(listed)) {
    if (!(k in props)) throw new Error(`listedArgs.${k} of ${def.name} is not an arg`)
    const { $schema: _s, ...schema } = z.toJSONSchema(sketch, { io: 'input' }) as JsonSchema
    props[k] = schema
  }
  return { ...full, properties: props }
}

/** One descriptor; schemas that are not JSON-representable (`z.date()`, transforms…) → Err. */
export function toolDescriptor(def: AnyCommand | AnyQueryDef): AppResult<ToolDescriptor> {
  return tryCatch(
    () => {
      const inputSchema = z.toJSONSchema(def.args, { io: 'input' }) as JsonSchema
      return {
        name: def.name,
        description: def.summary,
        inputSchema,
        listedInputSchema: withListedArgs(inputSchema, def),
        outputSchema: z.toJSONSchema(def.result, { io: 'output' }) as JsonSchema,
      }
    },
    'internal.unexpected',
    `schema of ${def.name} is not JSON-representable`,
  ).mapErr(ctx('toolDescriptor', { name: def.name }))
}

/** Descriptors for every command, then every query, in registry order. */
export function toolDescriptors(registry: Registry): AppResult<ToolDescriptor[]> {
  const out: ToolDescriptor[] = []
  for (const def of [...registry.commands, ...registry.queries]) {
    const d = toolDescriptor(def)
    if (d.isErr()) return d
    out.push(d.unwrap())
  }
  return Ok(out)
}
