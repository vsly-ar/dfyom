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
  followDraft,
  followState,
  issuesAt,
  patchPreset,
  qdto,
  quantityText,
  taperedNotes,
  toolName,
  uniqueName,
  nameTaken,
  unmatchedIssues,
  withQuickOverall,
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

  it('keeps the quick dialog’s hidden overall length longer than stickout and flutes (DF26)', () => {
    const mm = defaultToolValues('mm')
    expect(withQuickOverall({ ...mm, stickout: qdto('length', '30', 'mm') }, 'mm')).toEqual({
      ...mm,
      stickout: qdto('length', '30', 'mm'),
    })
    const long = withQuickOverall({ ...mm, stickout: qdto('length', '55.2', 'mm') }, 'mm')
    expect(long.overallLength).toEqual(qdto('length', '66', 'mm'))
    valid('tool', commandInput(long, { units: 'mm', autoName: true }))
    const flutes = withQuickOverall({ ...mm, fluteLength: qdto('length', '60', 'mm') }, 'mm')
    expect(flutes.overallLength).toEqual(qdto('length', '70', 'mm'))
    const inch = defaultToolValues('inch')
    const i = withQuickOverall({ ...inch, stickout: qdto('length', '2', 'inch') }, 'inch')
    expect(i.overallLength).toEqual(qdto('length', '2.5', 'inch'))
    valid('tool', commandInput(i, { units: 'inch', autoName: true }))
  })

  it('makes a suggested name unique among the other items (DF47)', () => {
    expect(uniqueName('Flat 6', [])).toBe('Flat 6')
    expect(uniqueName('Flat 6', ['flat 6 ', 'Flat 6 (2)'])).toBe('Flat 6 (3)')
    expect(nameTaken(' FLAT 6', ['Flat 6'])).toBe(true)
    expect(nameTaken('', [''])).toBe(false)
    expect(uniqueName('x'.repeat(120), ['x'.repeat(120)])).toHaveLength(120)
    const d = defaultToolValues('mm')
    expect(toolName(d, ['Flat 6'])).toBe('Flat 6 (2)')
    expect(
      commandInput(d, { units: 'mm', autoName: true, taken: ['Flat 6'] }).values,
    ).toMatchObject({ name: 'Flat 6 (2)' })
    expect(copyName('Flat 6', ['Flat 6 copy'])).toBe('Flat 6 copy (2)')
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

  it.each(['mm', 'inch'] as const)(
    'a chamfer mill (U4): 90° default, slant flute length, named "Chamfer 90° Ø12" (%s)',
    (units) => {
      const d = defaultToolValues(units, 'chamfer')
      expect(d.type).toBe('chamferMill')
      expect(d.angle?.source).toBe('90')
      // Ø12 × 90°: slant 8.49 mm → 8.5 mm; Ø1/2" → 0.354" → 0.375"
      expect(d.fluteLength.source).toBe(units === 'mm' ? '8.5' : '0.375')
      expect(toolName(d)).toBe(units === 'mm' ? 'Chamfer 90° Ø12' : 'Chamfer 90° Ø1/2')
      const input = commandInput(d, { units, autoName: true })
      valid('tool', input)
      expect(input.values).toMatchObject({ angle: '90' })
      expect(input.values).not.toHaveProperty('pointAngle')
      expect(input.values).not.toHaveProperty('tipDiameter')
      // prefilled from a chamfer's generalized tool: its angle and diameter
      const p = defaultToolValues(units, 'chamfer', {
        type: 'chamferMill',
        diameter: qdto('length', '6', units),
        angle: qdto('angle', '60', units),
      })
      expect(toolName(p)).toBe('Chamfer 60° Ø6')
      expect(
        cleanValues(withToolType(defaultToolValues(units), 'drill', units)).values,
      ).not.toHaveProperty('angle')
    },
  )

  it('needs all three acceleration axes or none', () => {
    const m = defaultMachineValues('mm')
    const partial = { ...m, acceleration: { x: qdto('scalar', '500', 'mm') } }
    expect(issuesAt(draftIssues(partial), 'acceleration')).toHaveLength(1)
    expect(draftIssues(m)).toEqual([])
  })

  it('needs all three steps-per-mm axes or none; $11/$12 must be positive', () => {
    const m = defaultMachineValues('mm')
    const partial = { ...m, stepsPerMm: { z: qdto('scalar', '400', 'mm') } }
    expect(issuesAt(draftIssues(partial), 'stepsPerMm')).toHaveLength(1)
    const s = qdto('scalar', '40', 'mm')
    const full = {
      ...m,
      stepsPerMm: { x: s, y: s, z: s },
      junctionDeviation: qdto('length', '0', 'mm'),
      arcTolerance: qdto('length', '0.002', 'mm'),
    }
    expect(draftIssues(full).map((i) => [i.path.join('.'), i.rule])).toEqual([
      ['junctionDeviation', 'positive'],
    ])
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

describe('recommended presets (library.md#recommended-presets)', () => {
  const preset = {
    name: 'Alu',
    materialClass: 'aluminum' as const,
    spindleSpeed: qdto('spindleSpeed', '1000', 'mm'),
    feedRate: qdto('feedRate', '100', 'mm'),
    plungeRate: qdto('feedRate', '50', 'mm'),
  }
  const tool = (recommended?: boolean) => ({
    ...defaultToolValues('mm'),
    presets: [recommended === undefined ? preset : { ...preset, recommended }],
  })

  it('a draft follows the calculator; a stray corner radius of a flat does not stop it', () => {
    const followed = followDraft(tool(true), 'mm')
    expect(followed.presets[0]!.spindleSpeed.source).not.toBe('1000')
    expect(followDraft(tool(false), 'mm')).toEqual(tool(false))
  })

  it('can follow with a material class and calculator data only', () => {
    expect(followState(tool(), 'aluminum')).toEqual({ ok: true })
    expect(followState(tool(), undefined)).toMatchObject({ ok: false })
    const { toolMaterial: _m, ...noMaterial } = tool()
    expect(followState(noMaterial, 'aluminum')).toMatchObject({ ok: false })
  })

  it('typing another followed value drops the flag; the same value, stepover or the name keep it', () => {
    const p = { ...preset, recommended: true }
    expect(patchPreset(p, { spindleSpeed: qdto('spindleSpeed', '2000', 'mm') })).not.toHaveProperty(
      'recommended',
    )
    expect(
      patchPreset(p, { spindleSpeed: qdto('spindleSpeed', '1000 rpm', 'mm') }).recommended,
    ).toBe(true)
    expect(patchPreset(p, { stepover: qdto('length', '2', 'mm') }).recommended).toBe(true)
    expect(patchPreset(p, { name: 'B' }).recommended).toBe(true)
    expect(patchPreset(p, { recommended: undefined }).recommended).toBeUndefined()
  })
})

describe('tapered ball end mill (tapered-ball-nose.md § Library window, DF124 T3)', () => {
  const tapered = (units: UnitSystem) =>
    withToolType(defaultToolValues(units), 'taperedBallEndMill', units)
  const texts = (v: ReturnType<typeof tapered>, units: UnitSystem) =>
    Object.fromEntries(
      Object.entries(taperedNotes(v, units)).map(([k, ms]) => [k, ms.map((x) => x.text)]),
    )

  it('becomes a typical 1/8″ bit: R0.25 at 3.6° per side, its large end the shank, valid', () => {
    for (const units of ['mm', 'inch'] as const) {
      const v = tapered(units)
      expect(v.diameter).toEqual(v.shankDiameter)
      expect(draftIssues(v, true)).toEqual([])
    }
    expect(toolName(tapered('mm'))).toBe('Tapered ball R0.25 3.6°')
    expect(toolName(tapered('inch'))).toBe('Tapered ball R0.01 3.6°')
  })

  it('reads out the radius, the included angle and where the cone reaches the large end', () => {
    expect(texts(tapered('mm'), 'mm')).toEqual({
      tipDiameter: ['R 0.25 mm'],
      taperAngle: ['7.2° included'],
      // T3 follow-up: the groove width at 1 mm from the core's formula (doc example 0.60 mm)
      diameter: ['Cone reaches Ø 3.175 mm at 21.5 mm.', 'Cuts a groove 0.6 mm wide at 1 mm deep.'],
    })
    expect(texts(tapered('inch'), 'inch')).toMatchObject({
      tipDiameter: ['R 0.01"'],
      diameter: [expect.any(String), 'Cuts a groove 0.024" wide at 0.04" deep.'],
    })
    expect(taperedNotes(defaultToolValues('mm'), 'mm')).toEqual({})
  })

  it('hints (Q153, info, never an error) when the cone ends beyond 1.5 × or before ½ × the flutes', () => {
    const v = { ...tapered('mm'), taperAngle: qdto('angle', '1.8', 'mm') }
    const hint = taperedNotes(v, 'mm').fluteLength
    expect(hint).toEqual([
      {
        id: 'coneMismatch',
        severity: 'info',
        text: 'The cone reaches the large end at 42.8 mm, the flutes end at 20 mm: is 1.8° the angle per side?',
      },
    ])
    expect(draftIssues(v, true)).toEqual([])
    // under half: a 10° cone on 20 mm flutes reaches the shank at 7.6 mm
    const short = { ...tapered('mm'), taperAngle: qdto('angle', '10', 'mm') }
    expect(taperedNotes(short, 'mm').fluteLength?.[0]?.id).toBe('coneMismatch')
    // a tip as wide as the large end has no cone: no read-out (the field shows its error)
    const wide = { ...tapered('mm'), tipDiameter: qdto('length', '4', 'mm') }
    expect(taperedNotes(wide, 'mm')).not.toHaveProperty('diameter')
  })
})
