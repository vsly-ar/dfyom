// Recommended presets on the plan machine (hardening DF139, slice A2): plan feeds resolution
// adapts a recommended preset down to the plan machine; other presets and entries warn as before.
// Spec: docs/architecture/feeds-speeds.md#recommended-presets-on-the-plan-machine-hardening-df139
import { describe, expect, it } from 'vitest'
import { parseWith } from '../../shared/parse'
import { None, Some } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { followRecommended } from '../feeds-speeds/preset'
import { machineLimits } from '../feeds-speeds/suggest'
import { testStock } from '../design/design.fixture'
import {
  deg,
  feed,
  len,
  libraryInput,
  machineValues,
  num,
  rpm,
  watt,
} from '../library/library.fixture'
import { Machine } from '../library/machine'
import { MachineValuesDtoSchema } from '../library/machine.dto'
import { Tool } from '../library/tool'
import { ToolValuesDtoSchema, type ToolValuesDTO } from '../library/tool.dto'
import { Quantity } from '../quantity/quantity'
import { feedFindings } from './checks'
import { resolveFeeds, type FeedsInput, type ResolvedFeed, type ResolvedFeeds } from './feeds'
import { flat6, planSetup } from './plan.fixture'

/** The X3 rerun's machine (research note F5): a 500 W spindle, Z max 1500 mm/min. */
const x3Machine = (): Machine =>
  expectOk(
    parseWith(
      MachineValuesDtoSchema,
      {
        ...machineValues(),
        name: 'X3 router',
        maxFeedRate: { x: feed('5000'), y: feed('5000'), z: feed('1500') },
        spindle: {
          control: 'manual',
          minSpeed: rpm('8000'),
          maxSpeed: rpm('24000'),
          power: watt('500'),
        },
      },
      'test',
    ).andThen((dto) => Machine.fromDTO(dto)),
  )

/** A carbide tool with one recommended hardwood preset, its values as the library stores them. */
function recommendedTool(values: object): Tool {
  const dto = expectOk(
    parseWith(
      ToolValuesDtoSchema,
      {
        kind: 'tool',
        fluteCount: num('2'),
        toolMaterial: 'carbide',
        presets: [
          {
            name: 'Hardwood',
            materialClass: 'hardwood',
            recommended: true,
            spindleSpeed: rpm('1'),
            feedRate: feed('1'),
            plungeRate: feed('1'),
          },
        ],
        ...values,
      },
      'test',
    ),
  )
  return expectOk(Tool.fromDTO(followRecommended(dto, 'mm').values as ToolValuesDTO))
}

/** The X3 library tools (research note § Phase 1). */
const x3Tools = () => ({
  flat6: recommendedTool({
    name: 'Flat 6 long',
    type: 'flatEndMill',
    diameter: len('6'),
    fluteLength: len('45'),
    overallLength: len('75'),
  }),
  flat2: recommendedTool({
    name: 'Flat 2',
    type: 'flatEndMill',
    diameter: len('2'),
    fluteLength: len('8'),
    overallLength: len('50'),
  }),
  chamfer82: recommendedTool({
    name: 'Chamfer 82',
    type: 'chamferMill',
    diameter: len('6.35'),
    angle: deg('82'),
    fluteLength: len('8'),
    overallLength: len('50'),
  }),
})

function x3Input(tool: Tool, over: Partial<FeedsInput> = {}): FeedsInput {
  return {
    kind: 'pocket',
    tool,
    preset: Some(tool.presets[0]!),
    overrides: {},
    materialClass: 'hardwood',
    machine: Some(machineLimits(x3Machine())),
    auto: false,
    ...over,
  }
}

const codes = (r: ResolvedFeeds) => r.warnings.map((w) => w.code)
const machineRules = (r: ResolvedFeeds) =>
  feedFindings(r, x3Machine()).map((f) => `${f.field}:${f.rule}`)
const q = (s: string) => expectOk(Quantity.parse(s, { kind: 'feedRate', defaultUnit: 'mm/min' }))

describe('resolveFeeds: recommended presets adapted to the plan machine (DF139 A2)', () => {
  it('Flat 6 pocket on the X3 machine: stepdown fitted to the power, no powerExceeded', () => {
    const t = x3Tools().flat6
    expect(t.presets[0]!.stepdown.unwrap().canonical).toBe(1.8)
    const r = resolveFeeds(x3Input(t))
    expect(r.fields.stepdown.unwrap()).toEqual({
      value: 1.6,
      unit: 'mm',
      source: 'preset',
      adapted: { from: 1.8, reason: 'power' },
    })
    expect(r.fields.feedRate.unwrap().adapted).toBeUndefined()
    expect(codes(r)).not.toContain('feeds.powerExceeded')
    expect(machineRules(r)).toEqual([])
  })

  it('Chamfer 82: plunge 2286 → 1500 (Z max), no plan.machine finding', () => {
    const t = x3Tools().chamfer82
    const r = resolveFeeds(x3Input(t, { kind: 'chamfer', chamferDepth: 1 }))
    expect(r.fields.plungeRate.unwrap()).toMatchObject({
      value: 1500,
      source: 'preset',
      adapted: { from: 2286, reason: 'maxFeedRateZ' },
    })
    expect(machineRules(r)).toEqual([])
    expect(codes(r)).not.toContain('feeds.powerExceeded')
  })

  it('an entered plunge of 2286 still warns; the other fields stay adapted', () => {
    const t = x3Tools().chamfer82
    const r = resolveFeeds(
      x3Input(t, { kind: 'chamfer', chamferDepth: 1, overrides: { plungeRate: q('2286') } }),
    )
    expect(r.fields.plungeRate.unwrap()).toEqual({
      value: 2286,
      unit: 'mm/min',
      source: 'override',
    })
    expect(machineRules(r)).toEqual(['plungeRate:maxFeedRate'])
  })

  it('a preset with the user’s own values is not adapted and warns (Q212)', () => {
    const t = x3Tools().flat6
    const own = expectOk(
      Tool.fromDTO({
        ...t.toDTO(),
        presets: t.toDTO().presets.map((p) => ({ ...p, recommended: false })),
      }),
    )
    const r = resolveFeeds(x3Input(own))
    expect(r.fields.stepdown.unwrap()).toEqual({ value: 1.8, unit: 'mm', source: 'preset' })
    expect(codes(r)).toContain('feeds.powerExceeded')
  })

  it('without a plan machine the stored values are used unchanged', () => {
    const t = x3Tools().flat6
    const r = resolveFeeds(x3Input(t, { machine: None }))
    expect(r.fields.stepdown.unwrap()).toEqual({ value: 1.8, unit: 'mm', source: 'preset' })
  })

  it('an entered stepdown replaces the adapted one and the final-value check warns on it', () => {
    const t = x3Tools().flat6
    const ap = expectOk(Quantity.parse('1.8', { kind: 'length', defaultUnit: 'mm' }))
    const r = resolveFeeds(x3Input(t, { overrides: { stepdown: ap } }))
    expect(r.fields.stepdown.unwrap().source).toBe('override')
    const w = r.warnings.find((x) => x.code === 'feeds.powerExceeded')
    expect(w?.message).toBe('Cutting power exceeds the spindle: reduce stepdown, stepover or feed.')
  })

  it('power above the budget at the chip-load floor keeps a warning that says so', () => {
    const t = x3Tools().chamfer82
    // the X3 countersink's depth (Ø4.861 with the 82° tool) cut as a contour, F6 at the feed rate
    // (the X3 countersink itself is plunged: F12 at the plunge rate, DF141, § X3 recheck)
    const depth = 4.861 / 2 / Math.tan((41 * Math.PI) / 180)
    const r = resolveFeeds(x3Input(t, { kind: 'chamfer', chamferDepth: depth }))
    expect(r.fields.feedRate.unwrap()).toMatchObject({
      value: 2744,
      adapted: { from: 4572, reason: 'power' },
    })
    const w = r.warnings.filter((x) => x.code === 'feeds.powerExceeded')
    expect(w.map((x) => x.message)).toEqual([
      'Cutting power exceeds the spindle even with the preset adapted: use a smaller tool or a shallower cut.',
    ])
  })

  it('inch projects round adapted values to 0.1 in/min and 0.001 in', () => {
    const t = x3Tools().flat6
    const r = resolveFeeds(x3Input(t, { units: 'inch' }))
    const ap = r.fields.stepdown.unwrap().value / 25.4
    expect(Math.abs(ap * 1000 - Math.round(ap * 1000))).toBeLessThan(1e-6)
    expect(codes(r)).not.toContain('feeds.powerExceeded')
  })
})

describe('plan commands: adapted recommended presets (DF139 A2)', () => {
  async function x3Plan() {
    const s = await planSetup({
      stock: {
        ...testStock(),
        name: 'Maple block',
        material: { name: 'Hard maple', class: 'hardwood' },
      },
    })
    const item = s.query('library.tool.get', { id: s.tools.flat6 }) as { revision: number }
    await s.run('library.tool.update', {
      id: s.tools.flat6,
      revision: item.revision,
      values: {
        ...libraryInput(flat6()),
        presets: [
          {
            name: 'Hardwood',
            materialClass: 'hardwood',
            recommended: true,
            spindleSpeed: '1',
            feedRate: '1',
            plungeRate: '1',
          },
        ],
      },
    })
    const { kind: _, ...m } = x3Machine().toDTO()
    const machine = (await s.run('library.machine.add', { values: libraryInput(m) })) as {
      id: string
    }
    const planId = await s.create({ machineLibraryItemId: machine.id })
    // the design took its tool copy before the preset changed: re-import it
    const copy = s.plan(planId).snapshots.find((x) => x.libraryItemId === s.tools.flat6)!
    await s.run('plan.libraryItem.update', { planId, snapshotId: copy.id })
    return { s, planId }
  }

  it('plan.operation.list and feeds.get give adapted fields; no F5 warnings from them', async () => {
    const { s, planId } = await x3Plan()
    const list = s.query('plan.operation.list', { planId }) as {
      operations: {
        id: string
        kind: string
        presetName: string | null
        feeds: Record<string, { value: number; source: string; adapted?: object } | null>
      }[]
    }
    const recommended = list.operations.filter((o) => o.presetName === 'Hardwood')
    const profile = recommended.find((o) => o.kind === 'profile')!
    expect(profile.feeds['stepdown']).toMatchObject({
      value: 1.6,
      source: 'preset',
      adapted: { from: 1.8, reason: 'power' },
    })
    expect(profile.feeds['spindleSpeed']).not.toHaveProperty('adapted')
    const explained = s.query('plan.operation.feeds.get', {
      planId,
      planOperationId: profile.id,
    }) as { fields: Record<string, { adapted?: object } | null> }
    expect(explained.fields['stepdown']?.adapted).toEqual({ from: 1.8, reason: 'power' })
    const warnings = (
      s.query('plan.warning.list', { planId }) as {
        warnings: { code: string; rule?: string; planOperationId?: string }[]
      }
    ).warnings
    const ids = new Set(recommended.map((o) => o.id))
    const f5 = warnings.filter(
      (w) =>
        ids.has(w.planOperationId ?? '') &&
        (w.code === 'feeds.powerExceeded' || w.rule === 'maxFeedRate'),
    )
    expect(f5).toEqual([])
  })
})

describe('X3 recheck: the rerun plan’s feeds on the X3 machine (DF139 A4, research note F5)', () => {
  // The seven operations of the X3 rerun (research note § Phase 2): Bottom facing, two partial
  // outside profiles, drilling ×4 (Flat 2, helix) and countersinks ×4 (Chamfer 82); Top cavity
  // pocket and outline profile. Clones share their operation's feeds, so one input per operation.
  const countersinkDepth = 4.861 / 2 / Math.tan((41 * Math.PI) / 180)
  const ops = (): Record<string, FeedsInput> => {
    const t = x3Tools()
    return {
      facing: x3Input(t.flat6, { kind: 'facing', facingDepth: 1 }),
      partialProfile1: x3Input(t.flat6, { kind: 'profile' }),
      partialProfile2: x3Input(t.flat6, { kind: 'profile' }),
      drilling: x3Input(t.flat2, { kind: 'drilling' }),
      // plunged (DC 6.35 covers Ø4.861, the tip in the Ø2.447 hole): F12 (DF141)
      countersink: x3Input(t.chamfer82, {
        kind: 'chamfer',
        chamferDepth: countersinkDepth,
        chamferPlunge: { edgeDiameter: 2.447 },
      }),
      cavity: x3Input(t.flat6, { kind: 'pocket' }),
      outline: x3Input(t.flat6, { kind: 'profile' }),
    }
  }
  /** The same input with the preset's values as the user's own: the rerun's resolution. */
  const unadapted = (i: FeedsInput): FeedsInput => {
    const own = expectOk(
      Tool.fromDTO({
        ...i.tool.toDTO(),
        presets: i.tool.toDTO().presets.map((p) => ({ ...p, recommended: false })),
      }),
    )
    return { ...i, tool: own, preset: Some(own.presets[0]!) }
  }
  const findings = (r: ResolvedFeeds) => [
    ...r.warnings.filter((w) => w.severity === 'warning').map((w) => w.code),
    ...machineRules(r).map((m) => `plan.machine ${m}`),
  ]
  const perOp = <T>(f: (r: ResolvedFeeds) => T, adapt: boolean) =>
    Object.fromEntries(
      Object.entries(ops()).map(([k, i]) => [k, f(resolveFeeds(adapt ? i : unadapted(i)))]),
    )

  it('before: the rerun’s findings (powerExceeded on 5 operations, the chamfer plunge)', () => {
    expect(perOp(findings, false)).toEqual({
      facing: [],
      partialProfile1: ['feeds.powerExceeded'],
      partialProfile2: ['feeds.powerExceeded'],
      drilling: [],
      countersink: ['feeds.powerExceeded', 'plan.machine plungeRate:maxFeedRate'],
      cavity: ['feeds.powerExceeded'],
      outline: ['feeds.powerExceeded'],
    })
  })

  it('after: no F5 entries; the countersink plunge at 1500 mm/min needs 0.24 kW (F12, DF141)', () => {
    expect(perOp(findings, true)).toEqual({
      facing: [],
      partialProfile1: [],
      partialProfile2: [],
      drilling: [],
      countersink: [],
      cavity: [],
      outline: [],
    })
    // π/4 · (4.861² − 2.447²) · 1500 = 20 783 mm³/min · 0.6825 / 60 000 = 0.236 kW of 0.3 kW;
    // before DF141 the F6 rectangle at the feed rate (never used by a plunge) asked 0.427 kW
    const used = resolveFeeds(ops()['countersink']!).used.unwrap()
    expect(used.Q.unwrap()).toBeCloseTo(20_783.4, 0)
    expect(used.Pc.unwrap()).toBeCloseTo(0.2364, 4)
  })

  it('the rerun’s own countersink values warn on the plunge rate (0.36 kW at 2286 mm/min)', () => {
    const r = resolveFeeds(unadapted(ops()['countersink']!))
    const w = r.warnings.filter((x) => x.code === 'feeds.powerExceeded')
    expect(w.map((x) => x.field)).toEqual(['plungeRate'])
    expect(w[0]!.params['cuttingPower']).toBeCloseTo(0.3603, 4)
  })

  it('after: the adapted values only lower the stored ones', () => {
    const adapted = perOp(
      (r) =>
        r.applicable.flatMap((f) => {
          const v = r.fields[f].mapOr<ResolvedFeed | undefined>(undefined, (x) => x)
          if (v?.adapted === undefined) return []
          expect(v.value).toBeLessThan(v.adapted.from)
          return [`${f} ${v.adapted.from} → ${v.value} (${v.adapted.reason})`]
        }),
      true,
    )
    expect(adapted).toEqual({
      facing: [],
      partialProfile1: ['stepdown 1.8 → 1.6 (power)'],
      partialProfile2: ['stepdown 1.8 → 1.6 (power)'],
      drilling: [],
      countersink: ['plungeRate 2286 → 1500 (maxFeedRateZ)'],
      cavity: ['stepdown 1.8 → 1.6 (power)'],
      outline: ['stepdown 1.8 → 1.6 (power)'],
    })
  })
})
