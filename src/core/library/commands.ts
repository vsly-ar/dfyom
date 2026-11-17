/**
 * Library commands `library.{stock,tool,machine}.{add,update,remove}` and queries `.get`/`.list`.
 * Doc: docs/architecture/library.md#storage, docs/architecture/commands.md
 *
 * `effect` commands: written to disk at once, not undoable, no history entry, still logged.
 * They never touch `ProjectDoc`; the library is `ctx.services.library`.
 */
import { z } from 'zod'
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import type { Services } from '../commands/context'
import { defineCommand, defineQuery, type AnyCommand, type QueryDef } from '../commands/define'
import { ItemIdSchema, ItemMetaDtoSchema, type LibraryItemKind } from './item'
import type { Library } from './library'
import { valuesFromDTO, type ItemValuesDTO, type LibraryItemDTO } from './library-item'
import { MachineValuesDtoSchema } from './machine.dto'
import { StockValuesDtoSchema } from './stock.dto'
import { ToolValuesDtoSchema } from './tool.dto'

/** Command args carry the values without `kind` (the command name says it). */
const VALUES_ARGS = {
  stock: StockValuesDtoSchema.omit({ kind: true }),
  tool: ToolValuesDtoSchema.omit({ kind: true }),
  machine: MachineValuesDtoSchema.omit({ kind: true }),
}

const ITEM_RESULTS = {
  stock: StockValuesDtoSchema.extend(ItemMetaDtoSchema.shape),
  tool: ToolValuesDtoSchema.extend(ItemMetaDtoSchema.shape),
  machine: MachineValuesDtoSchema.extend(ItemMetaDtoSchema.shape),
}

const LABEL: Record<LibraryItemKind, string> = { stock: 'stock', tool: 'tool', machine: 'machine' }

function libraryOf(services: Services, where: string): AppResult<Library> {
  return services.library === undefined
    ? fail('internal.unexpected', 'no library service configured', { where })
    : Ok(services.library)
}

function forKind(kind: LibraryItemKind): { commands: AnyCommand[]; queries: QueryDef[] } {
  const label = LABEL[kind]
  const valuesArg: z.ZodType<object> = VALUES_ARGS[kind].describe(`The ${label} values`)
  const itemResult: z.ZodType<LibraryItemDTO> = ITEM_RESULTS[kind]
  const toValuesDTO = (v: object) => ({ ...v, kind }) as ItemValuesDTO
  const now = (ms: number) => new Date(ms).toISOString()

  const add = defineCommand({
    kind: 'effect',
    name: `library.${kind}.add`,
    summary: `Add a ${label} to the library (not undoable).`,
    title: () => `Add ${label} to library`,
    machine: false,
    args: z.object({ values: valuesArg }),
    result: itemResult,
    async run(_doc, args, ctx) {
      const where = `library.${kind}.add`
      const lib = libraryOf(ctx.services, where)
      if (lib.isErr()) return lib
      const values = valuesFromDTO(toValuesDTO(args.values)).mapErr((e) => e.prefixIssues('values'))
      if (values.isErr()) return values
      const item = await lib
        .unwrap()
        .add(values.unwrap(), { id: ctx.ids.next(kind), updatedAt: now(ctx.clock.now()) })
      return item.map((i) => i.toDTO())
    },
  })

  const update = defineCommand({
    kind: 'effect',
    name: `library.${kind}.update`,
    summary: `Replace the values of a library ${label}; pass the revision you read (not undoable).`,
    title: () => `Update library ${label}`,
    machine: false,
    args: z.object({
      id: ItemIdSchema,
      revision: z.number().int().min(1).describe('Revision you read; stale → command.conflict'),
      values: valuesArg,
    }),
    result: itemResult,
    async run(_doc, args, ctx) {
      const lib = libraryOf(ctx.services, `library.${kind}.update`)
      if (lib.isErr()) return lib
      const values = valuesFromDTO(toValuesDTO(args.values)).mapErr((e) => e.prefixIssues('values'))
      if (values.isErr()) return values
      const item = await lib
        .unwrap()
        .update(args.id, args.revision, values.unwrap(), now(ctx.clock.now()))
      return item.map((i) => i.toDTO())
    },
  })

  const remove = defineCommand({
    kind: 'effect',
    name: `library.${kind}.remove`,
    summary: `Delete a ${label} from the library; requires confirm: true (not undoable). Projects keep their snapshots.`,
    title: () => `Remove ${label} from library`,
    machine: false,
    args: z.object({
      id: ItemIdSchema,
      revision: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Revision you read; omit only to remove an item that does not load'),
      confirm: z.literal(true).describe('Must be true: the user confirmed the deletion'),
    }),
    result: z.object({ id: z.string() }),
    async run(_doc, args, ctx) {
      const lib = libraryOf(ctx.services, `library.${kind}.remove`)
      if (lib.isErr()) return lib
      const r = await lib.unwrap().remove(kind, args.id, args.revision)
      return r.map(() => ({ id: args.id }))
    },
  })

  const get = defineQuery({
    name: `library.${kind}.get`,
    summary: `Get one library ${label} with its revision.`,
    args: z.object({ id: ItemIdSchema }),
    result: itemResult,
    run(_doc, args, ctx) {
      const where = `library.${kind}.get`
      const lib = libraryOf(ctx.services, where)
      if (lib.isErr()) return lib
      const found = lib.unwrap().lookup(kind, args.id)
      if (found.state === 'found') return Ok(found.item.toDTO())
      if (found.state === 'unreadable') {
        const err = lib
          .unwrap()
          .list(kind)
          .errors.find((e) => e.id === args.id)
        if (err !== undefined) return Err(err.error.withContext(where, { id: args.id }))
      }
      return fail('input.malformed', `${label} ${args.id} does not exist`, {
        issues: [{ path: ['id'], rule: 'unknownItem', message: 'no such library item' }],
        where,
      })
    },
  })

  const list = defineQuery({
    name: `library.${kind}.list`,
    summary: `List all library ${label} items, and files that do not load with their error.`,
    args: z.object({}),
    result: z.object({
      items: z.array(itemResult),
      errors: z.array(z.object({ id: z.string(), code: z.string(), message: z.string() })),
    }),
    run(_doc, _args, ctx) {
      const lib = libraryOf(ctx.services, `library.${kind}.list`)
      if (lib.isErr()) return lib
      const l = lib.unwrap().list(kind)
      return Ok({
        items: l.items.map((i) => i.toDTO()),
        errors: l.errors.map((e) => ({ id: e.id, code: e.error.code, message: e.error.message })),
      })
    },
  })

  return { commands: [add, update, remove], queries: [get, list] }
}

const ALL = (['stock', 'tool', 'machine'] as const).map(forKind)

export const LIBRARY_COMMANDS: readonly AnyCommand[] = ALL.flatMap((k) => k.commands)
export const LIBRARY_QUERIES: readonly QueryDef[] = ALL.flatMap((k) => k.queries)
