// Regression (LLM black-box test, 2026-11-22, F3): pockets of the enclosure outline inset by a
// few mm, built the way an agent builds an inset (each arc of the resolved outline scaled about
// its centre, ends rounded to 0.1 µm), failed at 4.83 and 5.00 mm with "the 2D library returned
// an open loop" (the region alone) and "an offset hole lies in no outer loop" (a rectangle minus
// clamp keep-outs minus the inset). The rounded ends leave a 1 µm closing line between two arcs;
// the library's offset kept a zero-width spike there, and the ring tree's offsets of offsets grew
// it into a broken loop. Doc: docs/architecture/shapes.md#implementation-k1
import { describe, expect, it } from 'vitest'
import type { Vec3 } from '../geometry/model'
import { regionArea, regionLoops, type Loop, type Region } from '../geometry/2d/model'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { definitionOf, resolveDefinition, type ShapeDefinition } from '../design/shape'
import { svgShapeItems } from '../design/shape-import'
import { ENCLOSURE_SECTIONS_SVG } from '../design/enclosure-sections.testing'
import { importSvg } from '../import/svg'
import { generateRegionPocket, type RegionPocketInput } from './region-pocket'
import { cutting, endMill, HEIGHTS, RATES } from './testing/fixtures'
import { placeLoops, pocketRapids, regionCoverage } from './testing/region-coverage'
import { violations } from './testing/rules'

interface NodeProcess {
  getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL, enc: 'utf8'): string }
}
const fs = (globalThis as unknown as { process: NodeProcess }).process.getBuiltinModule('node:fs')

const port = nodeRegion2d()
const D6 = endMill(6)
const R = 3
const CELL = 0.25

/** The resolved outline of the fixture drawing (shape1 of its import), in the shape frame. */
function outline(): Loop {
  const svg = importSvg(fs.readFileSync(ENCLOSURE_SECTIONS_SVG, 'utf8'), { unit: 'mm' }).unwrap()
  const items = svgShapeItems(svg.shapes[0]!, 'mm').unwrap()
  const r = resolveDefinition(port, definitionOf(items)).unwrap()
  if (r.kind !== 'region') throw new Error('the outline is a region')
  return r.region.pieces[0]!.outer
}

const OUTLINE = outline()
const f4 = (v: number) => Number(v.toFixed(4))

/** The agent's inset path item (its `offset2.js`): each arc scaled about its centre by (r − d)/r. */
function insetItem(d: number, op: 'add' | 'subtract'): ShapeDefinition[number] {
  let start: [number, number] | undefined
  const segments = OUTLINE.elements.map((e) => {
    if (e.kind !== 'arc') throw new Error('the outline is all arcs')
    const r = Math.hypot(e.a[0] - e.centre[0], e.a[1] - e.centre[1])
    const k = (r - d) / r
    const p = (q: readonly number[]): [number, number] => [
      f4(e.centre[0] + (q[0]! - e.centre[0]) * k),
      f4(e.centre[1] + (q[1]! - e.centre[1]) * k),
    ]
    start ??= p(e.a)
    return { kind: 'arc' as const, to: p(e.b), radius: f4(r - d), cw: false }
  })
  return { kind: 'path', op, start: start!, segments, closed: true }
}

const rectItem = (
  cx: number,
  cy: number,
  length: number,
  width: number,
  op: 'add' | 'subtract',
): ShapeDefinition[number] => ({
  kind: 'rectangle',
  op,
  center: [f4(cx - 0.002), f4(cy - 10.994)],
  length,
  width,
  cornerRadius: 4,
})

/** The inset region alone (the agent's skim pocket). */
const insetShape = (d: number): ShapeDefinition => [insetItem(d, 'add')]

/** A rectangle minus four clamp keep-outs minus the inset (the agent's edge-step pocket). */
const keepOutShape = (d: number): ShapeDefinition => [
  rectItem(125, 100, 262, 190, 'add'),
  ...[
    [45, 6],
    [205, 6],
    [45, 194],
    [205, 194],
  ].map(([x, y]) => rectItem(x!, y!, 34, 12, 'subtract')),
  insetItem(d, 'subtract'),
]

function pocketInput(region: Region, size: { length: number; width: number }): RegionPocketInput {
  return {
    planOperationId: 'op-inset',
    tool: D6,
    cutting: cutting(D6, { stepdown: 2 }),
    heights: HEIGHTS,
    stock: { ...size, thickness: 20 },
    operation: { region, onZ: 0, depth: 1 },
    strategy: {
      entry: 'helix',
      helixDiameter: 4.8,
      rampAngle: 3,
      finishAllowance: 0.2,
      finishStepdown: 1,
      direction: 'climb',
    },
    maxFeedRate: RATES,
  }
}

function placed(def: ShapeDefinition) {
  const r = resolveDefinition(port, def).unwrap()
  if (r.kind !== 'region') throw new Error('a region')
  const p = placeLoops(regionLoops(r.region))
  return { region: port.normalise(p.loops).unwrap(), size: p.size }
}

const insets = Array.from({ length: 41 }, (_, i) => Number((4.7 + i * 0.01).toFixed(2)))

describe('the 2D port on the inset', () => {
  it('leaves no zero-width spike in its offsets', () => {
    for (const d of [4.8, 4.83, 5]) {
      const r = resolveDefinition(port, insetShape(d)).unwrap()
      if (r.kind !== 'region') throw new Error('a region')
      for (const by of [0.5, 3, 3.2]) {
        const out = port.offset(r.region, by).unwrap()
        for (const l of regionLoops(out)) {
          const seen = new Set<string>()
          for (const e of l.elements) {
            const k = `${e.a[0].toFixed(7)},${e.a[1].toFixed(7)}`
            expect(seen.has(k), `inset ${d}, offset ${by}: ${k} visited twice`).toBe(false)
            seen.add(k)
          }
        }
      }
    }
  })
})

describe('pockets of the enclosure outline inset by 4.70–5.10 mm', () => {
  for (const [name, shape] of [
    ['the inset region', insetShape],
    ['a rectangle − keep-outs − the inset', keepOutShape],
  ] as const)
    it(`${name}: every inset generates a valid toolpath`, { timeout: 120_000 }, () => {
      const failed: string[] = []
      for (const d of insets) {
        const { region, size } = placed(shape(d))
        const tp = generateRegionPocket(pocketInput(region, size), port)
        if (tp.isErr()) failed.push(`${d}: ${tp.unwrapErr().message}`)
      }
      expect(failed).toEqual([])
    })

  for (const [name, shape] of [
    ['the inset region', insetShape],
    ['a rectangle − keep-outs − the inset', keepOutShape],
  ] as const)
    it(
      `${name} at 4.83 mm: no leftover, no gouge, uncut = region − opening`,
      { timeout: 60_000 },
      () => {
        const { region, size } = placed(shape(4.83))
        const inp = pocketInput(region, size)
        const tp = generateRegionPocket(inp, port).unwrap()
        const wall = port.offset(region, R - 1e-4).unwrap()
        expect(
          violations(tp, {
            feedRate: inp.cutting.feedRate,
            plungeRate: inp.cutting.plungeRate,
            rampAngle: 3,
            retractZ: HEIGHTS.retractHeight,
            lowRapids: true,
            clearanceZ: HEIGHTS.clearanceHeight,
            targetZ: -1,
            contains: (p: Vec3) =>
              p[2] > 1e-9 || (p[2] >= -1 - 1e-9 && port.contains(wall, [p[0], p[1]])),
          }),
        ).toEqual([])
        const c0 = port.offset(region, R).unwrap()
        const cov = regionCoverage(region, c0, tp, D6, size, -1, CELL)
        const opening = port.offset(c0, -R).unwrap()
        const rest = port.difference(region, opening).unwrap()
        const expectedRest = regionArea(rest)
        expect(cov.gouge).toBe(0)
        expect(pocketRapids(tp, inp, CELL)).toEqual([])
        expect(cov.belowFloor).toBe(0)
        expect(cov.leftover).toBeLessThan(0.5)
        // + 1 mm² and 0.25 mm² per rest piece (the keep-outs' 8 sharp corners): their boundary
        // cells classify either way
        expect(Math.abs(cov.rest - expectedRest)).toBeLessThan(
          0.01 * expectedRest + 1 + 0.25 * rest.pieces.length,
        )
      },
    )
})
