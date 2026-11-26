// DFM in waste (D4): corner, tool-fit and reach findings do not fire for cuts that lie only in the
// offcut or frame of a through profile on the same axis; corners on the part still warn.
// Doc: docs/modes/design-llm-first.md#dfm-in-waste
import { describe, expect, it } from 'vitest'
import {
  parameterChecks,
  type DfmTool,
  type OperationTool,
  type ParameterCheckOptions,
} from './dfm'
import { type Region } from './2d/model'
import { dumbbell, rect } from './2d/testing/fixtures'
import { nodeRegion2d } from './2d/testing/node-wasm'
import type { DfmWarning, OperationGeometry, StockGeometry, Vec2 } from './model'
import { frameMap } from './through-depth'
import { faceWaste } from './waste'

type Op<K extends OperationGeometry['kind']> = Extract<OperationGeometry, { kind: K }>

const port = nodeRegion2d()
const STOCK: StockGeometry = { length: 100, width: 60, thickness: 20 }
const flat = (diameter: number, more: Partial<DfmTool> = {}): DfmTool => ({
  type: 'flatEndMill',
  diameter,
  ...more,
})
const LIBRARY: readonly DfmTool[] = [flat(6), flat(3)]

const region = (...loops: Parameters<typeof port.normalise>[0]): Region =>
  port.normalise(loops).unwrap()
const at = (r: Region, center: Vec2) => ({
  center,
  contour: { kind: 'region' as const, region: r },
})
/** A sharp `w` × `h` box centred on the origin. */
const box = (w: number, h: number, r = 0) => region(rect(-w / 2, -h / 2, w, h, r))

const pocket = (center: Vec2, over: Partial<Op<'pocket'>> = {}): Op<'pocket'> => ({
  kind: 'pocket',
  id: 'pocket1',
  onZ: 0,
  shape: at(box(10, 10), center),
  depth: 5,
  floorRadius: 0,
  ...over,
})
/** The part's outline: a through outside profile of a 60 × 40 box (u 20–80, v 10–50). */
const outline = (over: Partial<Op<'profile'>> = {}): Op<'profile'> => ({
  kind: 'profile',
  id: 'outline',
  shape: at(box(60, 40, 5), [50, 30]),
  side: 'outside',
  slotWidth: 6,
  tabs: { count: 4, width: 8, thickness: 3 },
  ...over,
})
/** An opening: a through inside profile of a 30 × 20 box in the part's middle. */
const opening = (over: Partial<Op<'profile'>> = {}): Op<'profile'> => ({
  kind: 'profile',
  id: 'opening',
  shape: at(box(30, 20, 5), [50, 30]),
  side: 'inside',
  slotWidth: 6,
  tabs: { count: 2, width: 8, thickness: 3 },
  ...over,
})
const drill = (center: Vec2, over: Partial<Op<'drilling'>> = {}): Op<'drilling'> => ({
  kind: 'drilling',
  id: 'drill1',
  onZ: 0,
  center,
  diameter: 5,
  bottom: { kind: 'flat', depth: 15 },
  ...over,
})
const own = (op: OperationGeometry, tool: DfmTool): Record<string, OperationTool> => ({
  [op.id]: { tool, generalized: false, locked: false, label: `${tool.diameter} mm ${tool.type}` },
})
const run = (
  operations: OperationGeometry[],
  over: Partial<ParameterCheckOptions> = {},
): DfmWarning[] =>
  parameterChecks(
    { stock: STOCK, operations },
    { tools: LIBRARY, unitSystem: 'metric', region2d: port, ...over },
  )
/** Codes of the findings of operation `id` (without the setup count). */
const codesOf = (ws: readonly DfmWarning[], id = 'pocket1'): string[] =>
  ws.filter((w) => w.operation === id && w.code !== 'dfm.setups').map((w) => w.code)

describe('faceWaste', () => {
  it('is undefined without a through profile on the axis (blind, `on`, other axes)', () => {
    expect(faceWaste([pocket([50, 30])], '+z', STOCK, port)).toBeUndefined()
    expect(faceWaste([outline({ depth: 3 })], '+z', STOCK, port)).toBeUndefined()
    expect(faceWaste([outline({ side: 'on' })], '+z', STOCK, port)).toBeUndefined()
    expect(faceWaste([outline({ direction: '+x' })], '+z', STOCK, port)).toBeUndefined()
  })

  it('covers the frame and the slug by a clearance, not the part or its outline', () => {
    const w = faceWaste([outline(), opening()], '+z', STOCK, port)!
    expect(w.covers([5, 30], 0)).toBe(true)
    expect(w.covers([5, 30], 15)).toBe(true)
    expect(w.covers([5, 30], 16)).toBe(false)
    expect(w.covers([20, 30], 0)).toBe(false) // on the outline
    expect(w.covers([25, 30], 0)).toBe(false) // the part
    expect(w.covers([50, 30], 4)).toBe(true) // the slug
    expect(w.covers([50, 30], 11)).toBe(false) // reaches the part around the opening
    expect(w.holds(box(10, 10))).toBe(true) // about the origin: the frame
    expect(w.holds(region(rect(45, 25, 10, 10)))).toBe(true) // in the slug
    expect(w.holds(region(rect(15, 25, 10, 10)))).toBe(false) // straddles the outline
  })

  it('reads a profile of the opposite face through the stock', () => {
    const w = faceWaste([outline({ shape: at(box(60, 40), [40, 30]) })], '-z', STOCK, port)!
    const m = frameMap('+z', '-z', STOCK)
    expect(w.covers(m.at([5, 30]), 0)).toBe(true)
    expect(w.covers(m.at([85, 30]), 0)).toBe(true)
    expect(w.covers(m.at([40, 30]), 0)).toBe(false)
  })

  it('keeps a part cut out inside another part’s opening', () => {
    const inner = outline({ id: 'inner', shape: at(box(10, 6), [50, 30]) })
    const w = faceWaste([outline(), opening(), inner], '+z', STOCK, port)!
    expect(w.covers([50, 30], 0)).toBe(false)
    expect(w.covers([62, 30], 0)).toBe(true)
  })
})

describe('corners in waste', () => {
  it('cornerSharp: silent in the frame, warns on the part', () => {
    expect(codesOf(run([pocket([8, 30])]))).toEqual(Array(4).fill('dfm.cornerSharp'))
    expect(codesOf(run([outline(), pocket([8, 30])]))).toEqual([])
    expect(codesOf(run([outline(), pocket([50, 30])]))).toEqual(Array(4).fill('dfm.cornerSharp'))
  })

  it('cornerSharp: a pocket across the outline warns only for the corners on the part', () => {
    const ws = run([outline(), pocket([20, 30], { shape: at(box(20, 10), [20, 30]) })])
    expect(ws.filter((w) => w.operation === 'pocket1').map((w) => w.params['at'])).toEqual([
      [30, 25],
      [30, 35],
    ])
  })

  it('cornerSharp: silent in an opening’s slug, warns beside it', () => {
    expect(
      codesOf(run([outline(), opening(), pocket([50, 30], { shape: at(box(6, 6), [50, 30]) })])),
    ).toEqual([])
    expect(
      codesOf(run([outline(), opening(), pocket([27, 30], { shape: at(box(4, 4), [27, 30]) })])),
    ).toEqual(Array(4).fill('dfm.cornerSharp'))
  })

  it('cornerSharp: a pocket from the bottom in the frame of a top profile is silent', () => {
    const m = frameMap('+z', '-z', STOCK)
    const frame = m.at([8, 30])
    const part = m.at([50, 30])
    const bottom = (c: Vec2) => pocket(c, { direction: '-z', shape: at(box(10, 10), c) })
    expect(codesOf(run([outline(), bottom(frame)]))).toEqual([])
    expect(codesOf(run([outline(), bottom(part)]))).toEqual(Array(4).fill('dfm.cornerSharp'))
  })

  it('cornerTooSmall: silent in the frame, warns on the part', () => {
    const small = (c: Vec2) => pocket(c, { shape: at(box(10, 10, 1), c) })
    expect(codesOf(run([outline(), small([8, 30])]))).toEqual([])
    expect(codesOf(run([outline(), small([50, 30])]))).toEqual(Array(4).fill('dfm.cornerTooSmall'))
  })

  it('v0.1 rectangles: silent in the frame and the slug, warn on the part', () => {
    const rectangle = (center: Vec2): Op<'pocket'> =>
      pocket(center, {
        shape: { center, contour: { kind: 'rectangle', length: 10, width: 6, cornerRadius: 0 } },
      })
    expect(codesOf(run([outline(), rectangle([8, 30])]))).toEqual([])
    expect(codesOf(run([outline(), rectangle([50, 30])]))).toEqual(['dfm.cornerSharp'])
    // an inside profile's own corners lie on its loop: on the part
    const inside: Op<'profile'> = {
      ...opening(),
      id: 'opening',
      shape: {
        center: [50, 30],
        contour: { kind: 'rectangle', length: 30, width: 20, cornerRadius: 0 },
      },
    }
    expect(codesOf(run([outline(), inside]), 'opening')).toContain('dfm.cornerSharp')
  })

  it('an outside profile’s concave notch is on the part and still warns', () => {
    const ell = region(rect(-30, -20, 60, 40))
    const notched = port.difference(ell, region(rect(10, 0, 20, 20))).unwrap()
    const ws = run([outline({ shape: at(notched, [50, 30]) })])
    expect(codesOf(ws, 'outline')).toContain('dfm.cornerSharp')
  })
})

describe('tool fit in waste', () => {
  it('toolUnfit (cornerRadius): silent for corners in the frame, warns for corners on the part', () => {
    // left corners sharp (in the frame), right corners R5 (on the part)
    const d = port.union(box(30, 20, 5), region(rect(-15, -10, 15, 20))).unwrap()
    const op = pocket([20, 30], { shape: at(d, [20, 30]) })
    const tools = { operationTools: own(op, flat(6)) }
    expect(codesOf(run([op], tools))).toContain('dfm.toolUnfit')
    expect(codesOf(run([outline(), op], tools))).not.toContain('dfm.toolUnfit')
    // a sharp corner on the part still fails the fit
    const onPart = pocket([50, 30])
    expect(run([outline(), onPart], { operationTools: own(onPart, flat(6)) })).toContainEqual(
      expect.objectContaining({
        code: 'dfm.toolUnfit',
        params: expect.objectContaining({ rule: 'cornerRadius' }),
      }),
    )
  })

  it('pocketNoToolFits and toolUnfit (width): silent for a pocket wholly in the frame', () => {
    const narrow = (c: Vec2) => pocket(c, { shape: at(box(2, 10, 0.9), c) })
    expect(codesOf(run([narrow([8, 30])]))).toContain('dfm.pocketNoToolFits')
    expect(codesOf(run([outline(), narrow([8, 30])]))).toEqual([])
    expect(codesOf(run([outline(), narrow([50, 30])]))).toContain('dfm.pocketNoToolFits')
    const op = narrow([8, 30])
    expect(codesOf(run([outline(), op], { operationTools: own(op, flat(6)) }))).toEqual([])
  })

  it('a wrong tool type still warns in waste', () => {
    const op = pocket([8, 30])
    const ws = run([outline(), op], {
      operationTools: own(op, { type: 'ballEndMill', diameter: 6 }),
    })
    expect(ws).toContainEqual(
      expect.objectContaining({
        code: 'dfm.toolUnfit',
        params: expect.objectContaining({ rule: 'type' }),
      }),
    )
  })

  it('restMaterial: a neck in the frame between two parts is silent', () => {
    const neck = region(dumbbell(2))
    const op = pocket([25, 30], { shape: at(neck, [25, 30]) })
    const left = outline({ id: 'left', shape: at(box(40, 40), [25, 30]) })
    const right = outline({ id: 'right', shape: at(box(40, 40), [75, 30]) })
    const tools = { operationTools: own(op, flat(6)) }
    expect(codesOf(run([op], tools))).toContain('dfm.restMaterial')
    expect(codesOf(run([left, right, op], tools))).not.toContain('dfm.restMaterial')
    // one part across the neck: the rest is on the part
    const whole = outline({ shape: at(box(90, 40), [50, 30]) })
    expect(codesOf(run([whole, op], tools))).toContain('dfm.restMaterial')
  })
})

describe('reach in waste', () => {
  const tools = [flat(6, { reach: 10 }), { type: 'drill' as const, diameter: 5, reach: 10 }]

  it('dfm.reach: silent for a pocket wholly in the frame, warns on the part', () => {
    const deep = (c: Vec2) => pocket(c, { depth: 15, shape: at(box(10, 10, 4), c) })
    expect(codesOf(run([deep([8, 30])], { tools }))).toEqual(['dfm.reach'])
    expect(codesOf(run([outline(), deep([8, 30])], { tools }))).toEqual([])
    expect(codesOf(run([outline(), deep([50, 30])], { tools }))).toEqual(['dfm.reach'])
    // across the outline: on the part too
    expect(codesOf(run([outline(), deep([20, 30])], { tools }))).toEqual(['dfm.reach'])
  })

  it('dfm.reach: silent for a hole in the frame (a hold-down screw), warns on the part', () => {
    expect(codesOf(run([drill([8, 30])], { tools }), 'drill1')).toEqual(['dfm.reach'])
    expect(codesOf(run([outline(), drill([8, 30])], { tools }), 'drill1')).toEqual([])
    expect(codesOf(run([outline(), drill([40, 30])], { tools }), 'drill1')).toEqual(['dfm.reach'])
  })

  it('without the 2D port nothing is held wholly in waste (warns as before)', () => {
    const deep = pocket([8, 30], {
      depth: 15,
      shape: {
        center: [8, 30],
        contour: { kind: 'rectangle', length: 10, width: 10, cornerRadius: 4 },
      },
    })
    const ws = parameterChecks(
      { stock: STOCK, operations: [outline(), deep] },
      { tools, unitSystem: 'metric' },
    )
    expect(codesOf(ws)).toEqual(['dfm.reach'])
  })
})

describe('shapeOutsideFace in waste', () => {
  // the overhang beyond the stock is never on the part: an intended overrun is info (DF53), only
  // a shape wholly off the face (it cuts nothing) warns
  it('an overrun from the frame over the stock edge is info and has no corner findings', () => {
    const ws = run([outline(), pocket([2, 30])])
    const out = ws.filter((w) => w.code === 'dfm.shapeOutsideFace')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ severity: 'info', params: { sides: ['stock.side[3]'], by: 3 } })
    expect(codesOf(ws)).toEqual(['dfm.shapeOutsideFace'])
  })

  it('a shape wholly off the face still warns', () => {
    const ws = run([outline(), pocket([-10, 30])])
    const out = ws.filter((w) => w.code === 'dfm.shapeOutsideFace')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ severity: 'warning', params: { wholly: true } })
  })
})
