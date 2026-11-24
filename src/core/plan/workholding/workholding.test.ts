// Spec: docs/modes/workholding.md (§ Model, § Obstacles, § Links and safe heights, § Collision
// check, § Commands and queries, § Testing)
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { uiSource } from '../../commands/testing'
import { regionArea } from '../../geometry/2d/model'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import type { Move } from '../../toolpath/model'
import { facingRegion, keepOutRegion } from '../../toolpath/keep-out'
import { generateRegionPocket } from '../../toolpath/region-pocket'
import { expectUndoRedo, planSetup } from '../plan.fixture'
import { checkWorkholding, type CheckOperation } from './check'
import { itemIssues, itemSummary, nextItemId, type ResolvedItem } from './items'
import {
  effectiveClearance,
  footprintBounds,
  footprintOutline,
  itemPrisms,
  obstacles,
  pointDistance,
  segmentDistance,
  workholdingObstacles,
  type Prism,
} from './obstacles'

const region2d = nodeRegion2d()
const STOCK = { length: 250, width: 100, thickness: 40 }

const toe = (
  edge: 'uMin' | 'uMax' | 'vMin' | 'vMax',
  at = 50,
): Extract<ResolvedItem, { kind: 'toeClamp' }> => ({
  id: 'wh1',
  name: 'Toe clamp 1',
  kind: 'toeClamp',
  edge,
  at,
  width: 28,
  grip: 10,
  reach: 18,
  top: 12,
})

describe('obstacles (WH-B)', () => {
  it('a toe clamp is two prisms: over the stock from Z0, beyond the edge from the table', () => {
    const [over, out] = itemPrisms(toe('uMin'), STOCK)
    expect(footprintBounds(over!.footprint)).toEqual([
      [0, 36],
      [10, 64],
    ])
    expect([over!.zMin, over!.zMax]).toEqual([0, 12])
    expect(footprintBounds(out!.footprint)).toEqual([
      [-18, 36],
      [0, 64],
    ])
    expect([out!.zMin, out!.zMax]).toEqual([-Infinity, 12])
  })

  it.each([
    [
      'uMax',
      [
        [240, 36],
        [268, 64],
      ],
    ],
    [
      'vMin',
      [
        [111, -18],
        [139, 10],
      ],
    ],
    [
      'vMax',
      [
        [111, 90],
        [139, 118],
      ],
    ],
  ] as const)('on every edge: %s', (edge, box) => {
    const prisms = itemPrisms(toe(edge, edge === 'uMax' ? 50 : 125), STOCK)
    const all = prisms.map((p) => footprintBounds(p.footprint))
    expect([
      [Math.min(...all.map((b) => b[0][0])), Math.min(...all.map((b) => b[0][1]))],
      [Math.max(...all.map((b) => b[1][0])), Math.max(...all.map((b) => b[1][1]))],
    ]).toEqual(box)
  })

  it('a vise is two jaws below the stock top by the protrusion', () => {
    const vise: ResolvedItem = {
      id: 'wh2',
      name: 'Vise',
      kind: 'vise',
      axis: 'v',
      protrusion: 5,
      jawLength: 150,
      jawThickness: 20,
      soft: false,
    }
    const jaws = itemPrisms(vise, STOCK)
    expect(jaws.map((p) => footprintBounds(p.footprint))).toEqual([
      [
        [50, -20],
        [200, 0],
      ],
      [
        [50, 100],
        [200, 120],
      ],
    ])
    expect(jaws.map((p) => p.zMax)).toEqual([-5, -5])
  })

  it('a screw is a circle, a block a rotated rectangle, base and surface no prism', () => {
    const screw = itemPrisms(
      { id: 'a', name: 'S', kind: 'screw', center: [5, 5], headDiameter: 8, top: 0 },
      STOCK,
    )
    expect(screw[0]!.footprint).toEqual({ kind: 'circle', center: [5, 5], radius: 4 })
    const block = itemPrisms(
      {
        id: 'b',
        name: 'B',
        kind: 'block',
        center: [0, 0],
        length: 20,
        width: 10,
        rotation: 90,
        top: 5,
      },
      STOCK,
    )
    const b = footprintBounds(block[0]!.footprint)
    expect(b[0][0]).toBeCloseTo(-5, 9)
    expect(b[1][1]).toBeCloseTo(10, 9)
    expect(block[0]!.zMin).toBe(-40)
    expect(
      obstacles(
        [
          { id: 'c', name: 'Spoilboard', kind: 'base', type: 'spoilboard', sacrificial: true },
          { id: 'd', name: 'Tape', kind: 'surface', type: 'tape' },
        ],
        STOCK,
      ),
    ).toEqual([])
  })

  it('the clearance height follows the highest item + margin unless the user set it (WH-C)', () => {
    const prisms = itemPrisms(toe('uMin'), STOCK)
    expect(effectiveClearance(10, false, prisms, 2)).toEqual({ value: 14, derivedFrom: 'wh1' })
    expect(effectiveClearance(20, false, prisms, 2)).toEqual({ value: 20 })
    expect(effectiveClearance(10, true, prisms, 2)).toEqual({ value: 10 })
    expect(effectiveClearance(10, false, [], 2)).toEqual({ value: 10 })
  })

  it('floorAlong: the link floor over the items a corridor passes (the DF64 interface)', () => {
    const o = workholdingObstacles(itemPrisms(toe('uMin'), STOCK), 2)
    expect(o.floorAlong([-30, 50], [30, 50], 3)).toBe(14)
    // x 14: 4 mm from the pad, within radius + margin (5); x 16: 6 mm, clear
    expect(o.floorAlong([14, 0], [14, 100], 3)).toBe(14)
    expect(o.floorAlong([16, 0], [16, 100], 3)).toBe(-Infinity)
  })

  it('outlines for drawing: grown polygons have round corners at the margin', () => {
    const [over] = itemPrisms(toe('uMin'), STOCK)
    const ring = footprintOutline(over!.footprint, 2)
    for (const p of ring) expect(pointDistance(over!.footprint, p)).toBeCloseTo(2, 9)
    const b = footprintBounds({ kind: 'polygon', points: ring })
    expect(b[0][0]).toBeCloseTo(-2, 9)
    expect(b[1][1]).toBeCloseTo(66, 9)
    expect(footprintOutline(over!.footprint)).toHaveLength(4)
  })

  it('segment distances are exact for polygons and circles', () => {
    const box = {
      kind: 'polygon' as const,
      points: [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ] as [number, number][],
    }
    expect(segmentDistance(box, [12, -5], [12, 15]).distance).toBeCloseTo(2, 12)
    expect(segmentDistance(box, [-5, 5], [15, 5]).distance).toBe(0)
    expect(segmentDistance(box, [13, 14], [13, 14]).distance).toBeCloseTo(5, 12)
    const c = { kind: 'circle' as const, center: [0, 0] as [number, number], radius: 4 }
    expect(segmentDistance(c, [-10, 6], [10, 6]).distance).toBeCloseTo(2, 12)
  })
})

describe('items (WH-A)', () => {
  it('invariants: on the edge, grip below the stock, one vise per setup', () => {
    expect(itemIssues([toe('uMin', 120)], STOCK).map((i) => i.rule)).toEqual(['onEdge'])
    expect(itemIssues([{ ...toe('vMin'), grip: 100 }], STOCK).map((i) => i.rule)).toEqual([
      'belowStock',
    ])
    const vise: ResolvedItem = {
      id: 'v',
      name: 'Vise',
      kind: 'vise',
      axis: 'u',
      protrusion: 5,
      jawLength: 150,
      jawThickness: 20,
      soft: false,
    }
    expect(itemIssues([vise, { ...vise, id: 'w' }], STOCK).map((i) => i.rule)).toEqual([
      'onePerSetup',
    ])
  })

  it('summaries and ids', () => {
    expect(itemSummary(toe('vMin', 125), 'mm')).toBe('front X125 grip 10 top Z12')
    expect(itemSummary(toe('vMin', 125), 'in')).toBe('front X4.921 grip 0.394 top Z0.472')
    expect(nextItemId(['wh1', 'wh7', 'x'])).toBe('wh8')
  })
})

/** One operation of moves with a 6 mm tool. */
const op = (moves: Move[], id = 'op1'): CheckOperation => ({
  planOperationId: id,
  tool: { diameter: 6 },
  moves,
})

describe('checkWorkholding (WH-E, WH-F)', () => {
  // the black-box test's bottom program: four clamps, pads 30 × 10, 25 mm tall
  const pad = (x: number, y: number, id: string): Prism => ({
    itemId: id,
    footprint: {
      kind: 'polygon',
      points: [
        [x, y],
        [x + 30, y],
        [x + 30, y + 10],
        [x, y + 10],
      ],
    },
    zMin: 0,
    zMax: 25,
  })
  const clamps = [pad(30, 0, 'a'), pad(190, 0, 'b'), pad(30, 190, 'c'), pad(190, 190, 'd')]

  it('reports the rapid at Z1 across the clamp at x 190–220, and none after a hop over it', () => {
    const rapid = checkWorkholding({
      operations: [
        op([
          { kind: 'rapid', to: [120, 5, 35] },
          { kind: 'rapid', to: [120, 5, 1] },
          { kind: 'line', to: [120, 5, -1], feed: 500 },
          { kind: 'rapid', to: [120, 5, 1] },
          { kind: 'rapid', to: [250, 5, 1] },
        ]),
      ],
      prisms: clamps,
      margin: 2,
      clearanceZ: 35,
    })
    expect(rapid.collisions).toEqual([
      expect.objectContaining({ kind: 'rapid', itemId: 'b', moveIndex: 4, lowestZ: 1, gap: 0 }),
    ])
    const hopped = checkWorkholding({
      operations: [
        op([
          { kind: 'rapid', to: [120, 5, 35] },
          { kind: 'rapid', to: [120, 5, 1] },
          { kind: 'line', to: [120, 5, -1], feed: 500 },
          { kind: 'rapid', to: [120, 5, 27] },
          { kind: 'rapid', to: [250, 5, 27] },
          { kind: 'rapid', to: [250, 5, 1] },
        ]),
      ],
      prisms: clamps,
      margin: 2,
      clearanceZ: 35,
    })
    expect(hopped.collisions).toEqual([])
  })

  it('links at a clearance below an item, cuts, arcs and drill cycles', () => {
    const r = checkWorkholding({
      operations: [
        op([
          { kind: 'rapid', to: [0, 50, 10] },
          { kind: 'rapid', to: [100, 50, 10] },
        ]),
        op(
          [
            { kind: 'rapid', to: [60, 20, 2] },
            // a feed arc around (60, 0) through pad a (x 30–60, y 0–10)
            { kind: 'arc', to: [40, 0, -1], center: [60, 0], cw: false, feed: 400 },
            {
              kind: 'drill',
              at: [205, 5],
              top: 0,
              bottom: -5,
              cycle: 'simple',
              retract: 2,
              feed: 200,
            },
          ],
          'op2',
        ),
      ],
      prisms: [...clamps, pad(40, 45, 'e')],
      margin: 2,
      clearanceZ: 10,
    })
    expect(r.collisions.map((c) => [c.planOperationId, c.itemId, c.kind])).toEqual([
      ['op1', 'e', 'link'],
      ['op2', 'a', 'cut'],
      // from the arc's end inside pad a, the drill's rapid leaves through it and crosses pad b
      ['op2', 'a', 'rapid'],
      ['op2', 'b', 'rapid'],
      ['op2', 'b', 'cut'],
    ])
  })

  it('the tool is max(cutting, shank) wide; close rapids warn; breakthrough into a fixture plate', () => {
    const near = (shank?: number) =>
      checkWorkholding({
        operations: [
          {
            planOperationId: 'op',
            tool: { diameter: 3, ...(shank === undefined ? {} : { shankDiameter: 6 }) },
            moves: [
              { kind: 'rapid', to: [0, 15.5, 1] },
              { kind: 'rapid', to: [250, 15.5, 1] },
            ],
          },
        ],
        prisms: clamps,
        margin: 2,
        clearanceZ: 30,
      })
    // gap 5.5 − 1.5 = 4 with the cutting Ø: neither; with a 6 mm shank 2.5: close
    expect(near().close).toEqual([])
    expect(near(6).close.map((c) => c.itemId)).toEqual(['a', 'b'])
    expect(near(6).collisions).toEqual([])
    const plate = checkWorkholding({
      operations: [
        op([
          { kind: 'rapid', to: [100, 100, 2] },
          { kind: 'line', to: [100, 100, -41], feed: 100 },
        ]),
      ],
      prisms: [],
      margin: 2,
      clearanceZ: 10,
      fixturePlate: { itemId: 'p', stockBottom: -40 },
    })
    expect(plate.breakthrough.map((c) => [c.itemId, c.lowestZ])).toEqual([['p', -41]])
  })
})

describe('keep-out in region toolpaths (WH-D)', () => {
  it('a facing clears around a toe clamp: no cut inside the zone, the leftover is reported', () => {
    const zones = itemPrisms(toe('uMin'), STOCK).map((p) => ({
      itemId: p.itemId,
      footprint: p.footprint,
      zMax: p.zMax,
    }))
    const kept = expectOk(
      keepOutRegion(region2d, facingRegion(250, 100, 1), { zones, margin: 2 }, -0.5),
    )!
    // [−1, 12] × [34, 66] less the two rounded corners (r 2) on the stock side
    const expected = 13 * 32 - 2 * (4 - Math.PI)
    expect(kept.unmachined).toHaveLength(1)
    expect(kept.unmachined[0]!.area).toBeCloseTo(expected, 3)
    expect(regionArea(kept.region)).toBeCloseTo(252 * 102 - expected, 2)
    const tp = expectOk(
      generateRegionPocket(
        {
          planOperationId: 'f',
          tool: { id: 't', type: 'flatEndMill', diameter: 6, cornerRadius: 0, fluteLength: 20 },
          cutting: {
            spindleSpeed: 18000,
            feedRate: 1000,
            plungeRate: 300,
            stepdown: 1,
            stepover: 3,
          },
          heights: { clearanceHeight: 14, retractHeight: 2 },
          stock: { length: 250, width: 100, thickness: 40 },
          operation: { region: kept.region, onZ: 0, depth: 0.5 },
          strategy: {
            entry: 'ramp',
            helixDiameter: 4.8,
            rampAngle: 3,
            finishAllowance: 0,
            finishStepdown: 0.5,
            direction: 'climb',
          },
        },
        region2d,
      ),
    )
    const r = checkWorkholding({
      operations: [op(tp.passes.flatMap((p) => p.moves))],
      prisms: itemPrisms(toe('uMin'), STOCK),
      margin: 2,
      clearanceZ: 14,
    })
    expect(r.collisions).toEqual([])
    expect(r.minGap).toBeGreaterThanOrEqual(2 - 0.01)
    expect(r.minGap).toBeLessThan(2.1)
  })
})

describe('plan.workholding.set', () => {
  const clamp = { kind: 'toeClamp', edge: 'vMin', at: '30', top: '20' }

  async function plan() {
    const s = await planSetup()
    const planId = await s.create()
    return { s, planId, setupId: s.plan(planId).setups[0]!.id }
  }

  it('sets the list with defaults and ids, is one undo step, and keeps ids it is given', async () => {
    const { s, planId, setupId } = await plan()
    const r = (await expectUndoRedo(s, 'plan.workholding.set', {
      planId,
      setupId,
      items: [clamp, { kind: 'screw', center: ['90', '50'] }],
    })) as { items: { id: string; name: string; summary: string }[]; clearanceHeight: string }
    expect(r.items.map((i) => [i.id, i.name, i.summary])).toEqual([
      ['wh1', 'Toe clamp 1', 'front X30 grip 10 top Z20'],
      ['wh2', 'Screw 1', 'X90 Y50 head 8 top Z0'],
    ])
    expect(r.clearanceHeight).toBe('22 mm')
    const stored = s.plan(planId).setups[0]!.workholding!
    expect(stored[0]!.kind === 'toeClamp' && stored[0]!.width.source).toBe('30 mm')
    // an id keeps the item; omitted parameters stay
    await s.run('plan.workholding.set', {
      planId,
      setupId,
      items: [{ id: 'wh2', kind: 'screw', top: '3' }, { kind: 'vise' }],
    })
    const after = s.plan(planId).setups[0]!.workholding!
    expect(after.map((i) => [i.id, i.name])).toEqual([
      ['wh2', 'Screw 1'],
      ['wh3', 'Vise'],
    ])
    expect(after[0]!.kind === 'screw' && after[0]!.center[0].source).toBe('90')
    // a clamp moved to another edge without a position goes to that edge's middle
    await s.run('plan.workholding.set', { planId, setupId, items: [clamp] })
    const moved = (await s.run('plan.workholding.set', {
      planId,
      setupId,
      items: [{ id: 'wh4', kind: 'toeClamp', edge: 'uMin' }],
    })) as { items: { summary: string }[] }
    expect(moved.items[0]!.summary).toBe('left Y30 grip 10 top Z20')
  })

  it('refuses unknown ids, parameters of another kind, both items and copyFrom, and invariants', async () => {
    const { s, planId, setupId } = await plan()
    const bad = async (items: object[]) =>
      (await s.failWith('plan.workholding.set', { planId, setupId, items }, 'input.malformed'))
        .issues[0]!.rule
    expect(await bad([{ id: 'wh9', kind: 'screw', center: ['1', '1'] }])).toBe('unknownItem')
    expect(await bad([{ kind: 'screw', center: ['1', '1'], edge: 'uMin' }])).toBe('notForKind')
    expect(await bad([{ kind: 'toeClamp' }])).toBe('required')
    expect(await bad([{ kind: 'block', center: ['1', '1'] }])).toBe('required')
    const e = await s.failWith(
      'plan.workholding.set',
      { planId, setupId, items: [{ ...clamp, at: '500' }] },
      'model.invariant',
    )
    expect(e.issues[0]).toMatchObject({ path: ['items', 0, 'at'], rule: 'onEdge' })
    const x = await s.failWith(
      'plan.workholding.set',
      { planId, setupId, items: [], copyFrom: setupId },
      'input.malformed',
    )
    expect(x.issues[0]!.rule).toBe('exclusive')
  })

  it('copies another setup by copyFrom with new ids; the margin is stored', async () => {
    const { s, planId, setupId } = await plan()
    await s.run('plan.workholding.set', { planId, setupId, items: [clamp], margin: '3' })
    const split = (await s.run('plan.setup.split', {
      planId,
      setupId,
      planOperationIds: [s.plan(planId).setups[0]!.operations.at(-1)!.id],
    })) as { setupId: string }
    await s.run('plan.workholding.set', { planId, setupId: split.setupId, copyFrom: setupId })
    const setups = s.plan(planId).setups
    expect(setups[1]!.workholding!.map((i) => [i.id, i.name])).toEqual([['wh2', 'Toe clamp 1']])
    expect(setups[0]!.workholdingMargin!.source).toBe('3')
  })

  it('plan.warning.list: none per setup without items, clearanceLow for a set clearance below them', async () => {
    const { s, planId, setupId } = await plan()
    const codes = () =>
      (
        expectOk(s.d.query('plan.warning.list', { planId }, uiSource())).value as {
          warnings: { code: string; rule: string }[]
        }
      ).warnings
        .filter((w) => w.code.startsWith('plan.workholding'))
        .map((w) => w.code)
    expect(codes()).toEqual(['plan.workholding.none'])
    await s.run('plan.workholding.set', { planId, setupId, items: [clamp] })
    expect(codes()).toEqual([])
    await s.run('plan.setup.update', { planId, setupId, clearanceHeight: '15' })
    expect(codes()).toEqual(['plan.workholding.clearanceLow'])
  })
})
