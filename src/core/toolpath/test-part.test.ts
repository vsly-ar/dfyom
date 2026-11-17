/**
 * Cross-check: the material the toolpaths of the geometry test part sweep (heightmap simulation)
 * matches the part's analytic removal. Doc: docs/modes/plan-v0.1.md#toolpath-generators-task-210
 */
import { describe, expect, it } from 'vitest'
import { contourParam, perimeter } from '../geometry/contour'
import type { OperationGeometry, Vec2 } from '../geometry/model'
import { TEST_STOCK, testPart } from '../geometry/testing/test-part'
import { generateDrilling } from './drilling'
import { generateFacing } from './facing'
import type { ProfileOperation, Toolpath, ToolpathTool } from './model'
import { generatePocket } from './pocket'
import { generateProfile } from './profile'
import {
  bullNose,
  drill,
  drillingInput,
  endMill,
  facingInput,
  pocketInput,
  profileInput,
} from './testing/fixtures'
import { Heightmap, insideDistance } from './testing/oracles'

const T = TEST_STOCK.thickness

/** Tool and toolpath per test-part operation. */
function toolpaths(): { tool: ToolpathTool; tp: Toolpath }[] {
  const out: { tool: ToolpathTool; tp: Toolpath }[] = []
  for (const op of testPart().operations) {
    if (op.kind === 'facing') {
      const tool = endMill(12)
      out.push({
        tool,
        tp: generateFacing(facingInput(TEST_STOCK, tool, { operation: op })).unwrap(),
      })
    } else if (op.kind === 'pocket') {
      const tool = bullNose(6, 2)
      out.push({ tool, tp: generatePocket(pocketInput(TEST_STOCK, op, tool)).unwrap() })
    } else if (op.kind === 'drilling') {
      const b = op.bottom.kind
      const tool = b === 'flat' ? endMill(4) : drill(6)
      const strategy =
        b === 'flat'
          ? ({ cycle: 'helix', helixPitch: 1, breakthrough: 0.5, direction: 'climb' } as const)
          : b === 'through'
            ? ({ cycle: 'simple', breakthrough: 0.5 } as const)
            : ({ cycle: 'peck', peckDepth: 6, breakthrough: 0.5 } as const)
      out.push({
        tool,
        tp: generateDrilling(drillingInput(TEST_STOCK, op, tool, strategy)).unwrap(),
      })
    } else {
      const tool = endMill(6)
      out.push({ tool, tp: generateProfile(profileInput(TEST_STOCK, op, tool)).unwrap() })
    }
  }
  return out
}

function inTab(op: ProfileOperation, q: Vec2, d: number): boolean {
  const c = op.shape.contour
  const P = perimeter(c)
  const s = contourParam(c, [q[0] - op.shape.center[0], q[1] - op.shape.center[1]])
  const first = c.kind === 'circle' ? 0 : (c.length - 2 * c.cornerRadius) / 2
  if (!(d <= 0 && d >= -op.slotWidth)) return false
  for (let i = 0; i < op.tabs.count; i++) {
    const off = ((((s - first - (i * P) / op.tabs.count) % P) + P * 1.5) % P) - P / 2
    if (Math.abs(off) <= op.tabs.width / 2) return true
  }
  return false
}

/** Analytic height of the test part's top surface at `p` (−T where cut through). */
function expectedHeight(p: Vec2, ops: readonly OperationGeometry[]): number {
  let h = 0
  for (const op of ops) {
    if (op.kind === 'facing') h = Math.min(h, -op.depth)
    else if (op.kind === 'pocket') {
      const d = insideDistance(op.shape.contour, op.shape.center, p)
      if (d < 0) continue
      const floor = op.onZ - op.depth
      const f = op.floorRadius
      h = Math.min(h, d >= f ? floor : floor + f - Math.sqrt(f * f - (f - d) * (f - d)))
    } else if (op.kind === 'drilling') {
      const r = Math.hypot(p[0] - op.center[0], p[1] - op.center[1])
      const R = op.diameter / 2
      if (r > R) continue
      const b = op.bottom
      if (b.kind === 'through') h = -T
      else {
        const full = op.onZ - b.depth
        const cone =
          b.kind === 'drillPoint' ? (R - r) / Math.tan((b.pointAngle * Math.PI) / 360) : 0
        h = Math.min(h, full - cone)
      }
    } else {
      const d = insideDistance(op.shape.contour, op.shape.center, p)
      if (d > 0 || d < -op.slotWidth) continue
      h = Math.min(h, inTab(op, p, d) ? -T + op.tabs.thickness : -T)
    }
  }
  return Math.max(h, -T)
}

describe('test part: toolpaths remove what the geometry removes', () => {
  it('matches the analytic removal on a 0.25 mm heightmap', { timeout: 20_000 }, () => {
    const ops = testPart().operations
    const profile = ops.find((o): o is ProfileOperation => o.kind === 'profile')!
    const map = new Heightmap(TEST_STOCK.length, TEST_STOCK.width, 0.25)
    for (const { tool, tp } of toolpaths()) map.sweep(tool, tp)

    const gouges: string[] = []
    const left: string[] = []
    let compared = 0
    let besideTabs = 0
    for (let i = 0; i < map.nx; i++)
      for (let j = 0; j < map.ny; j++) {
        const p = map.center(i, j)
        const sim = Math.max(map.z[j * map.nx + i]!, -T)
        const e = expectedHeight(p, ops)
        if (sim < e - 1e-6) gouges.push(`${p}: ${sim} < ${e}`)
        // compare where the analytic height is constant within 0.3 mm (no wall, fillet or cone)
        const flat = [0, 1, 2, 3, 4, 5, 6, 7].every((k) => {
          const a = (k * Math.PI) / 4
          return expectedHeight([p[0] + 0.3 * Math.cos(a), p[1] + 0.3 * Math.sin(a)], ops) === e
        })
        if (!flat) continue
        compared++
        if (sim <= e + 1e-6) continue
        // a round tool leaves the slot corners beside a tab end standing (lifted within its radius)
        const nearTab = [0, 1, 2, 3, 4, 5, 6, 7].some((k) => {
          const a = (k * Math.PI) / 4
          const q: Vec2 = [p[0] + 3.05 * Math.cos(a), p[1] + 3.05 * Math.sin(a)]
          return inTab(profile, q, insideDistance(profile.shape.contour, profile.shape.center, q))
        })
        if (nearTab) besideTabs++
        else left.push(`${p}: ${sim} > ${e}`)
      }
    expect(gouges.slice(0, 5)).toEqual([])
    expect(left.slice(0, 5)).toEqual([])
    expect(compared).toBeGreaterThan(0.85 * map.nx * map.ny)
    // material beside the 4 tabs: at most the two slot corners a Ø6 tool leaves at each of the
    // 8 tab ends, R²(1 − π/4) each (the geometry models square tab ends)
    expect(besideTabs * 0.25 ** 2).toBeLessThanOrEqual(8 * 2 * 9 * (1 - Math.PI / 4))
  })

  it('cone tips: drill points match the analytic cone', () => {
    const ops = testPart().operations
    const map = new Heightmap(TEST_STOCK.length, TEST_STOCK.width, 0.1)
    for (const { tool, tp } of toolpaths()) if (tool.type === 'drill') map.sweep(tool, tp)
    for (const op of ops) {
      if (op.kind !== 'drilling' || op.bottom.kind !== 'drillPoint') continue
      for (let i = 0; i < map.nx; i++)
        for (let j = 0; j < map.ny; j++) {
          const p = map.center(i, j)
          if (Math.hypot(p[0] - op.center[0], p[1] - op.center[1]) > 2.9) continue
          expect(map.z[j * map.nx + i]!).toBeCloseTo(expectedHeight(p, ops), 6)
        }
    }
  })
})
