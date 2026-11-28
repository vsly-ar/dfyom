// A countersink wider than the V-bit's cone (hardening DF142, user TG #488): the M6 countersink
// Ø6.4 → Ø13.84 takes the library's 1/4" 90° V-bit (cut in levels after the bore) instead of
// asking for a Ø12 chamfer mill; a mill that cuts it in one pass still wins; the findings name the
// real reason when nothing fits (shank wider than the cone, the edge's core not cleared).
// Spec: docs/modes/plan-v0.4.md#chamfers-wider-than-the-cutting-edge-hardening-df142
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { uiSource } from '../commands/testing'
import type { DfmWarning } from '../geometry/model'
import { designSetup, type DesignSetup } from './design.fixture'

const ui = uiSource()

// flutes longer than the 20 mm stock: a through hole's walls need them (DF89)
const tool = (values: object) => ({
  fluteLength: '25',
  overallLength: '60',
  fluteCount: '1',
  ...values,
})
const QUARTER_FLAT = tool({ name: '1/4" 1F end mill', type: 'flatEndMill', diameter: '1/4"' })
const QUARTER_VBIT = tool({
  name: '90° V-bit 1/4"',
  type: 'chamferMill',
  diameter: '1/4"',
  angle: '90',
  fluteLength: '10',
})

async function add(s: DesignSetup, values: object): Promise<string> {
  return ((await s.run('library.tool.add', { values })) as { id: string }).id
}
const libraryIdOf = (s: DesignSetup, id: string) => {
  const t = s.op(id).tool
  return t?.kind === 'specific' ? s.d.doc.snapshots[t.snapshotId]!.libraryItemId : t
}
const warnings = (s: DesignSetup) =>
  (
    expectOk(s.d.query('design.warning.list', { partId: s.partId }, ui)).value as {
      warnings: DfmWarning[]
    }
  ).warnings

describe('countersink wider than the cone (DF142)', () => {
  it('the M6 countersink takes the 1/4" V-bit after the 1/4" end mill bores the hole', async () => {
    const s = await designSetup()
    const flat = await add(s, QUARTER_FLAT)
    const vbit = await add(s, QUARTER_VBIT)
    await s.run('design.hole.add', {
      partId: s.partId,
      center: ['30', '30'],
      fastener: 'M6',
      type: 'countersink',
      // the user's Ø6.4 → Ø13.84 (close fit; dk 13.44 + 2 × 0.2 head sink)
      fit: 'close',
    })
    await s.run('project.apply', {})
    expect(libraryIdOf(s, 'hole1_drill')).toBe(flat)
    expect(libraryIdOf(s, 'hole1_countersink')).toBe(vbit)
    const codes = warnings(s)
      .filter((w) => w.operation === 'hole1_countersink')
      .map((w) => w.code)
    expect(codes).not.toContain('dfm.chamferNoTool')
    expect(codes).not.toContain('dfm.toolUnfit')
  })

  it('a chamfer mill that cuts it in one pass still wins over the V-bit', async () => {
    const s = await designSetup()
    await add(s, QUARTER_FLAT)
    await add(s, QUARTER_VBIT)
    const big = await add(
      s,
      tool({ name: 'Chamfer 16', type: 'chamferMill', diameter: '16', angle: '90' }),
    )
    await s.run('design.hole.add', {
      partId: s.partId,
      center: ['30', '30'],
      fastener: 'M6',
      type: 'countersink',
      // the user's Ø6.4 → Ø13.84 (close fit; dk 13.44 + 2 × 0.2 head sink)
      fit: 'close',
    })
    await s.run('project.apply', {})
    expect(libraryIdOf(s, 'hole1_countersink')).toBe(big)
  })

  it('names the reason: a shank wider than the cone', async () => {
    const s = await designSetup()
    await add(s, QUARTER_FLAT)
    await add(s, { ...QUARTER_VBIT, shankDiameter: '8' })
    await s.run('design.hole.add', {
      partId: s.partId,
      center: ['30', '30'],
      fastener: 'M6',
      type: 'countersink',
      // the user's Ø6.4 → Ø13.84 (close fit; dk 13.44 + 2 × 0.2 head sink)
      fit: 'close',
    })
    expect(warnings(s).find((w) => w.code === 'dfm.chamferNoTool')).toMatchObject({
      operation: 'hole1_countersink',
      params: expect.objectContaining({ angle: 90, reason: 'shank' }),
    })
  })

  it("names the reason: an inside circle profile leaves its core, the shank's way down", async () => {
    const s = await designSetup()
    await add(s, QUARTER_VBIT)
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['50', '30'], diameter: '20' },
      side: 'inside',
      tabs: { count: '0' },
    })
    // 3.5 mm wide: more than the V-bit's 3.175 mm cutting edge, so levels only
    await s.run('design.chamfer.add', { partId: s.partId, edgeOf: 'profile1', width: '3.5' })
    expect(warnings(s).find((w) => w.code === 'dfm.chamferNoTool')).toMatchObject({
      params: expect.objectContaining({ reason: 'bore' }),
    })
    // a narrow chamfer is one ring: the core does not matter
    await s.run('design.chamfer.update', {
      partId: s.partId,
      operationId: 'chamfer1',
      width: '1',
    })
    expect(warnings(s).map((w) => w.code)).not.toContain('dfm.chamferNoTool')
  })
})
