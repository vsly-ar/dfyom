import { describe, expect, it } from 'vitest'
import { parameterChecks, type DfmTool, type ParameterCheckOptions } from './dfm'
import type { DfmWarning, OperationGeometry, PartGeometryInput } from './model'
import { TEST_STOCK, testPart } from './testing/test-part'

type Op<K extends OperationGeometry['kind']> = Extract<OperationGeometry, { kind: K }>

const LIBRARY: readonly DfmTool[] = [
  { type: 'flatEndMill', diameter: 6 },
  { type: 'flatEndMill', diameter: 3 },
  { type: 'bullNoseEndMill', diameter: 6, cornerRadius: 1 },
  { type: 'ballEndMill', diameter: 4 },
  { type: 'drill', diameter: 6 },
  { type: 'drill', diameter: 5 },
]

const metric: ParameterCheckOptions = { tools: LIBRARY, unitSystem: 'metric' }

const run = (op: OperationGeometry, options: ParameterCheckOptions = metric): DfmWarning[] =>
  parameterChecks({ stock: TEST_STOCK, operations: [op] }, options)
const codes = (ws: readonly DfmWarning[]): string[] => ws.map((w) => w.code)

const facing = (depth: number): Op<'facing'> => ({ kind: 'facing', id: 'facing1', depth })

const pocket = (over: Partial<Op<'pocket'>> = {}): Op<'pocket'> => ({
  kind: 'pocket',
  id: 'pocket1',
  onZ: 0,
  shape: {
    center: [50, 30],
    contour: { kind: 'rectangle', length: 40, width: 25, cornerRadius: 4 },
  },
  depth: 8,
  floorRadius: 0,
  ...over,
})
const rect = (length: number, width: number, cornerRadius: number) => ({
  center: [50, 30] as const,
  contour: { kind: 'rectangle' as const, length, width, cornerRadius },
})

const drill = (over: Partial<Op<'drilling'>> = {}): Op<'drilling'> => ({
  kind: 'drilling',
  id: 'drill1',
  onZ: 0,
  center: [20, 20],
  diameter: 6,
  bottom: { kind: 'flat', depth: 10 },
  ...over,
})

const profile = (over: Partial<Op<'profile'>> = {}): Op<'profile'> => ({
  kind: 'profile',
  id: 'profile1',
  shape: rect(84, 44, 5),
  side: 'outside',
  slotWidth: 6,
  tabs: { count: 4, width: 8, thickness: 3 },
  ...over,
})

describe('parameterChecks', () => {
  it('finds nothing on the test part with a fitting library', () => {
    expect(parameterChecks(testPart(), metric)).toEqual([])
    // bull-nose R2 for the test part's floor fillet
    const fillet = testPart({ floorRadius: 2 })
    expect(
      parameterChecks(fillet, {
        ...metric,
        tools: [...LIBRARY, { type: 'bullNoseEndMill', diameter: 6, cornerRadius: 2 }],
      }),
    ).toEqual([])
  })

  it('facing: depth over 3 mm (metric) or 1/8″ (inch)', () => {
    expect(codes(run(facing(3)))).toEqual([])
    const [w] = run(facing(3.1))
    expect(w).toMatchObject({
      code: 'dfm.facingDeep',
      severity: 'info',
      operation: 'facing1',
      parameter: 'depth',
      suggestion: { relation: 'atMost', value: 3 },
    })
    expect(codes(run(facing(3.1), { ...metric, unitSystem: 'inch' }))).toEqual([])
    expect(codes(run(facing(3.2), { ...metric, unitSystem: 'inch' }))).toEqual(['dfm.facingDeep'])
  })

  it('pocket: no tool fits the narrowest size', () => {
    expect(codes(run(pocket({ shape: rect(10, 3, 1.5), depth: 2 })))).toEqual([])
    const ws = run(pocket({ shape: rect(10, 2.9, 1.45), depth: 2 }))
    expect(ws.find((w) => w.code === 'dfm.pocketNoToolFits')).toMatchObject({
      parameter: 'shape',
      suggestion: { relation: 'atLeast', value: 3 },
    })
    // circle: its diameter is the narrowest size
    const circle = { center: [50, 30] as const, contour: { kind: 'circle' as const, radius: 1.4 } }
    expect(codes(run(pocket({ shape: circle, depth: 2 })))).toContain('dfm.pocketNoToolFits')
  })

  it('pocket: deep and narrow (depth > 4 × narrowest size)', () => {
    expect(codes(run(pocket({ shape: rect(20, 4, 2), depth: 16 })))).toEqual([])
    expect(run(pocket({ shape: rect(20, 4, 2), depth: 16.5 }))).toEqual([
      expect.objectContaining({
        code: 'dfm.pocketDeepNarrow',
        parameter: 'depth',
        suggestion: { relation: 'atMost', value: 16 },
      }),
    ])
  })

  it('pocket: corner radius below the smallest end-mill radius; 0 always warns', () => {
    expect(codes(run(pocket({ shape: rect(40, 25, 1.5) })))).toEqual([])
    expect(run(pocket({ shape: rect(40, 25, 1.4) }))).toEqual([
      expect.objectContaining({
        code: 'dfm.cornerTooSmall',
        parameter: 'shape.cornerRadius',
        suggestion: { relation: 'atLeast', value: 1.5 },
      }),
    ])
    expect(run(pocket({ shape: rect(40, 25, 0) }))).toEqual([
      expect.objectContaining({
        code: 'dfm.cornerSharp',
        suggestion: { relation: 'atLeast', value: 1.5 },
      }),
    ])
    // empty library: only the geometric rule
    const empty = { ...metric, tools: [] }
    expect(codes(run(pocket({ shape: rect(40, 25, 0.1) }), empty))).toEqual([])
    const [sharp, ...rest] = run(pocket({ shape: rect(40, 25, 0) }), empty)
    expect(rest).toEqual([])
    expect(sharp!.code).toBe('dfm.cornerSharp')
    expect(sharp).not.toHaveProperty('suggestion')
  })

  it('pocket: floor radius without a matching bull-nose or a small enough ball end mill', () => {
    // bull-nose RE 1 matches f = 1; ball R2 fits f ≥ 2
    expect(codes(run(pocket({ floorRadius: 1 })))).toEqual([])
    expect(codes(run(pocket({ floorRadius: 1.005 })))).toEqual([]) // within 0.01 mm
    expect(codes(run(pocket({ floorRadius: 2.5 })))).toEqual([])
    expect(run(pocket({ floorRadius: 1.5 }))).toEqual([
      expect.objectContaining({ code: 'dfm.floorRadiusNoTool', parameter: 'floorRadius' }),
    ])
    expect(codes(run(pocket({ floorRadius: 1.5 }), { ...metric, tools: [] }))).toEqual([])
  })

  it('drilling: hole partly outside the stock', () => {
    expect(codes(run(drill({ center: [3, 3] })))).toEqual([])
    expect(run(drill({ center: [2.9, 30] }))).toEqual([
      expect.objectContaining({ code: 'dfm.holeOutsideStock', parameter: 'center' }),
    ])
    expect(codes(run(drill({ center: [30, 58] })))).toEqual(['dfm.holeOutsideStock'])
  })

  it('drilling: no drill of the diameter and no end mill smaller than it', () => {
    expect(codes(run(drill({ diameter: 5.005 })))).toEqual([]) // drill Ø5 within 0.01 mm
    expect(codes(run(drill({ diameter: 3.5 })))).toEqual([]) // Ø3 end mill, helical boring
    expect(codes(run(drill({ diameter: 3 })))).toEqual(['dfm.holeNoTool'])
    // drillPoint needs a drill: helical boring makes no point
    expect(
      codes(
        run(drill({ diameter: 3.5, bottom: { kind: 'drillPoint', depth: 5, pointAngle: 118 } })),
      ),
    ).toEqual(['dfm.holeNoTool'])
    expect(codes(run(drill({ diameter: 3 }), { ...metric, tools: [] }))).toEqual([])
  })

  it('drilling: depth over 5 × diameter (through holes: the material below `on`)', () => {
    expect(codes(run(drill({ bottom: { kind: 'flat', depth: 30 } })))).toEqual([])
    expect(run(drill({ bottom: { kind: 'flat', depth: 30.5 } }))).toEqual([
      expect.objectContaining({
        code: 'dfm.holeDeep',
        severity: 'info',
        parameter: 'depth',
        suggestion: { relation: 'atMost', value: 30 },
      }),
    ])
    expect(codes(run(drill({ diameter: 5, bottom: { kind: 'through' } })))).toEqual([])
    expect(codes(run(drill({ diameter: 3.5, bottom: { kind: 'through' } })))).toEqual([
      'dfm.holeDeep',
    ])
  })

  it('profile: the slot leaves the stock on every side (stock margin < slot width)', () => {
    expect(codes(run(profile({ shape: rect(88, 48, 5) })))).toEqual([]) // margin 6
    expect(run(profile({ shape: rect(94, 54, 5) }))).toEqual([
      expect.objectContaining({
        code: 'dfm.slotLeavesStock',
        severity: 'warning',
        parameter: 'shape',
        params: expect.objectContaining({ margin: 3, slotWidth: 6 }),
      }),
    ])
  })

  it('profile: the slot leaves the stock on some sides only – the frame still holds', () => {
    // 60 × 56 in 100 × 60: front and back margins 2, left and right 20 (evaluates to 1 piece)
    expect(run(profile({ shape: rect(60, 56, 5) }))).toEqual([
      expect.objectContaining({
        code: 'dfm.slotOpensStock',
        severity: 'info',
        parameter: 'shape',
        params: expect.objectContaining({
          sides: ['stock.side[0]', 'stock.side[2]'],
          slotWidth: 6,
        }),
      }),
      // the front and back tabs move to the left and right sides (TB1)
      expect.objectContaining({
        code: 'dfm.tabsRelocated',
        severity: 'info',
        parameter: 'tabs.count',
        params: expect.objectContaining({ moved: 2, count: 4 }),
      }),
    ])
    // three sides short: still held by the fourth
    const three = run(profile({ shape: { ...rect(94, 56, 5), center: [53, 30] } }))
    expect(codes(three)).toEqual(['dfm.slotOpensStock', 'dfm.tabsRelocated'])
    // all four tabs fit on the held left side (94 × 56 R5: 46 mm of straight wall)
    expect(three[1]!.params['moved']).toBe(3)
    expect(three[0]!.params['sides']).toEqual(['stock.side[0]', 'stock.side[1]', 'stock.side[2]'])
    // inside profiles cut an opening inside the part: no margin rule
    expect(codes(run(profile({ side: 'inside', shape: rect(94, 54, 5) })))).toEqual([])
  })

  it('profile inside: the pocket corner check', () => {
    expect(codes(run(profile({ side: 'inside', shape: rect(40, 30, 0) })))).toEqual([
      'dfm.cornerSharp',
    ])
    expect(codes(run(profile({ side: 'inside', shape: rect(40, 30, 1) })))).toEqual([
      'dfm.cornerTooSmall',
    ])
    // outside profiles have convex corners: any tool makes them
    expect(codes(run(profile({ shape: rect(84, 44, 0) })))).toEqual([])
  })

  it('profile: slot narrower than the smallest end mill', () => {
    expect(codes(run(profile({ slotWidth: 3 })))).toEqual([])
    expect(run(profile({ slotWidth: 2.5 }))).toEqual([
      expect.objectContaining({
        code: 'dfm.slotNoTool',
        parameter: 'slotWidth',
        suggestion: { relation: 'atLeast', value: 3 },
      }),
    ])
  })

  it('profile: tabs thinner or narrower than 1 mm (metric) or 1/32″ (inch)', () => {
    const tabs = (thickness: number, width: number) =>
      profile({ tabs: { count: 4, width, thickness } })
    expect(codes(run(tabs(1, 1)))).toEqual([])
    expect(run(tabs(0.9, 8))).toEqual([
      expect.objectContaining({
        code: 'dfm.tabsThin',
        severity: 'warning',
        parameter: 'tabs.thickness',
        suggestion: { relation: 'atLeast', value: 1 },
      }),
    ])
    expect(run(tabs(3, 0.001))).toEqual([
      expect.objectContaining({ code: 'dfm.tabsThin', parameter: 'tabs.width' }),
    ])
    const inch = { ...metric, unitSystem: 'inch' as const }
    expect(codes(run(tabs(0.8, 8), inch))).toEqual([])
    expect(codes(run(tabs(0.79, 8), inch))).toEqual(['dfm.tabsThin'])
    // no tabs built: nothing to check
    expect(codes(run(profile({ tabs: { count: 0, width: 0.5, thickness: 0.5 } })))).toEqual([
      'dfm.tabsNone',
    ])
  })

  it('uses the tool match tolerance (0.01 mm) in every end-mill size rule', () => {
    // pocket narrowest size 2.995 with a Ø3 end mill: fits within the tolerance
    expect(codes(run(pocket({ shape: rect(10, 2.995, 1.4975), depth: 2 })))).toEqual([])
    expect(codes(run(pocket({ shape: rect(40, 25, 1.495) })))).toEqual([])
    expect(codes(run(pocket({ shape: rect(40, 25, 1.485) })))).toEqual(['dfm.cornerTooSmall'])
    expect(codes(run(profile({ slotWidth: 2.995 })))).toEqual([])
    expect(codes(run(profile({ slotWidth: 2.985 })))).toEqual(['dfm.slotNoTool'])
    // helical boring needs an end mill smaller than the hole by more than the tolerance
    const flats: readonly DfmTool[] = [{ type: 'flatEndMill', diameter: 3 }]
    const only3 = { ...metric, tools: flats }
    expect(codes(run(drill({ diameter: 3.005 }), only3))).toEqual(['dfm.holeNoTool'])
    expect(codes(run(drill({ diameter: 3.02 }), only3))).toEqual([])
  })

  it('drilling: a flat bottom by helical boring needs a flat end mill; through takes any', () => {
    const rounded = {
      ...metric,
      tools: [
        { type: 'ballEndMill', diameter: 4 },
        { type: 'bullNoseEndMill', diameter: 4, cornerRadius: 0.5 },
      ] as const,
    }
    expect(codes(run(drill({ diameter: 5 }), rounded))).toEqual(['dfm.holeNoTool'])
    expect(codes(run(drill({ diameter: 5, bottom: { kind: 'through' } }), rounded))).toEqual([])
  })

  it('profile: no tabs – the piece comes loose', () => {
    expect(run(profile({ tabs: { count: 0, width: 8, thickness: 3 } }))).toEqual([
      expect.objectContaining({
        code: 'dfm.tabsNone',
        parameter: 'tabs.count',
        suggestion: { relation: 'atLeast', value: 1 },
      }),
    ])
  })

  it('profile inside: slot covers the opening – useless tabs', () => {
    const covering = profile({ side: 'inside', shape: rect(20, 10, 3), slotWidth: 6 })
    expect(run(covering)).toEqual([
      expect.objectContaining({
        code: 'dfm.tabsUnused',
        severity: 'info',
        parameter: 'tabs.count',
      }),
    ])
    // without tabs nothing is wrong: the opening is cut out completely, there is no offcut
    expect(codes(run({ ...covering, tabs: { count: 0, width: 8, thickness: 3 } }))).toEqual([])
    // within the chord tolerance counts as covering
    expect(codes(run({ ...covering, slotWidth: 4.995 }))).toEqual(['dfm.tabsUnused'])
    expect(codes(run({ ...covering, slotWidth: 4.9 }))).toEqual([])
  })

  it('names the operation in every warning and is pure', () => {
    const input: PartGeometryInput = {
      stock: TEST_STOCK,
      operations: [facing(4), pocket({ id: 'pocket7', shape: rect(40, 25, 0) })],
    }
    const ws = parameterChecks(input, metric)
    expect(ws.map((w) => w.operation)).toEqual(['facing1', 'pocket7'])
    expect(parameterChecks(input, metric)).toEqual(ws)
    for (const w of ws) expect(w.message).toContain(w.operation)
  })
})

describe('face access checks (design-v0.2.md#dfm-access-checks)', () => {
  // a 12 mm board, 100 × 60: the right side face (+x) is 60 × 12, the extent along x is 100
  const board = { length: 100, width: 60, thickness: 12 }
  const checks = (ops: OperationGeometry[], options: ParameterCheckOptions = metric) =>
    parameterChecks({ stock: board, operations: ops }, options)

  it('dfm.holeOutsideStock uses the stock face rectangle of the direction', () => {
    // fits on the top (100 × 60), not on the 60 × 12 right side
    const onSide = drill({ direction: '+x', center: [30, 10], diameter: 5 })
    expect(codes(checks([onSide]))).toContain('dfm.holeOutsideStock')
    expect(codes(checks([drill({ direction: '+x', center: [30, 6], diameter: 5 })]))).not.toContain(
      'dfm.holeOutsideStock',
    )
    expect(codes(checks([drill({ center: [30, 10], diameter: 5 })]))).not.toContain(
      'dfm.holeOutsideStock',
    )
  })

  it('dfm.holeDeep: a through hole is as deep as the stock along n', () => {
    const through = { kind: 'through' } as const
    const side = checks([drill({ direction: '+x', center: [30, 6], diameter: 5, bottom: through })])
    expect(side.find((w) => w.code === 'dfm.holeDeep')?.params).toMatchObject({ depth: 100 })
    // on the top of the same board: 12 mm < 5 × 5
    expect(codes(checks([drill({ diameter: 5, bottom: through })]))).not.toContain('dfm.holeDeep')
  })

  it('slot margins are measured in the face rectangle; params.sides names the stock faces', () => {
    // a front profile (−y: u = +X, v = +Z, the face is 100 × 12): runs out at bottom and top
    const p = profile({
      direction: '-y',
      shape: { center: [50, 6], contour: rect(40, 10, 1).contour },
    })
    const w = checks([p]).find((x) => x.code === 'dfm.slotOpensStock')
    expect(w?.params['sides']).toEqual(['stock.bottom', 'stock.top'])
  })

  it('dfm.reach: deeper than every matching library tool reaches (none with a reach: skipped)', () => {
    const tools: DfmTool[] = [
      { type: 'flatEndMill', diameter: 6, reach: 20 },
      { type: 'flatEndMill', diameter: 3, reach: 12 },
      { type: 'drill', diameter: 5, reach: 40 },
    ]
    const opts = { tools, unitSystem: 'metric' } as const
    // a pocket 25 deep below a floor 5 down: 30 from the stock face > 20
    const deep = checks(
      [pocket({ direction: '+x', onZ: -5, depth: 25, shape: rect(10, 8, 4) })],
      opts,
    )
    expect(deep.find((w) => w.code === 'dfm.reach')).toMatchObject({
      parameter: 'depth',
      params: { depth: 30, reach: 20 },
    })
    const shallow = checks([pocket({ onZ: 0, depth: 10, shape: rect(10, 8, 4) })], opts)
    expect(codes(shallow)).not.toContain('dfm.reach')
    // a through hole on the right side: 100 deep > 40
    const hole = drill({
      direction: '+x',
      center: [30, 6],
      diameter: 5,
      bottom: { kind: 'through' },
    })
    expect(checks([hole], opts).find((w) => w.code === 'dfm.reach')).toMatchObject({
      parameter: 'on',
      params: { depth: 100, reach: 40 },
    })
    // a profile from the front: the stock extent along n (60) > 20
    const side = checks([profile({ direction: '-y', shape: rect(20, 6, 1) })], opts)
    expect(codes(side)).toContain('dfm.reach')
    // no reach known: skipped
    expect(codes(checks([hole]))).not.toContain('dfm.reach')
  })

  it('dfm.setups: more than one approach direction, on the first operation of the second', () => {
    const ops: OperationGeometry[] = [
      facing(0.5),
      drill({ id: 'drill1', direction: '+x', center: [30, 6], diameter: 5 }),
      pocket({ id: 'pocket1', direction: '-z' }),
      pocket({ id: 'pocket2' }),
    ]
    const w = checks(ops).filter((x) => x.code === 'dfm.setups')
    expect(w).toEqual([
      expect.objectContaining({
        severity: 'info',
        operation: 'drill1',
        parameter: 'on',
        params: { count: 3, directions: ['top', 'right', 'bottom'] },
      }),
    ])
    expect(codes(checks([facing(0.5), pocket()]))).not.toContain('dfm.setups')
  })
})
