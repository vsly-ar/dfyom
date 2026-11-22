// The library form helpers: the defaults of both unit systems are valid library items (core
// models, as `library.<kind>.add` reads them), per-type fields are sent only for their type, a
// partial acceleration is an issue, stored sources stay as they are (L5), and a command error's
// issues map to form fields. Doc: docs/conventions/ui-library-window.md, docs/conventions/ui.md#plan-mode-task-37
import { describe, expect, it } from 'vitest'
import { valuesFromDTO, type ItemValuesDTO } from '../../../core/library/library-item'
import { MachineValuesDtoSchema } from '../../../core/library/machine.dto'
import { StockValuesDtoSchema } from '../../../core/library/stock.dto'
import { TOOL_TYPES, ToolValuesDtoSchema } from '../../../core/library/tool.dto'
import { valuesFromInput, valuesInputSchema } from '../../../core/library/values-input'
import type { UnitSystem } from '../../../core/project/document'
import {
  cleanValues,
  commandInput,
  copyName,
  defaultMachineValues,
  defaultStockValues,
  defaultToolValues,
  displayQuantity,
  draftIssues,
  issuesAt,
  qdto,
  quantityText,
  toolName,
  unmatchedIssues,
  withToolType,
} from './form'
import { chipLoad } from './PresetTable'

const SCHEMAS = {
  tool: ToolValuesDtoSchema.omit({ kind: true }),
  machine: MachineValuesDtoSchema.omit({ kind: true }),
  stock: StockValuesDtoSchema.omit({ kind: true }),
}

/** As `library.<kind>.add` reads its input: shape, quantity strings in `units`, the model. */
const valid = (kind: keyof typeof SCHEMAS, input: { values: object; units: UnitSystem }) => {
  const schema = SCHEMAS[kind]
  const parsed = valuesInputSchema(schema).parse(input.values)
  const r = valuesFromInput(schema, parsed, input.units, ['values']).andThen((v) =>
    valuesFromDTO({ ...(v as object), kind } as ItemValuesDTO),
  )
  if (r.isErr()) throw new Error(JSON.stringify(r.unwrapErr().issues))
  return r.unwrap()
}

describe('library forms', () => {
  it.each(['mm', 'inch'] as const)('defaults are valid items (%s)', (units) => {
    for (const type of TOOL_TYPES)
      valid(
        'tool',
        commandInput(withToolType(defaultToolValues(units), type, units), {
          units,
          autoName: true,
        }),
      )
    valid('machine', commandInput(defaultMachineValues(units), { units }))
    valid('stock', commandInput(defaultStockValues(units), { units }))
    expect(draftIssues(defaultToolValues(units), true)).toEqual([])
  })

  it('suggests a drill for a drilling and names the tool by type and diameter', () => {
    const d = defaultToolValues('inch', 'drilling')
    expect(d.type).toBe('drill')
    expect(toolName(d)).toBe('Drill 1/4')
    const input = commandInput(d, { units: 'inch', autoName: true }).values
    expect(input).toMatchObject({ name: 'Drill 1/4', pointAngle: '118' })
    expect(input).not.toHaveProperty('cornerRadius')
    const bull = cleanValues({
      ...withToolType(defaultToolValues('mm'), 'bullNoseEndMill', 'mm'),
      name: ' B ',
    }).values
    expect(bull).toMatchObject({ name: 'B', cornerRadius: { source: '1' } })
    expect(bull).not.toHaveProperty('pointAngle')
  })

  it('prefills a new tool from the generalized tool', () => {
    const d = defaultToolValues('mm', 'pocket', {
      type: 'ballEndMill',
      diameter: qdto('length', '3', 'mm'),
    })
    expect(d.type).toBe('ballEndMill')
    expect(toolName(d)).toBe('Ball 3')
  })

  it('needs all three acceleration axes or none', () => {
    const m = defaultMachineValues('mm')
    const partial = { ...m, acceleration: { x: qdto('scalar', '500', 'mm') } }
    expect(issuesAt(draftIssues(partial), 'acceleration')).toHaveLength(1)
    expect(draftIssues(m)).toEqual([])
  })

  it('keeps a stored item in its own unit system (L5)', () => {
    const inch = { ...defaultToolValues('inch'), name: 'Flat 1/4' }
    const input = commandInput(inch, { units: 'mm', base: inch })
    expect(input.units).toBe('inch')
    expect(input.values).toMatchObject({ diameter: '1/4' })
    // a field edited in the mm window is written with its unit
    const edited: typeof inch = { ...inch, fluteLength: qdto('length', '20', 'mm') }
    expect(commandInput(edited, { units: 'mm', base: inch }).values).toMatchObject({
      fluteLength: '20 mm',
    })
  })

  it('shows another unit system’s bare source with its unit', () => {
    const d = qdto('length', '1/4', 'inch')
    expect(displayQuantity(d, 'mm')?.source).toBe('1/4 in')
    expect(displayQuantity(d, 'inch')?.source).toBe('1/4')
    expect(quantityText(d)).toBe('1/4"')
    expect(quantityText(qdto('length', '6', 'mm'))).toBe('6 mm')
    expect(quantityText(qdto('length', '6 mm', 'inch'))).toBe('6 mm')
  })

  it('names a copy and derives the chip load', () => {
    expect(copyName('Flat 6')).toBe('Flat 6 copy')
    const p = {
      spindleSpeed: qdto('spindleSpeed', '10000', 'mm'),
      feedRate: qdto('feedRate', '1000', 'mm'),
    }
    expect(chipLoad(p, qdto('scalar', '2', 'mm'), 'mm')).toBe('0.050 mm')
    expect(chipLoad(p, qdto('scalar', '2', 'mm'), 'inch')).toBe('0.0020"')
  })

  it('maps issues below `values` to fields; the rest is unmatched', () => {
    const issues = [
      { path: ['values', 'travel', 'x'], rule: 'positive', message: 'must be > 0' },
      { path: ['values', 'spindle', 'minSpeed'], rule: 'lt', message: 'below max' },
      { path: ['values'], rule: 'x', message: 'other' },
    ]
    expect(issuesAt(issues, 'travel.x')).toHaveLength(1)
    expect(issuesAt(issues, 'travel.y')).toHaveLength(0)
    expect(issuesAt(issues, 'spindle.minSpeed')).toHaveLength(1)
    expect(unmatchedIssues(issues, ['travel.x', 'spindle.minSpeed'])).toEqual([issues[2]])
  })
})
