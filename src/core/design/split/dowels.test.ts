// Split parts 4b-1: dowels on levels. Placement on the enclosure (inside the glue face, clear of
// the cavity and the rim holes), the holes in both pieces at the same X/Y (lower from its top,
// upper from its bottom), given positions kept, source edits keeping positions and flagging them,
// the dowel findings, the depth cap and the args' validation.
// Spec: docs/modes/split-parts.md#implementation-4b
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { uiSource } from '../../commands/testing'
import { regionContains } from '../../geometry/2d/measure'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { checkPartFits } from '../../plan/validity'
import { designSetup, type DesignSetup } from '../design.fixture'
import { DOWEL_WALL_MIN } from '../dowel'
import { loadPart } from '../load'
import type { OperationDTO, PartDTO } from '../part.dto'
import { clearRegion, glueFaces, splitGeometry } from './dowels'
import { ENCLOSURE_LEVEL, ENCLOSURE_STOCK, enclosureCommands } from './split.fixture'

const region2d = nodeRegion2d()

interface SplitResult {
  pieces: { partId: string; name: string; index: number; blank: number[] }[]
  findings: { severity: string; message: string; params: Record<string, unknown> }[]
}

async function enclosure(): Promise<DesignSetup> {
  const s = await designSetup({ stock: ENCLOSURE_STOCK, services: { region2d } })
  for (const [name, args] of enclosureCommands(s.partId)) await s.run(name, args)
  return s
}

const pieces = (s: DesignSetup): PartDTO[] =>
  Object.values(s.d.doc.parts)
    .filter((p) => p.derivedFrom?.partId === s.partId)
    .sort((a, b) => a.derivedFrom!.index - b.derivedFrom!.index)

const mm = (q: { exact: { num: string; den: string } }) =>
  Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))

type Drilling = Extract<OperationDTO, { kind: 'drilling' }>
const dowelOps = (p: PartDTO) =>
  p.operations.filter((o): o is Drilling => o.id.startsWith('split1_dowel'))

const rules = (r: SplitResult) => r.findings.map((f) => f.params['rule'])
const reasons = (r: SplitResult, rule: string) =>
  r.findings.filter((f) => f.params['rule'] === rule).map((f) => f.params['reason'])

const split = (s: DesignSetup, args: object, confirm = false) =>
  s.run('design.split.set', {
    partId: s.partId,
    split: args,
    ...(confirm ? { confirm: true } : {}),
  }) as Promise<SplitResult>

function expectValidPieces(s: DesignSetup): void {
  for (const p of pieces(s)) {
    const fit = checkPartFits(p, s.d.doc.snapshots[p.stock]!, 'test', region2d)
    expect(fit.isOk() ? 'ok' : fit.unwrapErr().issues, p.name).toBe('ok')
  }
}

describe('dowels on levels (4b-1)', () => {
  it('places dowels on the enclosure level: clear of the cavity, in both pieces', async () => {
    const s = await enclosure()
    const r = await split(s, { levels: [ENCLOSURE_LEVEL], dowels: {} })
    const dowels = s.part().split!.joint.dowels!
    // 6 mm dowels fit the corners and the 11 mm back wall; 16 mm deep (2.5 × Ø + 1)
    expect([mm(dowels.diameter), mm(dowels.depth)]).toEqual([6, 16])
    expect(dowels.holes.length).toBe(3)
    expect(dowels.holes.every((h) => h.level === 0)).toBe(true)
    // each hole keeps its wall to the cavity and the outline (the clear region, by geometry)
    const loaded = expectOk(loadPart(s.d.doc, s.partId, 'test'))
    const geo = expectOk(splitGeometry(loaded, s.part().split!, region2d))
    const [face] = glueFaces(geo.layout, s.part().split!)
    const clear = expectOk(clearRegion(region2d, face!, geo.removals, geo.W, 16))
    const grown = expectOk(region2d.offset(clear, 3.1 + DOWEL_WALL_MIN - 1e-3))
    for (const h of dowels.holes)
      expect(regionContains(grown, [mm(h.at[0]), mm(h.at[1])])).toBe(true)
    expect(rules(r)).not.toContain('dowelNear')
    expect(rules(r)).not.toContain('dowelFit')
    // the joint is the level's own rule now: 7 mm walls are too narrow for dowels there
    expect(r.findings.find((f) => f.params['rule'] === 'thinJoint')?.message).toMatch(
      /Ø6 dowels fit only where it is wider/,
    )
    const [tray, ring] = pieces(s)
    const tOff = tray!.offset!.map(mm)
    const rOff = ring!.offset!.map(mm)
    const ringW = mm(
      (s.d.doc.snapshots[ring!.stock]!.values as { width: { exact: { num: string; den: string } } })
        .width,
    )
    dowels.holes.forEach((h, i) => {
      const [x, y] = h.at.map(mm) as [number, number]
      const t = dowelOps(tray!)[i]!
      const u = dowelOps(ring!)[i]!
      expect([t.id, t.name, t.on, t.bottom]).toEqual([
        `split1_dowel${i + 1}`,
        `Dowel hole ${i + 1}`,
        'stock.top',
        'flat',
      ])
      expect([u.id, u.on]).toEqual([`split1_dowel${i + 1}`, 'stock.bottom'])
      expect(t.center.map(mm)).toEqual([x + tOff[0]!, y + tOff[1]!].map((v) => +v.toFixed(6)))
      // the bottom face frame mirrors Y: v = blank width − y
      expect(u.center.map(mm)).toEqual(
        [x + rOff[0]!, ringW - (y + rOff[1]!)].map((v) => +v.toFixed(6)),
      )
      expect([mm(t.diameter), mm(t.depth!), mm(u.depth!)]).toEqual([6.2, 16, 16])
    })
    // drilled before the piece is cut free
    expect(tray!.operations.at(-1)!.id).toBe('split1_outline')
    expectValidPieces(s)
  })

  it('each glue face of a level and two lines gets its own dowels', async () => {
    const s = await enclosure()
    const r = await split(s, {
      levels: [ENCLOSURE_LEVEL],
      lines: [
        { axis: 'x', at: '125' },
        { axis: 'y', at: '100' },
      ],
      dowels: { diameter: '4' },
    })
    expect(r.pieces).toHaveLength(8)
    expect(reasons(r, 'dowelFit')).toEqual([])
    expect(rules(r)).not.toContain('dowelNear')
    // pieces 1–4 are the lower layer, 5–8 the upper; each pair shares its holes
    for (let n = 0; n < 4; n++) {
      const lower = dowelOps(pieces(s)[n]!).map((o) => o.id)
      expect(lower.length).toBeGreaterThanOrEqual(2)
      expect(dowelOps(pieces(s)[n + 4]!).map((o) => o.id)).toEqual(lower)
    }
    expectValidPieces(s)
  })

  it('keeps given positions and the level index; a source edit keeps them and flags them', async () => {
    const s = await enclosure()
    // in the 11 mm back wall (y 177.5 … 188.5)
    const holes = [
      { level: 0, at: ['60', '183'] },
      { level: 0, at: ['190', '183'] },
    ]
    const r = await split(s, { levels: [ENCLOSURE_LEVEL], dowels: { diameter: '4', holes } })
    expect(rules(r)).not.toContain('dowelNear')
    const at = () => s.part().split!.joint.dowels!.holes.map((h) => [h.level, ...h.at.map(mm)])
    expect(at()).toEqual([
      [0, 60, 183],
      [0, 190, 183],
    ])
    // the level moves (a drag sends the same holes): they stay, on the moved level
    await split(s, { levels: ['-35'], dowels: { diameter: '4', holes } })
    expect(at()).toEqual([
      [0, 60, 183],
      [0, 190, 183],
    ])
    expect(mm(s.part().split!.joint.dowels!.depth)).toBe(11)
    // a deep hole drilled next to the first dowel: the dowel stays and is flagged
    await s.run('design.drilling.add', {
      partId: s.partId,
      on: 'facing2.floor',
      center: ['64.5', '183'],
      diameter: '3',
      bottom: 'flat',
      depth: '22',
    })
    expect(at()[0]).toEqual([0, 60, 183])
    const list = s.d.query('design.warning.list', { partId: s.partId }, uiSource())
    const near = (
      expectOk(list).value as { warnings: { params: Record<string, unknown> }[] }
    ).warnings.filter((w) => w.params['rule'] === 'dowelNear')
    expect(near.map((w) => w.params['hole'])).toEqual([1])
  })

  it('dowelFit: one hole on a face, a hole off every face, a depth the pieces cannot hold', async () => {
    const s = await enclosure()
    const r = await split(s, {
      levels: [ENCLOSURE_LEVEL],
      dowels: {
        diameter: '4',
        depth: '45',
        holes: [
          { level: 0, at: ['3.75', '100'] },
          { level: 0, at: ['125', '-20'] },
        ],
      },
    })
    expect(reasons(r, 'dowelFit').sort()).toEqual(['count', 'depth', 'outside'])
    // the hole off the footprint is in no piece; the depth is cut to the blank less 1 mm
    const [tray] = pieces(s)
    expect(dowelOps(tray!).map((o) => [o.id, mm(o.depth!)])).toEqual([['split1_dowel1', 39]])
  })

  it('dowels: null (or absent) is a butt level; a level without holes gets placed', async () => {
    const s = await enclosure()
    await split(s, { levels: [ENCLOSURE_LEVEL], dowels: { diameter: '5' } })
    expect(pieces(s).every((p) => dowelOps(p).length > 0)).toBe(true)
    // a second level: the first keeps its holes, the new one gets its own
    const before = s.part().split!.joint.dowels!.holes
    await split(s, {
      levels: [ENCLOSURE_LEVEL, '-25'],
      dowels: {
        holes: before.map((h) => ({ level: h.level, at: h.at.map((q) => q.source) })),
      },
    })
    const after = s.part().split!.joint.dowels!
    expect(mm(after.diameter)).toBe(5)
    expect(after.holes.slice(0, before.length)).toEqual(before)
    expect(after.holes.some((h) => h.level === 1)).toBe(true)
    await split(s, { levels: [ENCLOSURE_LEVEL], dowels: null })
    expect(s.part().split!.joint.dowels).toBeUndefined()
    expect(pieces(s).every((p) => dowelOps(p).length === 0)).toBe(true)
  })

  it('refuses a dowel Ø out of range and a hole on a missing level', async () => {
    const s = await enclosure()
    const e = await s.fail(
      'design.split.set',
      {
        partId: s.partId,
        split: {
          levels: [ENCLOSURE_LEVEL],
          dowels: { diameter: '30', holes: [{ level: 1, at: ['10', '10'] }] },
        },
      },
      'model.invariant',
    )
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([
      ['split.dowels.diameter', 'range'],
      ['split.dowels.holes.0.level', 'range'],
    ])
  })
})
