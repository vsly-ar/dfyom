/**
 * Query `feedsSpeeds.suggest`: the calculator for a library tool and machine, outside a plan
 * ("what-if" for MCP/CLI). Doc: docs/architecture/feeds-speeds.md#api
 */
import { z } from 'zod'
import { fail, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import { defineQuery, type QueryDef } from '../commands/define'
import { ItemIdSchema, MaterialClassSchema, type LibraryItemKind } from '../library/item'
import type { Library } from '../library/library'
import type { Machine } from '../library/machine'
import type { Tool } from '../library/tool'
import {
  machineLimits,
  suggestCutting,
  type CuttingSuggestion,
  type DerivationStep,
  type Engagement,
  type Suggested,
} from './suggest'

const mm = () => z.number().positive().finite()

export const EngagementSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('slot'),
      ap: mm().optional().describe('Stepdown in mm; omit to get a suggestion'),
    }),
    z.object({
      kind: z.literal('stepover'),
      ae: mm().describe('Stepover (radial engagement) in mm'),
      ap: mm().optional().describe('Stepdown in mm; omit to get a suggestion'),
    }),
    z.object({ kind: z.literal('helix'), ap: mm().describe('Helix pitch in mm') }),
    z.object({ kind: z.literal('drill') }),
  ])
  .describe('Tool engagement: slot (pocket, profile), stepover (facing), helix, drill')

const StepSchema = z.object({
  step: z.string(),
  formula: z.string(),
  inputs: z.record(z.string(), z.union([z.number(), z.string()])),
  result: z.number(),
  unit: z.string(),
  sources: z.array(z.string()).optional(),
})

const FieldSchema = z
  .object({ value: z.number(), unit: z.string(), derivation: z.array(StepSchema) })
  .nullable()

export const SuggestionResultSchema = z.object({
  spindleSpeed: FieldSchema.describe('rpm; null = no suggestion'),
  feedRate: FieldSchema.describe('mm/min'),
  plungeRate: FieldSchema.describe('mm/min'),
  stepdown: FieldSchema.describe('mm; only when the calculator owns the stepdown'),
  stepover: FieldSchema.describe('Always null in v0.1 (strategy fallback)'),
  display: z
    .object({
      dCalc: z.number(),
      vc: z.number().describe('Actual surface speed, m/min'),
      fz: z.number().describe('Actual chip load, mm (drills: mm/rev)'),
      chipThinning: z.number(),
      Q: z.number().nullable().describe('mm³/min'),
      Pc: z.number().nullable().describe('kW'),
      spindleLoad: z.number().nullable().describe('%'),
    })
    .nullable(),
  warnings: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(['warning', 'info']),
      message: z.string(),
      params: z.record(z.string(), z.union([z.number(), z.string()])),
    }),
  ),
})
export type SuggestionResultDTO = z.output<typeof SuggestionResultSchema>

const orNull = <T>(o: Option<T>): T | null => (o.isSome() ? o.unwrap() : null)
type StepDTO = z.output<typeof StepSchema>
type FieldDTO = z.output<typeof FieldSchema>

const stepToDTO = ({ sources, inputs, ...rest }: DerivationStep): StepDTO => ({
  ...rest,
  inputs: { ...inputs },
  ...(sources === undefined ? {} : { sources: [...sources] }),
})
const field = (o: Option<Suggested>): FieldDTO =>
  orNull(o.map((f) => ({ value: f.value, unit: f.unit, derivation: f.derivation.map(stepToDTO) })))

/** Option → null for JSON (agents and the UI get every field, null when there is none). */
export function suggestionToDTO(s: CuttingSuggestion): SuggestionResultDTO {
  return {
    spindleSpeed: field(s.spindleSpeed),
    feedRate: field(s.feedRate),
    plungeRate: field(s.plungeRate),
    stepdown: field(s.stepdown),
    stepover: field(s.stepover),
    display: orNull(
      s.display.map((d) => ({
        dCalc: d.dCalc,
        vc: d.vc,
        fz: d.fz,
        chipThinning: d.chipThinning,
        Q: orNull(d.Q),
        Pc: orNull(d.Pc),
        spindleLoad: orNull(d.spindleLoad),
      })),
    ),
    warnings: [...s.warnings],
  }
}

function lookup<K extends 'tool' | 'machine'>(
  library: Library,
  kind: K,
  id: string,
  path: string,
): AppResult<K extends 'tool' ? Tool : Machine> {
  const found = library.lookup(kind as LibraryItemKind, id)
  if (found.state === 'found' && found.item.values.kind === kind)
    return Ok(found.item.values as K extends 'tool' ? Tool : Machine)
  return fail('input.malformed', `${kind} ${id} is not in the library or does not load`, {
    issues: [{ path: [path], rule: 'unknownItem', message: `no loadable library ${kind}` }],
    where: 'feedsSpeeds.suggest',
  })
}

export const feedsSpeedsSuggest = defineQuery({
  name: 'feedsSpeeds.suggest',
  summary:
    'Suggest spindle speed, feed, plunge rate and stepdown for a library tool in a material class, with the derivation of every number and warnings.',
  readsDocument: false,
  args: z.object({
    toolLibraryItemId: ItemIdSchema,
    materialClass: MaterialClassSchema,
    engagement: EngagementSchema,
    machineLibraryItemId: ItemIdSchema.optional().describe(
      'Machine for clamps, power check and rigidity; omit for unclamped values',
    ),
  }),
  result: SuggestionResultSchema,
  run(_doc, args, ctx) {
    const library = ctx.services.library
    if (library === undefined)
      return fail('internal.unexpected', 'no library service configured', {
        where: 'feedsSpeeds.suggest',
      })
    const tool = lookup(library, 'tool', args.toolLibraryItemId, 'toolLibraryItemId')
    if (tool.isErr()) return tool
    let machine: Option<Machine> = None
    if (args.machineLibraryItemId !== undefined) {
      const m = lookup(library, 'machine', args.machineLibraryItemId, 'machineLibraryItemId')
      if (m.isErr()) return m
      machine = Some(m.unwrap())
    }
    const s = suggestCutting({
      tool: tool.unwrap(),
      materialClass: args.materialClass,
      engagement: args.engagement as Engagement,
      machine: machine.map(machineLimits),
    })
    return Ok(suggestionToDTO(s))
  },
})

export const FEEDS_SPEEDS_QUERIES: readonly QueryDef[] = [feedsSpeedsSuggest]
