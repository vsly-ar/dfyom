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
  readonly outputSchema: Record<string, unknown>
}

/** One descriptor; schemas that are not JSON-representable (`z.date()`, transforms…) → Err. */
export function toolDescriptor(def: AnyCommand | AnyQueryDef): AppResult<ToolDescriptor> {
  return tryCatch(
    () => ({
      name: def.name,
      description: def.summary,
      inputSchema: z.toJSONSchema(def.args, { io: 'input' }) as Record<string, unknown>,
      outputSchema: z.toJSONSchema(def.result, { io: 'output' }) as Record<string, unknown>,
    }),
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
