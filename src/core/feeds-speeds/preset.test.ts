import { describe, expect, it } from 'vitest'
import { None } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { flatEndMillValues, rpm } from '../library/library.fixture'
import { Tool } from '../library/tool'
import type { ToolValuesDTO } from '../library/tool.dto'
import { followRecommended, presetRecommendation } from './preset'
import { suggestCutting } from './suggest'

const values = (recommended?: boolean): ToolValuesDTO => {
  const v = { ...flatEndMillValues(), toolMaterial: 'carbide' } as ToolValuesDTO
  return {
    ...v,
    presets: v.presets.map((p) => (recommended === undefined ? p : { ...p, recommended })),
  }
}
const tool = () => expectOk(Tool.fromDTO({ ...values(), presets: [] }))

describe('presetRecommendation', () => {
  it('is the calculator for a full-width slot on no particular machine', () => {
    const r = presetRecommendation(tool(), 'aluminum').unwrap()
    const s = suggestCutting({
      tool: tool(),
      materialClass: 'aluminum',
      engagement: { kind: 'slot' },
      machine: None,
    })
    expect(r.spindleSpeed).toBe(s.spindleSpeed.unwrap().value)
    expect(r.feedRate).toBe(s.feedRate.unwrap().value)
    expect(r.plungeRate).toBe(s.plungeRate.unwrap().value)
    expect(r.stepdown).toBe(s.stepdown.unwrap().value)
  })

  it('without data: the calculator reason', () => {
    const r = presetRecommendation(tool(), 'aluminum', [])
    expect(r.isErr() && r.unwrapErr().length > 0).toBe(true)
  })
})

describe('followRecommended', () => {
  it('leaves values without a recommended preset untouched (same object)', () => {
    const v = values(false)
    expect(followRecommended(v, 'mm').values).toBe(v)
  })

  it('rewrites speed, feed, plunge and stepdown, rounded; keeps stepover and name', () => {
    const { values: out, issues } = followRecommended(values(true), 'mm')
    expect(issues).toEqual([])
    const p = out.presets[0]!
    const r = presetRecommendation(tool(), 'aluminum').unwrap()
    expect(p.spindleSpeed.source).toBe(`${Math.round(r.spindleSpeed!)} rpm`)
    expect(p.feedRate.source).toBe(`${Math.round(r.feedRate!)} mm/min`)
    expect(p.stepdown?.source).toBe(`${Math.round(r.stepdown! * 100) / 100} mm`)
    expect(p.stepover).toEqual(values().presets[0]!.stepover)
    expect(p.name).toBe('Alu finish')
    expect(p.recommended).toBe(true)
    // following again changes nothing
    expect(followRecommended(out, 'mm').values).toBe(out)
  })

  it('writes inch units in an inch unit system', () => {
    const p = followRecommended(values(true), 'inch').values.presets[0]!
    expect(p.feedRate.source).toMatch(/^\d+(\.\d)? in\/min$/)
    expect(p.stepdown?.source).toMatch(/^\d+(\.\d{1,3})? in$/)
  })

  it('a class without data is a noRecommendation issue; the preset keeps its values', () => {
    const v = values(true)
    const { values: out, issues } = followRecommended(v, 'mm', [])
    expect(out).toBe(v)
    expect(issues.map((i) => [i.path.join('.'), i.rule])).toEqual([
      ['presets.0.recommended', 'noRecommendation'],
    ])
  })

  it('leaves a preset without a class (a model issue) and a tool that does not load alone', () => {
    const v = values(true)
    const { materialClass: _c, ...rest } = v.presets[0]!
    const noClass = { ...v, presets: [{ ...rest, spindleSpeed: rpm('1') }] }
    expect(followRecommended(noClass, 'mm').values).toBe(noClass)
    const bad = { ...v, fluteCount: { ...v.fluteCount, exact: { num: '0', den: '1' } } }
    expect(followRecommended(bad, 'mm').values).toBe(bad)
  })
})
