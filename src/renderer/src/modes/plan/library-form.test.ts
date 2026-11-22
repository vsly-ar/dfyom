// The "New tool" / "New machine" form helpers: the defaults of both unit systems are valid
// library items (core models), per-type fields are sent only for their type, and a command
// error's issues map to form fields. Doc: docs/conventions/ui.md#plan-mode-task-37
import { describe, expect, it } from 'vitest'
import { valuesFromDTO, type ItemValuesDTO } from '../../../../core/library/library-item'
import { MachineValuesDtoSchema } from '../../../../core/library/machine.dto'
import { TOOL_TYPES, ToolValuesDtoSchema } from '../../../../core/library/tool.dto'
import { valuesFromInput, valuesInputSchema } from '../../../../core/library/values-input'
import type { UnitSystem } from '../../../../core/project/document'
import {
  defaultMachineForm,
  defaultToolForm,
  issuesAt,
  machineValues,
  toolName,
  toolValues,
  unmatchedIssues,
} from './library-form'

/** As `library.<kind>.add` reads its input: shape, quantity strings in `units`, the model. */
const valid = (kind: 'tool' | 'machine', values: object, units: UnitSystem) => {
  const schema =
    kind === 'tool'
      ? ToolValuesDtoSchema.omit({ kind: true })
      : MachineValuesDtoSchema.omit({ kind: true })
  const input = valuesInputSchema(schema).parse(values)
  const r = valuesFromInput(schema, input, units, ['values']).andThen((v) =>
    valuesFromDTO({ ...(v as object), kind } as ItemValuesDTO),
  )
  if (r.isErr()) throw r.unwrapErr()
}

describe('library forms', () => {
  it.each(['mm', 'inch'] as const)('defaults are valid items (%s)', (units) => {
    for (const type of TOOL_TYPES)
      valid('tool', toolValues({ ...defaultToolForm(units), type }), units)
    valid('machine', machineValues(defaultMachineForm(units)), units)
  })

  it('suggests a drill for a drilling and names the tool by type and diameter', () => {
    const f = defaultToolForm('inch', 'drilling')
    expect(f.type).toBe('drill')
    expect(toolName(f)).toBe('Drill 1/4')
    expect(toolValues(f)).toMatchObject({ name: 'Drill 1/4', pointAngle: '118' })
    expect(toolValues(f)).not.toHaveProperty('cornerRadius')
    const bull = toolValues({ ...defaultToolForm('mm'), type: 'bullNoseEndMill', name: ' B ' })
    expect(bull).toMatchObject({ name: 'B', cornerRadius: '1' })
    expect(bull).not.toHaveProperty('pointAngle')
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
