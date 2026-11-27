/**
 * Library commands `library.{stock,tool,machine,workholding}.{add,update,remove}` and queries
 * `.get`/`.list` (workholding: built-ins and the default rule, workholding-library.md#agent-api);
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
import { listedAs } from '../commands/json-schema'
import { ItemIdSchema, ItemMetaDtoSchema, type LibraryItemKind } from './item'
import type { Library } from './library'
import {
  valuesFromDTO,
  type ItemValuesDTO,
  type LibraryItem,
  type LibraryItemDTO,
} from './library-item'
import { applySettingsChanges, machineSettingsDiff, type SettingsDiff } from './grbl-import'
import { MachineValuesDtoSchema, type MachineValuesDTO } from './machine.dto'
import { parseSettingsText } from '../run/grbl/settings'
import { StockValuesDtoSchema } from './stock.dto'
import { ToolValuesDtoSchema } from './tool.dto'
import { followRecommended } from '../feeds-speeds/preset'
import { valuesFromInput, valuesInputSchema } from './values-input'
import {
  WorkholdingValuesDtoSchema,
  WORKHOLDING_TYPES,
  type WorkholdingValuesDTO,
} from './workholding.dto'
import { withTypeDefaults } from './workholding'
import {
  builtinWorkholding,
  defaultWorkholding,
  isBuiltinWorkholding,
  lookupWorkholding,
} from './workholding-builtins'
import { UnitSystemSchema, type UnitSystem } from '../project/document'

/** Stored values without `kind` (the command name says it). */
const VALUES = {
  stock: StockValuesDtoSchema.omit({ kind: true }),
  tool: ToolValuesDtoSchema.omit({ kind: true }),
  machine: MachineValuesDtoSchema.omit({ kind: true }),
  workholding: WorkholdingValuesDtoSchema.omit({ kind: true }),
}

/** Command args take quantities as strings (library.md#command-input); results are stored DTOs. */
/** The project unit system's values without its description ("Project display unit system"). */
const LIBRARY_UNITS = z.enum(UnitSystemSchema.options)
// No description: the primer's quantities line says bare numbers take the units arg.
const UNITS_ARG = LIBRARY_UNITS.default('mm')

const ITEM_RESULTS = {
  stock: StockValuesDtoSchema.extend(ItemMetaDtoSchema.shape),
  tool: ToolValuesDtoSchema.extend(ItemMetaDtoSchema.shape),
  machine: MachineValuesDtoSchema.extend(ItemMetaDtoSchema.shape),
  workholding: WorkholdingValuesDtoSchema.extend(ItemMetaDtoSchema.shape),
}

const LABEL: Record<LibraryItemKind, string> = {
  stock: 'stock',
  tool: 'tool',
  machine: 'machine',
  workholding: 'workholding device',
}

/**
 * The workholding `values` description: which type takes which field, said once (no field
 * descriptions; workholding-library.md#agent-api).
 */
const WORKHOLDING_VALUES_HELP =
  'Per type: toeClamp width, length (toe to heel), top (above stock top), gripMin, gripMax, stud; vise jawWidth, jawThickness, jawHeight, maxOpening, soft; screw headDiameter, headHeight (above stock top), thread; block length, width, height; base baseType, sacrificial, thickness; surface surfaceType'

/** `update` and `remove` refuse a built-in item (workholding-library.md#built-in-items). */
function refuseBuiltin(kind: LibraryItemKind, id: string, where: string): AppResult<void> {
  if (kind !== 'workholding' || !isBuiltinWorkholding(id)) return Ok(undefined)
  return fail('input.malformed', `${id} is a built-in item; add a copy instead`, {
    issues: [{ path: ['id'], rule: 'builtIn', message: 'built-in items are read-only' }],
    where,
  })
}

function libraryOf(services: Services, where: string): AppResult<Library> {
  return services.library === undefined
    ? fail('internal.unexpected', 'no library service configured', { where })
    : Ok(services.library)
}

function forKind(kind: LibraryItemKind): { commands: AnyCommand[]; queries: QueryDef[] } {
  const label = LABEL[kind]
  const valuesArg: z.ZodType<object> = valuesInputSchema(VALUES[kind]).describe(
    kind === 'workholding' ? WORKHOLDING_VALUES_HELP : `The ${label} values; quantities as strings`,
  ) as z.ZodType<object>
  /**
   * Parsed quantities, `kind`, recommended presets following the calculator (tools,
   * library.md#recommended-presets), then the model (all issues below `values`).
   */
  const modelValues = (values: object, units: UnitSystem) =>
    valuesFromInput(VALUES[kind], values, units, ['values']).andThen((v) => {
      let dto = toValuesDTO(v as object)
      if (dto.kind === 'tool') {
        const followed = followRecommended(dto, units)
        if (followed.issues.length > 0)
          return fail('model.invariant', 'a recommended preset has no calculator data', {
            issues: followed.issues.map((i) => ({ ...i, path: ['values', ...i.path] })),
          })
        dto = followed.values
      }
      if (dto.kind === 'workholding') dto = withTypeDefaults(dto)
      return valuesFromDTO(dto).mapErr((e) => e.prefixIssues('values'))
    })
  const itemResult: z.ZodType<LibraryItemDTO> = ITEM_RESULTS[kind]
  const toValuesDTO = (v: object) => ({ ...v, kind }) as ItemValuesDTO
  const now = (ms: number) => new Date(ms).toISOString()

  const addArgs = z.object({
    values: valuesArg,
    units: UNITS_ARG,
    parentId: ItemIdSchema.optional().describe('Add as a variant of this root stock'),
  })
  const add = defineCommand({
    kind: 'effect',
    name: `library.${kind}.add`,
    summary: `Add a ${label} to the library.`,
    title: () => `Add ${label} to library`,
    machine: false,
    // stock variants (library.md#stock-variants-df13): only the stock add lists a parent
    args: kind === 'stock' ? addArgs : (addArgs.omit({ parentId: true }) as typeof addArgs),
    result: itemResult,
    async run(_doc, args, ctx) {
      const where = `library.${kind}.add`
      const lib = libraryOf(ctx.services, where)
      if (lib.isErr()) return lib
      const values = modelValues(args.values, args.units)
      if (values.isErr()) return Err(values.unwrapErr().withContext(where))
      const item = await lib.unwrap().add(values.unwrap(), {
        id: ctx.ids.next(kind),
        updatedAt: now(ctx.clock.now()),
        parentId: args.parentId,
      })
      return item.map((i) => i.toDTO()).mapErr((e) => e.withContext(where))
    },
  })

  const update = defineCommand({
    kind: 'effect',
    name: `library.${kind}.update`,
    summary: `Replace the values of a library ${label}; pass the revision you read.`,
    title: () => `Update library ${label}`,
    machine: false,
    args: z.object({
      id: ItemIdSchema,
      // no description: the primer's library line says it (tools/list budget, WL1)
      revision: z.number().int().min(1),
      values: valuesArg,
      units: UNITS_ARG,
    }),
    // listed in full on library.<kind>.add only (tools/list budget, llm-api.md#schemas)
    listedArgs: { values: listedAs('object', `library.${kind}.add values (all of them)`) },
    result: itemResult,
    async run(_doc, args, ctx) {
      const where = `library.${kind}.update`
      const builtIn = refuseBuiltin(kind, args.id, where)
      if (builtIn.isErr()) return Err(builtIn.unwrapErr())
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
    summary: `Delete a ${label} from the library (confirm: true). Projects keep their snapshots.`,
    title: () => `Remove ${label} from library`,
    machine: false,
    args: z.object({
      id: ItemIdSchema,
      revision: z.number().int().min(1).optional(),
      confirm: z.literal(true), // the primer says what confirm: true asserts (llm-api.md#schemas)
    }),
    result: z.object({ id: z.string() }),
    async run(_doc, args, ctx) {
      const builtIn = refuseBuiltin(kind, args.id, `library.${kind}.remove`)
      if (builtIn.isErr()) return Err(builtIn.unwrapErr())
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

  if (kind === 'workholding')
    return { commands: [add, update, remove], queries: workholdingQueries() }
  return { commands: [add, update, remove], queries: [get, list] }
}

// ── workholding get/list: built-ins and the default rule (workholding-library.md#agent-api) ──

const WorkholdingResult = ITEM_RESULTS.workholding.extend({
  builtIn: z.literal(true).optional().describe('Read-only; add a copy to change it'),
  isDefault: z
    .literal(true)
    .optional()
    .describe("Its type's default (a user item marked default, else the built-in)"),
})
type WorkholdingResultDTO = z.output<typeof WorkholdingResult>

const LIST_UNITS = UnitSystemSchema.default('mm').describe("Built-ins' value set")

function workholdingQueries(): QueryDef[] {
  const withFlags = (item: LibraryItem, userItems: readonly LibraryItem[], units: UnitSystem) => {
    const dto = item.toDTO() as WorkholdingResultDTO
    const type = (dto as WorkholdingValuesDTO).type
    const def = defaultWorkholding(userItems, type, units)
    return {
      ...dto,
      ...(isBuiltinWorkholding(item.id) ? { builtIn: true as const } : {}),
      ...(def.isSome() && def.unwrap().id === item.id ? { isDefault: true as const } : {}),
    }
  }

  const get = defineQuery({
    name: 'library.workholding.get',
    summary: 'Get a workholding device (library or built-in).',
    readsDocument: false,
    args: z.object({ id: ItemIdSchema, units: LIBRARY_UNITS.default('mm') }),
    result: WorkholdingResult,
    run(_doc, args, ctx) {
      const where = 'library.workholding.get'
      const lib = libraryOf(ctx.services, where)
      if (lib.isErr()) return lib
      const l = lib.unwrap()
      const found = lookupWorkholding(l, args.id, args.units)
      if (found.state === 'found')
        return Ok(withFlags(found.item, l.list('workholding').items, args.units))
      if (found.state === 'unreadable') {
        const err = l.list('workholding').errors.find((e) => e.id === args.id)
        if (err !== undefined) return Err(err.error.withContext(where, { id: args.id }))
      }
      return fail('input.malformed', `workholding device ${args.id} does not exist`, {
        issues: [{ path: ['id'], rule: 'unknownItem', message: 'no such library item' }],
        where,
      })
    },
  })

  const list = defineQuery({
    name: 'library.workholding.list',
    summary: 'List workholding devices (library, then built-ins) and files that do not load.',
    readsDocument: false,
    args: z.object({ type: z.enum(WORKHOLDING_TYPES).optional(), units: LIST_UNITS }),
    result: z.object({
      items: z.array(WorkholdingResult),
      errors: z.array(z.object({ id: z.string(), code: z.string(), message: z.string() })),
    }),
    run(_doc, args, ctx) {
      const lib = libraryOf(ctx.services, 'library.workholding.list')
      if (lib.isErr()) return lib
      const l = lib.unwrap().list('workholding')
      const ofType = (i: LibraryItem) =>
        args.type === undefined || (i.values.kind === 'workholding' && i.values.type === args.type)
      const items = [...l.items, ...builtinWorkholding(args.units)].filter(ofType)
      return Ok({
        items: items.map((i) => withFlags(i, l.items, args.units)),
        errors: l.errors.map((e) => ({ id: e.id, code: e.error.code, message: e.error.message })),
      })
    },
  })

  return [get, list]
}

// ── GRBL `$$` import (library.md#grbl--import) ──────────────────────────────────────────

const SETTINGS_TEXT = z
  .string()
  .min(1)
  .max(100_000)
  .describe('Pasted GRBL `$$` output (any sender); other lines ignored')

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
        .enum(['softLimitsOff', 'manualSpindle', 'notPositive', 'allAxes', 'zHomesDown'])
        .describe(
          'softLimitsOff: travel needs $20=1; manualSpindle: $30/$31 need a gcode spindle; allAxes: all three axes or none; zHomesDown: $23 homes Z down, not supported',
        ),
    }),
  ),
  ignored: z.array(z.number().int()).describe('Settings DFYOM does not use'),
})

const publicDiff = (d: SettingsDiff): z.output<typeof DiffSchema> => ({
  ...d,
  changes: d.changes.map(({ stored: _s, together, ...c }) =>
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

const ALL = (['stock', 'tool', 'machine', 'workholding'] as const).map(forKind)

export const LIBRARY_COMMANDS: readonly AnyCommand[] = [
  ...ALL.flatMap((k) => k.commands),
  settingsImport,
]
export const LIBRARY_QUERIES: readonly QueryDef[] = [
  ...ALL.flatMap((k) => k.queries),
  settingsPreview,
]
