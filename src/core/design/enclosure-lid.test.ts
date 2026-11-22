// The v0.4 exit part (task X0): the lid's layout fits its outline, tabs, sheet and tools before
// any feature code exists. Docs: docs/plans/v0.4.md#exit-criteria, docs/plans/v0.4.md#7-acceptance
import { describe, expect, it } from 'vitest'
import type { Vec2 } from '../geometry/model'
import { translatePath } from '../geometry/2d/place'
import { freeSides, holdTest, resolveTabs } from '../geometry/tab-hold'
import { chainLength, chainPointAt, closestOnChains, windingNumber } from '../geometry/2d/measure'
import { chainBounds, type Loop } from '../geometry/2d/model'
import {
  arcInstances,
  BOLT_CIRCLE,
  BOLT_CIRCLE_EDITED,
  counterboreSizes,
  countersinkSizes,
  CUTOUT,
  EXPECTED,
  gridInstances,
  LID_CENTRE,
  LID_PROFILE,
  LID_STOCK,
  LID_TOOLS,
  lidOutline,
  lidTabs,
  offsetInstances,
  SCREWS,
  VENTS,
} from './enclosure-lid.testing'
import { ENCLOSURE_SECTIONS_SVG } from './enclosure-sections.testing'

interface NodeProcess {
  getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL, encoding: 'utf8'): string }
}
const fs = (globalThis as unknown as { process: NodeProcess }).process.getBuiltinModule('node:fs')
const svg = fs.readFileSync(ENCLOSURE_SECTIONS_SVG, 'utf8')
const outline = lidOutline(svg)
const tabs = lidTabs(outline)
/** The hold test's input: the outline on the board (face frame), the profile's slot and tabs. */
const holdInput = {
  chain: translatePath(outline, LID_CENTRE),
  side: LID_PROFILE.side,
  slotWidth: LID_PROFILE.slotWidth,
  width: LID_PROFILE.tabs.width,
  stock: LID_STOCK,
}

/** What a cut leaves at the face: a disc, or an obround (a segment swept by a radius). */
interface Footprint {
  readonly name: string
  readonly a: Vec2
  readonly b: Vec2
  readonly r: number
  /** Diameter of the tool that cuts it (the web it needs to its neighbours). */
  readonly tool: number
}

const disc = (name: string, at: Vec2, d: number, tool: number): Footprint => ({
  name,
  a: at,
  b: at,
  r: d / 2,
  tool,
})

function footprints(boltSize: string): Footprint[] {
  const cs = countersinkSizes(SCREWS.fastener)
  const cb = counterboreSizes(boltSize)
  const mill = LID_TOOLS.mill.diameter
  const half = (VENTS.length - VENTS.width) / 2
  return [
    ...EXPECTED.screws.map((p, i) => disc(`screw ${i + 1}`, p, cs.csDiameter, mill)),
    disc('cutout', EXPECTED.cutout, CUTOUT.diameter, mill),
    ...EXPECTED.boltCircle.map((p, i) => disc(`bolt ${i + 1}`, p, cb.cbDiameter, mill)),
    ...EXPECTED.vents.map(({ n, at }): Footprint => ({
      name: `vent ${n}`,
      a: [at[0] - half, at[1]],
      b: [at[0] + half, at[1]],
      r: VENTS.width / 2,
      tool: mill,
    })),
  ]
}

const dist = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1])

function pointSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
  return dist(p, [a[0] + dx * t, a[1] + dy * t])
}

/** Gap between two footprints (their segments do not cross: all lie apart). */
function gap(f: Footprint, g: Footprint): number {
  const d = Math.min(
    pointSegment(f.a, g.a, g.b),
    pointSegment(f.b, g.a, g.b),
    pointSegment(g.a, f.a, f.b),
    pointSegment(g.b, f.a, f.b),
  )
  return d - f.r - g.r
}

/** Points along a footprint's segment, 0.05 mm apart (its ends included). */
function spine(f: Footprint): Vec2[] {
  const n = Math.max(1, Math.ceil(dist(f.a, f.b) / 0.05))
  return Array.from({ length: n + 1 }, (_, k): Vec2 => [
    f.a[0] + ((f.b[0] - f.a[0]) * k) / n,
    f.a[1] + ((f.b[1] - f.a[1]) * k) / n,
  ])
}

/** Clearance from a footprint to the outline loop. */
const toOutline = (f: Footprint, loop: Loop) =>
  Math.min(...spine(f).map((p) => closestOnChains([loop], p)!.distance)) - f.r

/** Points of a tab's stretch along the outline (its width centred on its position). */
function tabStretch(s: number): Vec2[] {
  const w = LID_PROFILE.tabs.width
  return Array.from({ length: 61 }, (_, k) => pointAt(s - w / 2 + (w * k) / 60))
}
const pointAt = (s: number): Vec2 => chainPointAt(outline, s, true).unwrap().point

const close = (p: readonly number[], q: readonly number[]) => {
  expect(p[0]).toBeCloseTo(q[0]!, 9)
  expect(p[1]).toBeCloseTo(q[1]!, 9)
}

describe('v0.4 exit part: the lid layout (X0)', () => {
  it('expands the Clones rows to the expected positions and numbers', () => {
    const screws = gridInstances(SCREWS.source, SCREWS.grid)
    expect(screws.map((i) => i.n)).toEqual([1, 2, 3, 4])
    screws.forEach((i, k) => close(i.at, EXPECTED.screws[k]!))

    const bolts = arcInstances(BOLT_CIRCLE.source, BOLT_CIRCLE.arc)
    expect(bolts.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6])
    bolts.forEach((i, k) => close(i.at, EXPECTED.boltCircle[k]!))
    for (const b of bolts) expect(dist(b.at, CUTOUT.centre)).toBeCloseTo(BOLT_CIRCLE.arc.radius, 9)

    const vents = offsetInstances(VENTS.source, VENTS.offset, VENTS.skip)
    expect(vents.map((i) => i.n)).toEqual([1, 2, 3, 5, 6, 7])
    vents.forEach((i, k) => {
      expect(i.n).toBe(EXPECTED.vents[k]!.n)
      close(i.at, EXPECTED.vents[k]!.at)
    })
  })

  it('takes the M3 / M4 sizes from the fastener table', () => {
    const cs = countersinkSizes('M3')
    expect(cs.diameter).toBe(3.4)
    expect(cs.csDiameter).toBeCloseTo(7.12, 9)
    expect(cs.csAngle).toBe(90)
    expect(cs.coneDepth).toBeCloseTo(1.86, 9)
    expect(counterboreSizes('M3')).toEqual({ diameter: 3.4, cbDiameter: 6.5, cbDepth: 3.2 })
    expect(counterboreSizes('M4')).toEqual({ diameter: 4.5, cbDiameter: 8, cbDepth: 4.2 })
  })

  it('reads the outline from enclosure-sections.svg, centred, from its start point', () => {
    expect(windingNumber(outline, [0, 0])).toBe(1)
    const start = outline.elements[0]!.a
    // lowest v: the front of the oval, near u = 0
    expect(start[1]).toBeLessThan(-88)
    expect(Math.abs(start[0])).toBeLessThan(10)
    expect(chainLength(outline)).toBeGreaterThan(700)
  })

  it.each([SCREWS.fastener, BOLT_CIRCLE_EDITED])(
    'keeps every cut inside the outline by the profile tool (bolt circle %s)',
    (bolt) => {
      const web = LID_TOOLS.profile.diameter
      for (const f of footprints(bolt)) {
        expect(windingNumber(outline, f.a), f.name).toBe(1)
        expect(toOutline(f, outline), f.name).toBeGreaterThanOrEqual(web)
      }
    },
  )

  it.each([SCREWS.fastener, BOLT_CIRCLE_EDITED])(
    'keeps every cut clear of the others by its tool (bolt circle %s)',
    (bolt) => {
      const fs = footprints(bolt)
      for (let i = 0; i < fs.length; i++)
        for (let j = i + 1; j < fs.length; j++) {
          const f = fs[i]!
          const g = fs[j]!
          expect(gap(f, g), `${f.name} – ${g.name}`).toBeGreaterThanOrEqual(
            Math.max(f.tool, g.tool) - 1e-9,
          )
        }
    },
  )

  it('places the four tabs by the v0.3 rule, clear of the cuts and of each other', () => {
    const length = chainLength(outline)
    const { width } = LID_PROFILE.tabs
    const web = LID_TOOLS.profile.diameter
    expect(tabs.map((t) => t.nominal)).toEqual([0, 1, 2, 3].map((k) => ((k + 0.5) * length) / 4))
    // at the oval's diagonal corners the slot's far side lies over the front and back strips of
    // the 255 × 200 board, so all four hold where the v0.3 rule puts them (TB1 moves none)
    expect(tabs.map((t) => t.s)).toEqual(tabs.map((t) => t.nominal))
    // the spacing leaves a slot of at least the profile tool between neighbours (and round the start)
    expect(length / 4 - width).toBeGreaterThanOrEqual(web)
    expect(tabs[0]!.s - width / 2).toBeGreaterThan(0)
    for (const t of tabs) {
      close(pointAt(t.s), t.at)
      const stretch = tabStretch(t.s)
      for (const f of footprints(BOLT_CIRCLE_EDITED).concat(footprints(SCREWS.fastener))) {
        const d = Math.min(...stretch.flatMap((p) => spine(f).map((q) => dist(p, q)))) - f.r
        expect(d, `tab at ${t.s.toFixed(1)} – ${f.name}`).toBeGreaterThanOrEqual(web)
      }
    }
  })

  it('fits the countersinks and counterbores into the 6 mm sheet', () => {
    const t = LID_STOCK.thickness
    const cs = countersinkSizes(SCREWS.fastener)
    expect(cs.coneDepth).toBeLessThan(t)
    // the chamfer mill plunges at the centre: tip depth (D − dt) / 2 / tan(α / 2), still in the sheet
    const c = LID_TOOLS.chamfer
    const tip = (cs.csDiameter - c.tipDiameter) / 2 / Math.tan(((c.angle / 2) * Math.PI) / 180)
    expect(tip).toBeLessThan(t)
    for (const size of [BOLT_CIRCLE.fastener, BOLT_CIRCLE_EDITED]) {
      const cb = counterboreSizes(size)
      // 0 < cbDepth < the stock extent (design-v0.4.md#parameters)
      expect(cb.cbDepth).toBeGreaterThan(0)
      expect(cb.cbDepth).toBeLessThan(t)
    }
    // sheet left under the head: 2.8 mm (M3), 1.8 mm after the M4 edit
    expect(t - counterboreSizes(BOLT_CIRCLE.fastener).cbDepth).toBeCloseTo(2.8, 9)
    expect(t - counterboreSizes(BOLT_CIRCLE_EDITED).cbDepth).toBeCloseTo(1.8, 9)
  })

  it('picks tools that fit every cut (design-v0.2.md fit table, plan-v0.4.md plunge)', () => {
    const mill = LID_TOOLS.mill.diameter
    for (const size of [SCREWS.fastener, BOLT_CIRCLE_EDITED]) {
      // helical boring of the clearance hole: d / 2 < DC < d
      const d = counterboreSizes(size).diameter
      expect(mill).toBeGreaterThan(d / 2)
      expect(mill).toBeLessThan(d)
      expect(mill).toBeLessThanOrEqual(counterboreSizes(size).cbDiameter)
    }
    expect(mill).toBeLessThanOrEqual(VENTS.width)
    expect(mill).toBeLessThanOrEqual(CUTOUT.diameter)
    const cs = countersinkSizes(SCREWS.fastener)
    expect(LID_TOOLS.chamfer.diameter).toBeGreaterThanOrEqual(cs.csDiameter)
    expect(LID_TOOLS.chamfer.tipDiameter).toBeLessThanOrEqual(cs.diameter)
    expect(LID_TOOLS.chamfer.angle).toBe(cs.csAngle)
    expect(LID_TOOLS.profile.diameter).toBeLessThanOrEqual(LID_PROFILE.slotWidth)
  })

  it('leaves the slot on the board along Y, off it along X (D40: 255 × 200)', () => {
    const b = chainBounds(outline.elements)!
    const marginU = Math.min(LID_STOCK.length / 2 + b.min[0], LID_STOCK.length / 2 - b.max[0])
    const marginV = Math.min(LID_STOCK.width / 2 + b.min[1], LID_STOCK.width / 2 - b.max[1])
    expect(marginU).toBeCloseTo(2.75, 2)
    expect(marginV).toBeCloseTo(11.43, 2)
    expect(marginU).toBeLessThan(LID_PROFILE.slotWidth)
    expect(marginV).toBeGreaterThanOrEqual(LID_PROFILE.slotWidth)
    // front and back keep a strip beyond the slot; left and right are free
    expect(freeSides(holdInput)).toEqual([false, true, false, true])
  })

  it('moves counted tabs off the free left and right sides (TB1)', () => {
    const length = chainLength(outline)
    const nominal = Array.from({ length: 6 }, (_, k) => ((k + 0.5) * length) / 6)
    const held = holdTest(holdInput)
    const r = resolveTabs(holdInput, nominal, false)
    // tabs 1 and 4 fall on the right and left ends of the oval: moved to the nearest held place
    expect(r.moved).toEqual([1, 4])
    expect(r.unheld).toEqual([])
    r.centres.forEach((c, k) => {
      if (!r.moved.includes(k)) expect(c).toBe(nominal[k])
      const at = pointAt(c)
      // still on the right / left end, now over the back / front strip
      if (k === 1 || k === 4) expect(Math.abs(at[0])).toBeGreaterThan(85)
      for (let d = -3; d <= 3; d += 0.25) expect(held(c + d), `tab ${k} at ${d}`).toBe(true)
    })
    expect(
      nominal
        .slice(1, 2)
        .concat(nominal[4]!)
        .some((c) => held(c)),
    ).toBe(false)
    // deterministic, and entered positions are never moved
    expect(resolveTabs(holdInput, nominal, false).centres).toEqual(r.centres)
    const entered = resolveTabs(holdInput, nominal, true)
    expect(entered.centres).toEqual(nominal)
    expect(entered.unheld).toEqual([1, 4])
  })
})
