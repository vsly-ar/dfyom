// The simulated cut against the reference (V3): statistics, the edge band, region causes, the
// size cap, and X0's numbers on the black-box test's programs against its STL.
// Spec: docs/modes/deviation.md#result, #implementation-v3
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { len, libraryInput, machineValues } from '../library/library.fixture'
import { flat6 } from '../plan/plan.fixture'
import { createToolpathCache } from '../toolpath/cache'
import type { Direction } from '../geometry/face'
import { simulateHeightmap, type CutMap } from '../toolpath/simulate'
import {
  ENCLOSURE_BOTTOM_NC,
  ENCLOSURE_STOCK,
  ENCLOSURE_TOP_NC,
  parseGcode,
  readGcode,
} from '../toolpath/testing/gcode'
import { drill, endMill } from '../toolpath/testing/fixtures'
import { noSteps } from '../workers/steps'
import { referenceHeightmaps, transformSoup, type ReferenceMap } from './reference-compare'
import {
  comparePlanMaps,
  cutHoles,
  EXPLAIN_OVER_MM,
  PLAN_REGIONS_MAX,
  PLAN_RESULT_BYTES_MAX,
  type CutOwner,
  type PlanCompareInput,
  type PlanCompareResult,
} from './reference-compare-plan'
import { compareSetup, SOURCES, type CompareSetup } from './reference-compare.testing'
import { enclosureStl } from './stl.testing'

// ── synthetic maps: a 20 × 20 × 10 stock, 0.5 mm cells, a block on 2..18 with a pocket ────────

const STOCK = { length: 20, width: 20, thickness: 10 }
const CELL = 0.5
const N = 40
/** Pocket 6..14 × 6..14, 3 mm deep; the part's outline 2..18; the rest of the column empty. */
const refHeight = (u: number, v: number): number => {
  if (u < 2 || u > 18 || v < 2 || v > 18) return NaN
  return u > 6 && u < 14 && v > 6 && v < 14 ? -3 : 0
}

function refMap(direction: Direction = '+z', at = refHeight): ReferenceMap {
  const h = new Float32Array(N * N)
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) h[j * N + i] = at((i + 0.5) * CELL, (j + 0.5) * CELL)
  return { direction, cell: CELL, nu: N, nv: N, h }
}

/** The cut that makes the reference exactly: through outside the part, by toolpath 1. */
function cutMap(
  direction: Direction = '+z',
  ref = refMap(direction),
): CutMap & { h: Float32Array } {
  const h = new Float32Array(N * N)
  const by = new Uint16Array(N * N).fill(1)
  for (let c = 0; c < h.length; c++) h[c] = Number.isNaN(ref.h[c]!) ? -10 : ref.h[c]!
  return { direction, cell: CELL, nu: N, nv: N, h, by }
}

const at = (u: number, v: number) => Math.floor(v / CELL) * N + Math.floor(u / CELL)
const OWNERS: CutOwner[] = [{ operationId: 'pop1', toolRadius: 3, tabs: false }]

function compare(cut: CutMap, extra: Partial<PlanCompareInput> = {}): PlanCompareResult {
  return comparePlanMaps({
    stock: STOCK,
    threshold: 0.1,
    reference: [refMap()],
    cut: [cut],
    owners: OWNERS,
    ...extra,
  })
}

describe('comparePlanMaps', () => {
  it('the exact cut: zero deviation, the edge band and the outside left out', () => {
    const r = compare(cutMap())
    expect(r.stats).toMatchObject({ max: 0, p95: 0, p99: 0, areaOver: 0 })
    expect(r.regions).toEqual([])
    expect(r.unexplained).toBe(0)
    // the domain is the part grown by 1 mm: 18 × 18 mm of cells; the rest is outside
    expect(r.excluded.outsidePart).toBe(400 - 18 * 18)
    // walls: the outline (both sides of it) and the pocket's
    expect(r.excluded.edgeBand).toBeGreaterThan(0)
    expect(r.stats.cells * CELL * CELL + r.excluded.edgeBand).toBe(18 * 18)
    expect(r.faces.map((f) => f.face)).toEqual(['stock.top'])
  })

  it('statistics: percentiles, mean and signs of |dev| over the compared cells', () => {
    const cut = cutMap()
    // 2 % of the compared cells 0.05 mm high, one 0.3 mm deep
    const r0 = compare(cut)
    // the rim between the outline's band and the pocket's (v 3..5)
    const rim: number[] = []
    for (let v = 3; v < 5; v += CELL) for (let u = 3; u < 17; u += CELL) rim.push(at(u, v))
    const high = Math.ceil(r0.stats.cells * 0.02)
    expect(high).toBeLessThan(rim.length)
    for (const c of rim.slice(0, high)) cut.h[c] = cut.h[c]! + 0.05
    cut.h[at(10, 10)] = -3.3
    const r = compare(cut)
    expect(r.stats.cells).toBe(r0.stats.cells)
    expect(r.stats.p50).toBe(0)
    expect(r.stats.p95).toBe(0)
    expect(r.stats.p99).toBe(0.05)
    expect(r.stats.max).toBe(0.3)
    expect(r.stats.overcutMax).toBe(0.3)
    expect(r.stats.undercutMax).toBe(0.05)
    expect(r.stats.areaOver).toBe(0.25)
    // one region: the over-cut cell (the 0.05 mm cells are under the threshold)
    expect(r.regions).toHaveLength(1)
    expect(r.regions[0]).toMatchObject({
      face: 'stock.top',
      bounds: [
        [10, 10],
        [10.5, 10.5],
      ],
      sign: 'overcut',
      maxDev: 0.3,
      depthRange: [3, 3.3],
      operationId: 'pop1',
    })
    expect(r.regions[0]!.cause).toBeUndefined()
  })

  it('a pocket 0.2 mm too deep is one over-cut region of its floor', () => {
    const cut = cutMap()
    for (let c = 0; c < N * N; c++) if (cut.h[c] === -3) cut.h[c] = -3.2
    const r = compare(cut)
    expect(r.regions).toHaveLength(1)
    const g = r.regions[0]!
    expect(g.sign).toBe('overcut')
    expect(g.maxDev).toBeCloseTo(0.2, 2)
    // the floor (6..14) less its edge band (one cell along the walls)
    expect(g.bounds).toEqual([
      [6.5, 6.5],
      [13.5, 13.5],
    ])
    expect(r.unexplained).toBe(0)
  })

  it('toolRadius: material left in a pocket corner within the tool radius of the walls', () => {
    const cut = cutMap()
    // the off-band floor starts at 6.5 (the band is the cells at 6..6.5); a corner fillet of
    // material 2 mm across, 3 mm high, as a 6 mm tool leaves at a sharp corner
    for (let u = 6.5; u < 8.5; u += CELL)
      for (let v = 6.5; v < 8.5 - (u - 6.5); v += CELL) cut.h[at(u, v)] = 0
    // the same lump in the middle of the floor: nothing explains it
    cut.h[at(10, 10)] = -2
    const r = compare(cut)
    const corner = r.regions.find((g) => g.bounds[0][0] === 6.5)!
    expect(corner).toMatchObject({ sign: 'undercut', maxDev: 3, cause: 'toolRadius' })
    const middle = r.regions.find((g) => g.bounds[0][0] === 10)!
    expect(middle.maxDev).toBe(1)
    expect(middle.cause).toBeUndefined()
    expect(r.unexplained).toBe(1)
    // a 1 mm tool could not leave the corner lump: no cause
    const small = compare(cut, { owners: [{ operationId: 'pop1', toolRadius: 0.5, tabs: false }] })
    expect(small.regions.find((g) => g.bounds[0][0] === 6.5)!.cause).toBeUndefined()
  })

  it('tab: material outside the part left by a profile with tabs, from this face or the other', () => {
    const cut = cutMap()
    // a tab across the 1 mm ring left of the outline (u 1..2; the band is the cell at 1.5..2)
    for (let v = 9; v < 11; v += CELL) cut.h[at(1, v)] = -7
    const tabbed = [{ operationId: 'pop1', toolRadius: 3, tabs: true }]
    expect(compare(cut, { owners: tabbed }).regions[0]).toMatchObject({
      sign: 'undercut',
      maxDev: 3,
      cause: 'tab',
      bounds: [
        [1, 9],
        [1.5, 11],
      ],
    })
    // without tabs, a lump this small beside the wall reads as the tool's radius; with a small
    // tool nothing explains it
    expect(compare(cut).regions[0]!.cause).toBe('toolRadius')
    const small = [{ operationId: 'pop1', toolRadius: 0.5, tabs: false }]
    expect(compare(cut, { owners: small }).regions[0]!.cause).toBeUndefined()
    // seen from the bottom: the tab's column (the top cut it to −7), the bottom step's cut by
    // an operation without tabs; the cause comes from the top map's owner across the column
    const bottomRef = refMap('-z', (u, v) => refHeight(u, 20 - v))
    const bottom = cutMap('-z', bottomRef)
    for (let v = 9; v < 11; v += CELL) bottom.h[at(1, 20 - v - CELL)] = -1
    bottom.by.fill(2)
    const r = comparePlanMaps({
      stock: STOCK,
      threshold: 0.1,
      reference: [refMap(), bottomRef],
      cut: [cut, bottom],
      owners: [...tabbed, { operationId: 'pop2', toolRadius: 3, tabs: false }],
    })
    const fromBottom = r.regions.find((g) => g.face === 'stock.bottom')!
    expect(fromBottom).toMatchObject({ cause: 'tab', operationId: 'pop2', maxDev: 9 })
  })

  it('a column cut through from the other face is empty from both', () => {
    // the top cuts the outside through; the bottom only faces 1 mm: no material outside the part
    const top = cutMap()
    const bottomRef = refMap('-z', (u, v) => refHeight(u, 20 - v))
    const bottom = cutMap('-z', bottomRef)
    for (let c = 0; c < N * N; c++) if (Number.isNaN(bottomRef.h[c]!)) bottom.h[c] = -1
    const r = comparePlanMaps({
      stock: STOCK,
      threshold: 0.1,
      reference: [refMap(), bottomRef],
      cut: [top, bottom],
      owners: OWNERS,
    })
    expect(r.regions).toEqual([])
    expect(r.faces.map((f) => [f.face, f.max])).toEqual([
      ['stock.top', 0],
      ['stock.bottom', 0],
    ])
  })

  it('workholding: material a keep-out leaves', () => {
    const cut = cutMap()
    for (let u = 9; u < 11; u += CELL) cut.h[at(u, 16)] = 0.5
    cut.h[at(16, 16)] = 0.5
    const r = compare(cut, {
      keepOut: [
        {
          direction: '+z',
          bounds: [
            [8, 15],
            [12, 17],
          ],
        },
      ],
    })
    expect(r.regions.map((g) => [g.bounds[0][0], g.cause])).toEqual([
      [9, 'workholding'],
      [16, undefined],
    ])
  })

  it('holeMouth and drillPoint: material at a drilled hole, the drill cone below its bottom', () => {
    const hole = { direction: '+z' as const, at: [10, 10] as [number, number] }
    const cut = cutMap()
    // a countersink the plan does not cut: a ring 1–2 mm around the hole, 0.6 mm high
    for (let c = 0; c < N * N; c++) {
      const i = c % N
      const d = Math.hypot((i + 0.5) * CELL - 10, (Math.floor(c / N) + 0.5) * CELL - 10)
      if (d > 1 && d < 2) cut.h[c] = -2.4
    }
    const mouth = compare(cut, { holes: [{ ...hole, diameter: 2.5, point: 0.75 }] })
    expect(mouth.regions.map((g) => [g.sign, g.cause])).toEqual([['undercut', 'holeMouth']])
    // the drill's point 0.6 mm below a flat hole bottom: explained by its cone (0.75 mm)
    const point = cutMap()
    point.h[at(10, 10)] = -3.6
    const holes = [{ ...hole, diameter: 2.5, point: 0.75 }]
    expect(compare(point, { holes }).regions[0]!.cause).toBe('drillPoint')
    // 0.9 mm below: deeper than the cone, the hole is too deep
    point.h[at(10, 10)] = -3.9
    expect(compare(point, { holes }).regions[0]!.cause).toBeUndefined()
    expect(compare(point, { holes }).unexplained).toBe(1)
  })

  it(`lists at most ${PLAN_REGIONS_MAX} regions, largest volume first, within ${PLAN_RESULT_BYTES_MAX} bytes`, () => {
    const cut = cutMap()
    // 64 single-cell lumps on the top (off the band), growing in height
    let k = 0
    for (let u = 3; u < 18 && k < 64; u += 2)
      for (let v = 2.5; v < 6 && k < 64; v += 2) cut.h[at(u, v)] = 0.2 + 0.01 * k++
    for (let u = 3; u < 18 && k < 64; u += 2)
      for (let v = 14.5; v < 18 && k < 64; v += 2) cut.h[at(u, v)] = 0.2 + 0.01 * k++
    const r = compare(cut)
    expect(r.regions).toHaveLength(PLAN_REGIONS_MAX)
    expect(r.more).toBe(k - PLAN_REGIONS_MAX)
    const volumes = r.regions.map((g) => g.volume)
    expect(volumes).toEqual([...volumes].sort((a, b) => b - a))
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(PLAN_RESULT_BYTES_MAX)
    expect(compare(cut, { limit: 5 }).regions).toHaveLength(5)
  })

  it('cutHoles: drill cycles and plunges of a drill, in the face frame', () => {
    const tp = (moves: object[]) => ({
      planOperationId: 'pop1',
      tool: 't',
      spindleSpeed: 0,
      passes: [{ kind: 'rough' as const, moves: moves as never }],
      stats: { cutLength: 0, rapidLength: 0, estimatedSeconds: 0 },
    })
    const holes = cutHoles({
      stock: STOCK,
      setups: [
        {
          direction: '+z',
          rotation: 0,
          toolpaths: [
            {
              tool: drill(2.5),
              toolpath: tp([
                { kind: 'rapid', to: [5, 5, 2] },
                { kind: 'line', to: [5, 5, -4], feed: 100 },
                { kind: 'rapid', to: [5, 5, 2] },
              ]),
            },
            {
              tool: endMill(6),
              toolpath: tp([
                { kind: 'rapid', to: [8, 8, 2] },
                { kind: 'line', to: [8, 8, -4], feed: 100 },
              ]),
            },
          ],
        },
      ],
    })
    expect(holes).toHaveLength(1)
    expect(holes[0]!.at).toEqual([5, 5])
    expect(holes[0]!.point).toBeCloseTo(1.25 / Math.tan((59 * Math.PI) / 180), 6)
  })
})

// ── X0: the black-box test's programs against its STL (Q44) ─────────────────────────────────

/**
 * The enclosure as the black-box test placed it: the STL centred in x/y (+125, +100), its bottom
 * 1 mm above the stock bottom (as `simulate.perf.ts`); both saved programs, top (+z) then bottom
 * (−z, no turn or zero). The top program's outline has tabs.
 */
function enclosure(cell: number): PlanCompareResult {
  const bytes = enclosureStl()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const n = view.getUint32(80, true)
  const soup = new Float32Array(9 * n)
  for (let t = 0; t < n; t++)
    for (let k = 0; k < 9; k++) soup[9 * t + k] = view.getFloat32(84 + 50 * t + 12 + 4 * k, true)
  const placed = transformSoup(soup, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 125, 100, -39, 1])
  const input = {
    stock: ENCLOSURE_STOCK,
    cell,
    setups: [
      {
        direction: '+z' as const,
        rotation: 0 as const,
        toolpaths: parseGcode(readGcode(ENCLOSURE_TOP_NC)),
      },
      {
        direction: '-z' as const,
        rotation: 0 as const,
        toolpaths: parseGcode(readGcode(ENCLOSURE_BOTTOM_NC)),
      },
    ],
  }
  const owners = input.setups.flatMap((s) =>
    s.toolpaths.map((p) => ({
      operationId: `${s.direction}/${p.toolpath.planOperationId}`,
      toolRadius: p.tool.diameter / 2,
      tabs: s.direction === '+z',
    })),
  )
  return comparePlanMaps({
    stock: ENCLOSURE_STOCK,
    threshold: 0.1,
    reference: referenceHeightmaps(placed, ENCLOSURE_STOCK, ['+z', '-z'], cell, noSteps).unwrap(),
    cut: simulateHeightmap(input).unwrap(),
    owners,
    holes: cutHoles(input),
  })
}

describe('X0: the enclosure programs against the STL (Q44)', () => {
  // ≈ 1.5 s: both programs swept and the STL mapped at 0.5 mm
  it(
    'meets p95/p99 outside the edge band; the drill points break through the floor',
    { timeout: 60_000 },
    () => {
      const r = enclosure(0.5)
      // Q44: p95 |dev| ≤ 0.05 mm and p99 ≤ 0.1 mm outside the edge band, per face
      for (const f of r.faces) {
        expect(f.p95).toBeLessThanOrEqual(0.05)
        expect(f.p99).toBeLessThanOrEqual(0.1)
      }
      expect(r.faces.map((f) => [f.face, f.p95, f.p99])).toEqual([
        ['stock.top', 0.005, 0.005],
        ['stock.bottom', 0.001, 0.001],
      ])
      expect(JSON.stringify(r).length).toBeLessThanOrEqual(PLAN_RESULT_BYTES_MAX)
      // the tabs (both faces) and the outline's corner steps come back with their causes
      const causes = r.regions.map((g) => g.cause ?? 'none')
      expect(causes.filter((c) => c === 'tab').length).toBeGreaterThanOrEqual(8)
      expect(causes.filter((c) => c === 'toolRadius')).toHaveLength(2)
      // Q44 misses here: the 2.5 mm drill's point reaches 5.559 mm into the bottom, 0.374 mm past
      // the 5.185 mm the cavity leaves, at all four holes; seen from both faces (8 regions over
      // 0.5 mm without a cause; a real defect of the black-box programs, not of the check)
      const unexplained = r.regions.filter(
        (g) => g.cause === undefined && g.maxDev > EXPLAIN_OVER_MM,
      )
      expect(r.unexplained).toBe(8)
      expect(unexplained.map((g) => [g.face, g.sign, g.operationId])).toEqual([
        ['stock.bottom', 'overcut', '-z/program-2'],
        ['stock.bottom', 'overcut', '-z/program-2'],
        ['stock.bottom', 'overcut', '-z/program-2'],
        ['stock.bottom', 'overcut', '-z/program-2'],
        ['stock.top', 'overcut', '+z/program-1'],
        ['stock.top', 'overcut', '+z/program-1'],
        ['stock.top', 'overcut', '+z/program-1'],
        ['stock.top', 'overcut', '+z/program-1'],
      ])
    },
  )
})

// ── the command on the enclosure: a plan made in the app (headless) ───────────────────────────

const BASE = '/models/enclosure-wood-base.stl'

interface Imported {
  shapeIds: string[]
  section: { shapes: { placeAt: { center: number[]; anchor: string } }[] }
}

/**
 * The enclosure base from the black-box test's 250 × 200 × 40 hardwood block, its STL fitted as
 * the test placed it (centred, top on the stock top): the cavity pocket and the outline with four
 * tabs from the top (shapes from sections), a 1 mm facing of the bottom; the bottom steps and the
 * four countersunk holes left out. One plan, a 6 mm flat (45 mm flutes) on every operation.
 */
async function enclosurePlan(): Promise<{ s: CompareSetup; planId: string }> {
  SOURCES[BASE] ??= enclosureStl()
  const s = await compareSetup(
    {
      name: 'Hardwood',
      shape: 'block',
      length: '250',
      width: '200',
      thickness: '40',
      material: { name: 'Oak', class: 'hardwood' },
    },
    undefined,
    { toolpaths: createToolpathCache() },
  )
  const partId = s.partId
  await s.run('design.reference.import', { partId, path: BASE, sourceUnit: 'mm' })
  const shape = (from: object) =>
    s.run('design.shape.import', { partId, from }) as Promise<Imported>
  const named = (r: Imported) => {
    const at = r.section.shapes[0]!.placeAt
    return {
      shape: { kind: 'named', shapeId: r.shapeIds[0], center: at.center.map(String) },
      anchor: at.anchor,
    }
  }
  const outline = await shape({ depth: '20', loops: 'outer' })
  const cavity = await shape({ depth: '20', loops: 'holes' })
  // the cavity floor: design.reference.find levels reads it at 34.815 mm
  await s.run('design.pocket.add', { partId, ...named(cavity), depth: '34.815' })
  await s.run('design.profile.add', {
    partId,
    side: 'outside',
    ...named(outline),
    tabs: { count: '4', width: '6', thickness: '2' },
  })
  await s.run('design.facing.add', { partId, on: 'stock.bottom', depth: '1' })
  const add = async (kind: string, values: object) =>
    ((await s.run(`library.${kind}.add`, { values: libraryInput(values) })) as { id: string }).id
  const tool = await add('tool', {
    ...flat6(),
    name: 'Long flat 6',
    fluteLength: len('45'),
    overallLength: len('80'),
  })
  const { kind: _, ...m } = machineValues()
  const machine = await add('machine', m)
  await s.run('project.apply', {})
  const { planId } = (await s.run('plan.create', {
    partId,
    machineLibraryItemId: machine,
  })) as { planId: string }
  for (const setup of s.d.doc.plans[planId]!.setups)
    for (const op of setup.operations)
      await s.run('plan.tool.assign', { planId, planOperationId: op.id, toolLibraryItemId: tool })
  return { s, planId }
}

async function comparePlan(s: CompareSetup, source: object) {
  const { jobId } = (await s.run('design.reference.compare', {
    partId: s.partId,
    source: { kind: 'plan', ...source },
  })) as { jobId: string }
  return s.d.job(jobId).unwrap().result
}

describe('design.reference.compare { source: plan } (headless, the enclosure)', () => {
  it(
    'generates the toolpaths, compares both faces and names what the design leaves out',
    { timeout: 60_000 },
    async () => {
      const { s, planId } = await enclosurePlan()
      const r = expectOk(await comparePlan(s, { planId })) as PlanCompareResult & { planId: string }
      expect(r).toMatchObject({ source: 'plan', method: 'heightmap', cell: 0.5, planId })
      expect(JSON.stringify(r).length).toBeLessThanOrEqual(PLAN_RESULT_BYTES_MAX)
      // every operation generated on the way (the cache holds them now)
      const ops = s.d.doc.plans[planId]!.setups.flatMap((x) => x.operations.map((o) => o.id))
      const plan = s.d.doc.plans[planId]!
      /** The plan operation of the design operation of a kind (one each). */
      const opOf = (kind: string) =>
        plan.setups
          .flatMap((x) => x.operations)
          .find((o) => o.designOperationIds[0]!.startsWith(kind))!.id
      // the top meets Q44 outside the edge band: the cavity and the outline as designed
      const topStats = r.faces.find((f) => f.face === 'stock.top')!
      expect(topStats.p95).toBeLessThanOrEqual(0.05)
      expect(topStats.p99).toBeLessThanOrEqual(0.1)
      const of = (face: string, cause?: string) =>
        r.regions.filter((g) => g.face === face && g.cause === cause)
      // the tabs, from the top (the profile) and from the bottom (the facing leaves them)
      expect(of('stock.top', 'tab').map((g) => g.operationId)).toEqual(
        Array(4).fill(opOf('profile')),
      )
      expect(of('stock.bottom', 'tab')).toHaveLength(4)
      // the cavity's two sharp corners: the 6 mm tool's radius, on the pocket
      expect(of('stock.top', 'toolRadius').map((g) => g.operationId)).toEqual(
        Array(2).fill(opOf('pocket')),
      )
      // what the design omits: the bottom steps (material left over the outline band, 1.771 mm)
      // and the four holes, unexplained, on the bottom facing
      const left = of('stock.bottom')
      expect(left.map((g) => [g.sign, g.maxDev])).toEqual([
        ['undercut', 1.771],
        ['undercut', 3.944],
        ['undercut', 3.944],
        ['undercut', 3.944],
        ['undercut', 3.944],
      ])
      expect(new Set(left.map((g) => g.operationId))).toEqual(new Set([opOf('facing')]))
      expect(r.unexplained).toBe(5)
      expect(ops.length).toBe(3)
    },
  )

  it("fails without planId, with another part's plan or an unknown one", async () => {
    const { s, planId } = await enclosurePlan()
    const missing = expectErrCode(await comparePlan(s, {}), 'input.malformed')
    expect(missing.issues[0]).toMatchObject({ path: ['source', 'planId'], rule: 'required' })
    const unknown = await comparePlan(s, { planId: 'plan-99' })
    expect(unknown.isErr()).toBe(true)
    const { partId: other } = (await s.run('design.part.add', {
      name: 'Other',
      stockLibraryItemId: s.library.list('stock').items[0]!.id,
    })) as { partId: string }
    const { jobId } = (await s.run('design.reference.compare', {
      partId: other,
      source: { kind: 'plan', planId },
    })) as { jobId: string }
    const otherPlan = expectErrCode(await s.d.job(jobId).unwrap().result, 'input.malformed')
    expect(otherPlan.issues[0]).toMatchObject({ rule: 'otherPart' })
  })
})
