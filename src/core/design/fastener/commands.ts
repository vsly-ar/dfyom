/**
 * Query `design.fastener.list`: the built-in fastener table, for agents and the hole inspector.
 * App scope (static data, no project needed). `get` is folded in as the `size` filter to keep
 * `tools/list` small (docs/architecture/llm-api.md#implementation-task-310).
 * Doc: docs/modes/design-v0.4.md#fastener-table
 */
import { z } from 'zod'
import { fail, Ok } from '../../../shared/result'
import { defineQuery, type QueryDef } from '../../commands/define'
import { FASTENER_SOURCES, FASTENER_STANDARDS, fastenerRows } from './data'

const mm = z.number()

const RowSchema = z.object({
  size: z.string(),
  standard: z.enum(FASTENER_STANDARDS),
  nominal: mm.describe('Thread Ø d, mm'),
  pitch: mm.describe('Coarse pitch, mm'),
  tapDrill: mm.describe('Tap drill Ø, mm'),
  clearance: z
    .object({ close: mm, normal: mm, loose: mm })
    .describe('ISO 273 fine/medium/coarse, mm'),
  socketHead: z.object({ diameter: mm, height: mm }).describe('ISO 4762 dk max, k max, mm'),
  counterbore: z.object({ diameter: mm }).describe('DIN 974-1, mm'),
  countersunkHead: z
    .object({ diameter: mm, angle: mm, source: z.enum(['ISO 10642', 'ISO 7046-1']) })
    .describe('dk theoretical max (mm), included angle (°)'),
  sources: z.array(z.string()),
})

const SourceSchema = z.object({
  key: z.string(),
  ref: z.string(),
  columns: z.array(z.string()),
})

export const fastenerList = defineQuery({
  name: 'design.fastener.list',
  summary: 'Fastener table (clearance, tap drill, head sizes in mm).',
  readsDocument: false,
  args: z.object({
    standard: z.enum(FASTENER_STANDARDS).optional(),
    size: z.string().optional().describe('One row, e.g. M3'),
  }),
  result: z.object({ rows: z.array(RowSchema), sources: z.array(SourceSchema) }),
  run(_doc, args) {
    const rows = fastenerRows(args)
    if (args.size !== undefined && rows.length === 0)
      return fail('input.malformed', `no fastener size ${args.size}`, {
        issues: [{ path: ['size'], rule: 'unknownSize', message: 'not in the fastener table' }],
        where: 'design.fastener.list',
      })
    const used = new Set(rows.flatMap((r) => r.sources))
    return Ok({
      rows: rows.map((r) => ({ ...r, clearance: { ...r.clearance }, sources: [...r.sources] })),
      sources: FASTENER_SOURCES.filter((s) => used.has(s.key)).map((s) => ({
        ...s,
        columns: [...s.columns],
      })),
    })
  },
})

export const FASTENER_QUERIES: readonly QueryDef[] = [fastenerList]
