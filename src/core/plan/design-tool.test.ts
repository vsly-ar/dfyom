// Library tools matching the design's generalized tool. Doc: docs/modes/plan-v0.2.md
// #tool-resolution-from-the-design-tool-field; chamfer mills: docs/modes/design-v0.4.md (C1)
import { describe, expect, it } from 'vitest'
import { parseWith } from '../../shared/parse'
import { expectOk } from '../../shared/testing/result'
import { deg, flatEndMillValues, len } from '../library/library.fixture'
import { Tool } from '../library/tool'
import { ToolValuesDtoSchema } from '../library/tool.dto'
import { matchesDesign, type PlanDesignTool } from './design-tool'

const tool = (over: Record<string, unknown>) =>
  expectOk(
    parseWith(
      ToolValuesDtoSchema,
      { ...flatEndMillValues(), presets: [], ...over },
      'test',
    ).andThen((d) => Tool.fromDTO(d)),
  )

const design = (over: Partial<PlanDesignTool>): PlanDesignTool => ({
  kind: 'generalized',
  locked: true,
  type: 'chamferMill',
  diameter: 12,
  angle: 90,
  label: '90° chamfer mill Ø12 mm',
  ...over,
})

describe('matchesDesign', () => {
  it('a chamfer mill matches type, diameter within 0.01 mm and angle within 0.5°', () => {
    const vbit = tool({ type: 'chamferMill', diameter: len('12'), angle: deg('90') })
    expect(matchesDesign(vbit, design({}))).toBe(true)
    expect(matchesDesign(vbit, design({ angle: 90.4 }))).toBe(true)
    expect(matchesDesign(vbit, design({ angle: 82 }))).toBe(false)
    expect(matchesDesign(vbit, design({ diameter: 6 }))).toBe(false)
    expect(matchesDesign(tool({ diameter: len('12') }), design({}))).toBe(false)
  })
})
