/**
 * Library commands `library.{stock,tool,machine}.{add,update,remove}` and queries `.get`/`.list`;
 * the GRBL `$$` import `library.machine.settings.{preview,import}` (library.md#grbl--import).
 * Doc: docs/architecture/library.md#storage, docs/architecture/commands.md
 *
 * `effect` commands: written to disk at once, not undoable, no history entry, still logged.
 * They never touch `ProjectDoc`; the library is `ctx.services.library`. `add`/`update` take
 * quantities as strings (bare numbers in `units`) and store the parsed DTOs.
 */
import { z } from 'zod'
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import type { Services } from '../commands/context'
import { defineCommand, defineQuery, type AnyCommand, type QueryDef } from '../commands/define'
import { ItemIdSchema, ItemMetaDtoSchema, type LibraryItemKind } from './item'
import type { Library } from './library'
import { valuesFromDTO, type ItemValuesDTO, type LibraryItemDTO } from './library-item'
import { applySettingsChanges, machineSettingsDiff, type SettingsDiff } from './grbl-import'
import { MachineValuesDtoSchema, type MachineValuesDTO } from './machine.dto'
import { parseSettingsText } from '../run/grbl/settings'
import { StockValuesDtoSchema } from './stock.dto'
import { ToolValuesDtoSchema } from './tool.dto'
import { valuesFromInput, valuesInputSchema } from './values-input'
import { UnitSystemSchema, type UnitSystem } from '../project/document'

/** Stored values without `kind` (the command name says it). */
const VALUES = {
  stock: StockValuesDtoSchema.omit({ kind: true }),
  tool: ToolValuesDtoSchema.omit({ kind: true }),
  machine: MachineValuesDtoSchema.omit({ kind: true }),
}

/** Command args take quantities as strings (library.md#command-input); results are stored DTOs. */
const UNITS_ARG = UnitSystemSchema.default('mm').describe(
  'Unit system of bare numbers in values (default mm)',
)

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
  const valuesArg: z.ZodType<object> = valuesInputSchema(VALUES[kind]).describe(
    `The ${label} values; quantities are strings, e.g. "6 mm", "1/4 in"`,
  ) as z.ZodType<object>
  /** Parsed quantities, `kind`, then the model (all issues below `values`). */
  const modelValues = (values: object, units: UnitSystem) =>
    valuesFromInput(VALUES[kind], values, units, ['values']).andThen((v) =>
      valuesFromDTO(toValuesDTO(v as object)).mapErr((e) => e.prefixIssues('values')),
    )
  const itemResult: z.ZodType<LibraryItemDTO> = ITEM_RESULTS[kind]
  const toValuesDTO = (v: object) => ({ ...v, kind }) as ItemValuesDTO
  const now = (ms: number) => new Date(ms).toISOString()

  const add = defineCommand({
    kind: 'effect',
    name: `library.${kind}.add`,
    summary: `Add a ${label} to the library (not undoable).`,
    title: () => `Add ${label} to library`,
    machine: false,
    args: z.object({ values: valuesArg, units: UNITS_ARG }),
    result: itemResult,
    async run(_doc, args, ctx) {
      const where = `library.${kind}.add`
      const lib = libraryOf(ctx.services, where)
      if (lib.isErr()) return lib
      const values = modelValues(args.values, args.units)
      if (values.isErr()) return Err(values.unwrapErr().withContext(where))
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
      units: UNITS_ARG,
    }),
    result: itemResult,
    async run(_doc, args, ctx) {
      const where = `library.${kind}.update`
      const lib = libraryOf(ctx.services, where)
      if (lib.isErr()) return lib
      const values = modelValues(args.values, args.units)
      if (values.isErr()) return Err(values.unwrapErr().withContext(where))
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
        .describe(
          'Revision you read; omit only to remove an item that does not load (else conflict)',
        ),
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
    readsDocument: false,
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
    readsDocument: false,
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

// ── GRBL `$$` import (library.md#grbl--import) ──────────────────────────────────────────

const SETTINGS_TEXT = z
  .string()
  .min(1)
  .max(100_000)
  .describe('GRBL `$$` output as pasted from any sender; other lines are ignored')

const ChangeSchema = z.object({
  setting: z.string().describe('e.g. $110'),
  field: z.string().describe('Machine field path, e.g. maxFeedRate.x'),
  value: z.number().describe('As GRBL printed it (mm, mm/min, mm/s², rpm)'),
  from: z.string().nullable().describe('Stored value with unit; null = not set'),
  to: z.string().describe('Value to store, with unit'),
  together: z.array(z.string()).optional().describe('Accept these settings together'),
})

const DiffSchema = z.object({
  read: z.number().int().describe('Settings found in the text'),
  changes: z.array(ChangeSchema),
  unchanged: z.array(z.string()),
  skipped: z.array(
    z.object({
      setting: z.string(),
      field: z.string(),
      value: z.number(),
      rule: z
        .enum(['softLimitsOff', 'manualSpindle', 'notPositive', 'allAxes'])
        .describe(
          'softLimitsOff: travel needs $20=1; manualSpindle: $30/$31 need a gcode spindle; allAxes: all three axes or none',
        ),
    }),
  ),
  ignored: z.array(z.number().int()).describe('Settings DFYOM does not use'),
})

const publicDiff = (d: SettingsDiff): z.output<typeof DiffSchema> => ({
  ...d,
  changes: d.changes.map(({ quantity: _q, together, ...c }) =>
    together === undefined ? c : { ...c, together: [...together] },
  ),
  unchanged: [...d.unchanged],
  skipped: [...d.skipped],
  ignored: [...d.ignored],
})

/** The machine and the diff of `text` against it. */
function settingsDiff(
  services: Services,
  id: string,
  text: string,
  where: string,
): AppResult<{ lib: Library; values: MachineValuesDTO; diff: SettingsDiff }> {
  const lib = libraryOf(services, where)
  if (lib.isErr()) return Err(lib.unwrapErr())
  const found = lib.unwrap().lookup('machine', id)
  if (found.state !== 'found')
    return fail('input.malformed', `machine ${id} does not exist or does not load`, {
      issues: [
        {
          path: ['id'],
          rule: found.state === 'missing' ? 'unknownItem' : 'unreadableItem',
          message: found.state === 'missing' ? 'no such library item' : 'item file does not load',
        },
      ],
      where,
    })
  const parsed = parseSettingsText(text)
  if (parsed.settings.size === 0)
    return fail('input.malformed', 'no GRBL settings ($n=value lines) in the text', {
      issues: [{ path: ['text'], rule: 'noSettings', message: 'no $n=value lines found' }],
      where,
    })
  const values = found.item.values.toDTO() as MachineValuesDTO
  return Ok({ lib: lib.unwrap(), values, diff: machineSettingsDiff(values, parsed.settings) })
}

const settingsPreview = defineQuery({
  name: 'library.machine.settings.preview',
  summary:
    'Compare pasted GRBL $$ output with a library machine: changes, unchanged, skipped and why, ignored settings. Never writes to GRBL.',
  readsDocument: false,
  args: z.object({ id: ItemIdSchema, text: SETTINGS_TEXT }),
  result: DiffSchema,
  run(_doc, args, ctx) {
    return settingsDiff(ctx.services, args.id, args.text, 'library.machine.settings.preview').map(
      (r) => publicDiff(r.diff),
    )
  },
})

const settingsImport = defineCommand({
  kind: 'effect',
  name: 'library.machine.settings.import',
  summary:
    'Apply the accepted changes of pasted GRBL $$ output to a library machine (see library.machine.settings.preview; not undoable, never writes to GRBL).',
  title: () => 'Import GRBL settings into library machine',
  machine: false,
  args: z.object({
    id: ItemIdSchema,
    revision: z.number().int().min(1).describe('Revision you read; stale → command.conflict'),
    text: SETTINGS_TEXT,
    accept: z
      .array(z.string())
      .min(1)
      .describe('Settings to apply, from the preview changes (e.g. ["$110", "$111"])'),
  }),
  result: z.object({ item: ITEM_RESULTS.machine, applied: z.array(z.string()) }),
  async run(_doc, args, ctx) {
    const where = 'library.machine.settings.import'
    const r = settingsDiff(ctx.services, args.id, args.text, where)
    if (r.isErr()) return Err(r.unwrapErr())
    const { lib, values, diff } = r.unwrap()
    const next = applySettingsChanges(values, diff, args.accept)
      .andThen((v) => valuesFromDTO(v).mapErr((e) => e.prefixIssues('values')))
      .mapErr((e) => e.withContext(where))
    if (next.isErr()) return Err(next.unwrapErr())
    const item = await lib.update(
      args.id,
      args.revision,
      next.unwrap(),
      new Date(ctx.clock.now()).toISOString(),
    )
    const applied = diff.changes.map((c) => c.setting).filter((s) => args.accept.includes(s))
    return item.map((i) => ({ item: i.toDTO() as z.output<typeof ITEM_RESULTS.machine>, applied }))
  },
})

const ALL = (['stock', 'tool', 'machine'] as const).map(forKind)

export const LIBRARY_COMMANDS: readonly AnyCommand[] = [
  ...ALL.flatMap((k) => k.commands),
  settingsImport,
]
export const LIBRARY_QUERIES: readonly QueryDef[] = [
  ...ALL.flatMap((k) => k.queries),
  settingsPreview,
]
