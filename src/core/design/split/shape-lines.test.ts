// Split parts 4e: split lines as shapes. The layout of a curved line (cells as regions that cover
// the footprint once), the refusals of a shape line, a shape edit regenerating the pieces, keys on
// a polyline's straight segments only (`curved` on an arc-only joint), every inside corner of the
// pieces' outlines ≥ the tool radius, dowels under a curved line, findings near it, and the table
// top's pieces reassembling it.
// Spec: docs/modes/split-parts.md#implementation-4e
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { regionArea, type Region } from '../../geometry/2d/model'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { checkPartFits } from '../../plan/validity'
import { designSetup, type DesignSetup } from '../design.fixture'
import { loadPart, partGeometryInput } from '../load'
import type { PartDTO } from '../part.dto'
import { resolveShape, smallestInsideRadius } from '../shape'
import { shapeRegion, splitLayout, splitNumbersOf } from './layout'
import { planPieces } from './pieces'
import { TABLE_CURVE, TABLE_LINE, TABLE_STOCK, tableCommands } from './split.fixture'

const region2d = nodeRegion2d()

interface SplitResult {
  pieces: { partId: string; name: string; index: number; blank: number[] }[]
  findings: { severity: string; message: string; params: Record<string, unknown> }[]
}

async function table(): Promise<DesignSetup> {
  const s = await designSetup({ stock: TABLE_STOCK, services: { region2d } })
  for (const [name, args] of tableCommands(s.partId)) await s.run(name, args)
  return s
}

const split = (s: DesignSetup, args: object) =>
  s.run('design.split.set', { partId: s.partId, split: args }) as Promise<SplitResult>

const byRule = (r: SplitResult, rule: string) => r.findings.filter((f) => f.params['rule'] === rule)

const pieces = (s: DesignSetup): PartDTO[] =>
  Object.values(s.d.doc.parts)
    .filter((p) => p.derivedFrom?.partId === s.partId)
    .sort((a, b) => a.derivedFrom!.index - b.derivedFrom!.index)

const mm = (q: { exact: { num: string; den: string } }) =>
  Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))

/** A piece's outline profile as a region of the source frame (moved back by its offset). */
function outlineBack(s: DesignSetup, piece: PartDTO): Region {
  const input = expectOk(partGeometryInput(s.d.doc, piece.id, region2d))
  const at = piece.operations.findIndex((o) => o.kind === 'profile' && o.side === 'outside')
  const g = input.operations[at]!
  if (g.kind !== 'profile') throw new Error('no outline')
  const r = shapeRegion(g.shape)!
  const [ox, oy] = piece.offset!.map(mm)
  return {
    pieces: r.pieces.map((p) => ({
      outer: shift(p.outer, -ox!, -oy!),
      holes: p.holes.map((h) => shift(h, -ox!, -oy!)),
    })),
  }
}

function shift(l: Region['pieces'][number]['outer'], dx: number, dy: number) {
  const m = (p: readonly [number, number]): [number, number] => [p[0] + dx, p[1] + dy]
  return {
    elements: l.elements.map((e) =>
      e.kind === 'line'
        ? { ...e, a: m(e.a), b: m(e.b) }
        : { ...e, a: m(e.a), b: m(e.b), centre: m(e.centre) },
    ),
  }
}

/**
 * The pieces' outlines moved back cover the source footprint once: no point in two, the misses
 * (clearance band, T-bones) a small share; sampled every `step` mm off the grid lines.
 */
function coversOnce(s: DesignSetup, footprint: Region, step: number): number {
  const outlines = pieces(s).map((p) => outlineBack(s, p))
  let inside = 0
  let missed = 0
  for (let x = 0.37; x < 1210; x += step)
    for (let y = 0.41; y < 1210; y += step) {
      const want = region2d.contains(footprint, [x, y])
      const hits = outlines.filter((o) => region2d.contains(o, [x, y])).length
      expect(hits, `${x} ${y}`).toBeLessThanOrEqual(want ? 1 : 0)
      if (want) inside++
      if (want && hits === 0) missed++
    }
  return missed / inside
}

/** The waste around a piece: a large rounded box minus the piece. */
function around(piece: Region): Region {
  const box = expectOk(
    resolveShape(region2d, [
      {
        kind: 'rectangle',
        op: 'add',
        center: [605, 605],
        length: 2000,
        width: 2000,
        cornerRadius: 50,
      },
    ]),
  )
  if (box.kind !== 'region') throw new Error('not a region')
  return expectOk(region2d.difference(box.region, piece))
}

const disc = (): Region => {
  const r = shapeRegion({ center: [605, 605], contour: { kind: 'circle', radius: 600 } })!
  return r
}

describe('split lines as shapes (4e)', () => {
  it('a curved line makes region cells that cover the footprint once', async () => {
    const s = await table()
    const r = await split(s, { lines: [{ shape: 'shape1' }] })
    expect(r.pieces).toHaveLength(2)
    const loaded = expectOk(loadPart(s.d.doc, s.partId, 'test'))
    const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const stock = { length: 1210, width: 1210, thickness: 25 }
    const nums = expectOk(splitNumbersOf(region2d, loaded.dto.split!, loaded.dto.shapes, stock))
    const layout = expectOk(
      splitLayout(region2d, nums, stock, loaded.part.operations, input.operations),
    )
    expect(layout.cells.map((c) => c.cut !== undefined)).toEqual([true, true])
    const total = layout.cells.reduce((a, c) => a + regionArea(c.region), 0)
    expect(total).toBeCloseTo(regionArea(disc()), 0)
    const overlap = expectOk(region2d.intersect(layout.cells[0]!.region, layout.cells[1]!.region))
    expect(regionArea(overlap)).toBeLessThan(1e-3)
    // numbered by Y, then X: the left piece first (the arcs bulge both ways, the centres differ)
    expect(layout.cells[0]!.rect.x0).toBeLessThan(layout.cells[1]!.rect.x0)
    // butt: the outlines reassemble the disc exactly
    expect(coversOnce(s, disc(), 7)).toBeLessThan(1e-3)
  })

  it('refuses a shape that is no open path, a line not reaching the edges, a self-crossing one', async () => {
    const s = await table()
    const fail = async (items: object[], rule: string) => {
      const { shapeId } = (await s.run('design.shape.add', { partId: s.partId, items })) as {
        shapeId: string
      }
      const e = await s.fail(
        'design.split.set',
        { partId: s.partId, split: { lines: [{ shape: shapeId }] } },
        'model.invariant',
      )
      expect(e.issues?.[0]).toMatchObject({ rule, path: ['split', 'lines', 0] })
    }
    await fail([{ kind: 'circle', center: ['600', '600'], diameter: '100' }], 'lineShape')
    await fail(
      [
        {
          kind: 'path',
          start: ['600', '0'],
          segments: [{ kind: 'line', to: ['600', '700'] }],
          closed: false,
        },
      ],
      'lineEnds',
    )
    await fail(
      [
        {
          kind: 'path',
          start: ['500', '0'],
          segments: [
            { kind: 'line', to: ['700', '600'] },
            { kind: 'line', to: ['500', '600'] },
            { kind: 'line', to: ['700', '0'] },
            { kind: 'line', to: ['700', '-5'] },
          ],
          closed: false,
        },
      ],
      'lineCrossing',
    )
    expect(pieces(s)).toHaveLength(0)
  })

  it('the shape a line uses cannot be removed; editing it regenerates the pieces', async () => {
    const s = await table()
    await split(s, { lines: [{ shape: 'shape1' }] })
    const e = await s.fail(
      'design.shape.remove',
      { partId: s.partId, shapeId: 'shape1' },
      'design.referenced',
    )
    expect(e.issues?.[0]).toMatchObject({ path: ['split', 'lines', 0], rule: 'referenced' })
    const before = pieces(s).map((p) => p.operations.find((o) => o.id === 'split1_outline'))
    await s.run('design.shape.update', {
      partId: s.partId,
      shapeId: 'shape1',
      items: [
        { ...TABLE_CURVE, start: ['505', '0'], segments: [{ kind: 'line', to: ['705', '1210'] }] },
      ],
    })
    const after = pieces(s).map((p) => p.operations.find((o) => o.id === 'split1_outline'))
    expect(after).toHaveLength(2)
    expect(after).not.toEqual(before)
    expect(coversOnce(s, disc(), 9)).toBeLessThan(1e-3)
  })

  it('keys on the straight segments of a polyline only; a joint along arcs only is `curved`', async () => {
    const s = await table()
    const r = await split(s, { lines: [{ shape: 'shape1' }, TABLE_LINE], joint: 'puzzle' })
    expect(r.pieces).toHaveLength(4)
    expect(byRule(r, 'outsideTravel')).toEqual([])
    const loaded = expectOk(loadPart(s.d.doc, s.partId, 'test'))
    const planned = expectOk(planPieces(loaded, loaded.dto.split!, region2d))
    const keys = planned.keys.keys
    // on the curve: on its straight runs (x = 605), every key's frame along ±Y
    const curve = keys.filter((k) => k.line === 0)
    expect(curve.length).toBeGreaterThanOrEqual(3)
    for (const k of curve) {
      expect(k.shape).toBe('shape1')
      expect(Math.abs(k.frame!.t[0])).toBeLessThan(1e-9)
      const y = k.frame!.o[1] + k.u * k.frame!.t[1]
      expect(y < 300 || y > 540, `${y}`).toBe(true)
    }
    // on the straight line: keys too, the lower piece male
    expect(keys.filter((k) => k.line === 1).length).toBeGreaterThanOrEqual(2)
    expect(byRule(r, 'keyFit').filter((f) => f.params['reason'] !== 'near')).toEqual([])
    // every piece valid on its blank, its outline's inside corners for the Ø6 tool
    for (const p of pieces(s)) {
      const fit = checkPartFits(p, s.d.doc.snapshots[p.stock]!, 'test', region2d)
      expect(fit.isOk() ? 'ok' : fit.unwrapErr().issues, p.name).toBe('ok')
      // as in keys.test.ts: the waste around the piece, its inside corners the tool's
      expect(smallestInsideRadius(around(outlineBack(s, p))) ?? Infinity).toBeGreaterThanOrEqual(
        3 - 1e-6,
      )
    }
    // the four outlines reassemble the disc up to the clearance band of the keys
    expect(coversOnce(s, disc(), 5)).toBeLessThan(0.002)
  })

  it('an arc-only line takes no key: `curved`', async () => {
    const s = await table()
    const { shapeId } = (await s.run('design.shape.add', {
      partId: s.partId,
      items: [
        {
          kind: 'path',
          start: ['605', '0'],
          segments: [{ kind: 'arc', to: ['605', '1210'], radius: '800', cw: true }],
          closed: false,
        },
      ],
    })) as { shapeId: string }
    const r = await split(s, { lines: [{ shape: shapeId }], joint: 'puzzle' })
    expect(r.pieces).toHaveLength(2)
    expect(byRule(r, 'keyFit').map((f) => f.params['reason'])).toEqual(['curved'])
  })

  it('a half lap refuses a shape line', async () => {
    const s = await table()
    const e = await s.fail(
      'design.split.set',
      { partId: s.partId, split: { lines: [{ shape: 'shape1' }], joint: 'halfLap' } },
      'model.invariant',
    )
    expect(e.issues?.[0]?.rule).toBe('lapCrossing')
  })

  it('dowels on a level under a curved line; a hole crossed by the curve is `cutsFeature`', async () => {
    const s = await table()
    await s.run('design.drilling.add', {
      partId: s.partId,
      center: ['605', '600'],
      diameter: '8',
      bottom: 'through',
    })
    const r = await split(s, { lines: [{ shape: 'shape1' }], levels: ['-12.5'], dowels: {} })
    expect(r.pieces).toHaveLength(4)
    // dowels on both glue faces (a depth warning on the 25 mm board only)
    expect(byRule(r, 'dowelFit').map((f) => f.severity)).not.toContain('error')
    const dowels = pieces(s).flatMap((p) => p.operations.filter((o) => o.id.includes('dowel')))
    expect(dowels.length).toBeGreaterThan(0)
    expect(byRule(r, 'cutsFeature').map((f) => f.params['operationId'])).toContain('drill2')
    // each through hole goes to one piece per band; drill2, on the line, to the piece past it in +X
    const holes = pieces(s).map((p) =>
      p.operations.filter((o) => o.kind === 'drilling' && !o.id.includes('dowel')).map((o) => o.id),
    )
    expect(holes).toEqual([['drill1'], ['drill2'], ['drill1'], ['drill2']])
  })
})
