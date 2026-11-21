// Spec: docs/architecture/feeds-speeds.md#impossible-locks (task 3.14). Synthetic TEST_DATA.
import { describe, expect, it } from 'vitest'
import { parseWith } from '../../shared/parse'
import { None, Some, type Option } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { flatEndMillValues } from '../library/library.fixture'
import { Tool } from '../library/tool'
import { ToolValuesDtoSchema } from '../library/tool.dto'
import { TEST_DATA } from './data.fixture'
import { lockIssue, powerLockIssue, type LockLimits } from './locks'
import type { CuttingInput, LockedInputs, MachineLimits } from './suggest'

const tool = expectOk(
  parseWith(
    ToolValuesDtoSchema,
    { ...flatEndMillValues(), toolMaterial: 'carbide', presets: [] },
    'test',
  ).andThen((d) => Tool.fromDTO(d)),
)

const machine: Option<MachineLimits> = Some({
  minSpeed: 8000,
  maxSpeed: 18_000,
  maxFeedXY: 5000,
  maxFeedZ: 1000,
  power: Some(100),
  rigidity: 'extrusion',
})

const limits = (over: Partial<LockLimits> = {}): LockLimits => ({
  tool,
  machine,
  stickout: 15,
  drill: false,
  ...over,
})

const rule = (o: Option<{ rule: string }>) => o.mapOr(null, (i) => i.rule)

describe('lockIssue', () => {
  it('invalid: no value or not positive', () => {
    expect(rule(lockIssue('n', undefined, limits()))).toBe('invalid')
    expect(rule(lockIssue('vf', 0, limits()))).toBe('invalid')
    expect(lockIssue('vf', -1, limits()).unwrap().reason).toBe('Enter a valid value to lock it.')
  })

  it('spindleRange: outside the machine spindle range', () => {
    const above = lockIssue('n', 24_000, limits()).unwrap()
    expect(above.rule).toBe('spindleRange')
    expect(above.reason).toBe("24000 rpm is above this machine's 18000 rpm.")
    expect(rule(lockIssue('n', 5000, limits()))).toBe('spindleRange')
    expect(rule(lockIssue('n', 12_000, limits()))).toBeNull()
  })

  it('feedLimit: above the X/Y maximum (drilling with a drill: Z)', () => {
    expect(lockIssue('vf', 6000, limits()).unwrap().reason).toBe(
      "6000 mm/min is above this machine's 5000 mm/min (X/Y).",
    )
    expect(rule(lockIssue('vf', 2000, limits({ drill: true })))).toBe('feedLimit')
    expect(rule(lockIssue('vf', 2000, limits()))).toBeNull()
  })

  it('toolLength: deeper than the flute length or the stickout', () => {
    const flute = tool.fluteLength.canonical
    expect(lockIssue('ap', flute + 1, limits({ stickout: 100 })).unwrap().reason).toMatch(
      /deeper than the flute length/,
    )
    expect(lockIssue('ap', 16, limits({ stickout: 15 })).unwrap().reason).toMatch(/stickout/)
    expect(rule(lockIssue('ap', 2, limits()))).toBeNull()
  })

  it('stepoverAboveTool: facing stepover above D', () => {
    expect(rule(lockIssue('ae', 7, limits()))).toBe('stepoverAboveTool')
    expect(rule(lockIssue('ae', 5, limits()))).toBeNull()
  })

  it('without a machine only invalid, toolLength and stepoverAboveTool apply', () => {
    expect(rule(lockIssue('n', 99_000, limits({ machine: None })))).toBeNull()
    expect(rule(lockIssue('vf', 99_000, limits({ machine: None })))).toBeNull()
  })
})

describe('powerLockIssue', () => {
  const input = (locked: LockedInputs, over: Partial<CuttingInput> = {}) =>
    powerLockIssue(
      { tool, materialClass: 'aluminum', engagement: { kind: 'slot' }, machine, locked, ...over },
      TEST_DATA,
    )

  it('every F7 input locked and the cut needs more than the spindle: power', () => {
    const i = input({ n: 18_000, vf: 3000, ap: 5 }).unwrap()
    expect(i.rule).toBe('power')
    expect(i.reason).toMatch(/^With spindle speed, feed and stepdown locked the cut needs /)
  })

  it('something unlocked can absorb it, or the cut fits: no issue', () => {
    expect(rule(input({ n: 18_000, vf: 3000 }))).toBeNull()
    expect(rule(input({ vf: 3000, ap: 5 }))).toBeNull()
    expect(rule(input({ n: 18_000, vf: 100, ap: 0.1 }))).toBeNull()
    // facing also needs a locked stepover
    const facing = { engagement: { kind: 'stepover' as const, ae: 4.5 } }
    expect(rule(input({ n: 18_000, vf: 3000, ap: 5 }, facing))).toBeNull()
    expect(rule(input({ n: 18_000, vf: 3000, ap: 5, ae: 4.5 }, facing))).toBe('power')
  })

  it('skipped without spindle power', () => {
    const noPower = machine.map((m) => ({ ...m, power: None }))
    expect(rule(input({ n: 18_000, vf: 3000, ap: 5 }, { machine: noPower }))).toBeNull()
  })
})
