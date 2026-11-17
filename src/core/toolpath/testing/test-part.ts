/**
 * Toolpaths of the geometry test part (docs/architecture/geometry.md#testing) with the tools and
 * property rules the toolpath tests use; also the post-processor's end-to-end program.
 */
import { TEST_STOCK, testPart } from '../../geometry/testing/test-part'
import { generateDrilling, tipLength } from '../drilling'
import { generateFacing } from '../facing'
import type { Toolpath, ToolpathTool } from '../model'
import { generatePocket } from '../pocket'
import { generateProfile } from '../profile'
import {
  bullNose,
  drill,
  drillingInput,
  endMill,
  facingInput,
  pocketInput,
  profileInput,
} from './fixtures'
import { insideDistance } from './oracles'
import type { PathRules } from './rules'

const T = TEST_STOCK.thickness

/** Tool, toolpath and property rules per test-part operation, in design order. */
export function testPartToolpaths(): { tool: ToolpathTool; tp: Toolpath; rules: PathRules }[] {
  const out: { tool: ToolpathTool; tp: Toolpath; rules: PathRules }[] = []
  const mill = { feedRate: 1200, plungeRate: 300, clearanceZ: 10, rampAngle: 3 }
  for (const op of testPart().operations) {
    if (op.kind === 'facing') {
      const tool = endMill(12)
      out.push({
        tool,
        tp: generateFacing(facingInput(TEST_STOCK, tool, { operation: op })).unwrap(),
        rules: {
          ...mill,
          retractZ: 2,
          targetZ: -op.depth,
          contains: (p) => p[2] >= -op.depth - 1e-9,
        },
      })
    } else if (op.kind === 'pocket') {
      const tool = bullNose(6, 2)
      const floor = op.onZ - op.depth
      out.push({
        tool,
        tp: generatePocket(pocketInput(TEST_STOCK, op, tool)).unwrap(),
        rules: {
          ...mill,
          retractZ: op.onZ + 2,
          targetZ: floor,
          contains: (p) =>
            p[2] > op.onZ + 1e-9 ||
            (p[2] >= floor - 1e-9 &&
              insideDistance(op.shape.contour, op.shape.center, [p[0], p[1]]) >= 3 - 1e-9),
        },
      })
    } else if (op.kind === 'drilling') {
      const b = op.bottom
      const tool = b.kind === 'flat' ? endMill(4) : drill(6)
      const strategy =
        b.kind === 'flat'
          ? ({
              cycle: 'helix',
              helixPitch: 1,
              rampAngle: 3,
              breakthrough: 0.5,
              direction: 'climb',
            } as const)
          : b.kind === 'through'
            ? ({ cycle: 'simple', breakthrough: 0.5 } as const)
            : ({ cycle: 'peck', peckDepth: 6, breakthrough: 0.5 } as const)
      const tip = b.kind === 'flat' ? 0 : tipLength(6, 118)
      const full = b.kind === 'through' ? -T - 0.5 : op.onZ - b.depth
      const rho = b.kind === 'flat' ? (op.diameter - 4) / 2 : 0
      out.push({
        tool,
        tp: generateDrilling(drillingInput(TEST_STOCK, op, tool, strategy)).unwrap(),
        rules: {
          feedRate: 600,
          plungeRate: 150,
          rampAngle: 3,
          clearanceZ: 10,
          retractZ: op.onZ + 2,
          targetZ: full - tip,
          contains: (p) =>
            p[2] > op.onZ + 1e-9 ||
            (p[2] >= full - tip - 1e-9 &&
              Math.hypot(p[0] - op.center[0], p[1] - op.center[1]) <= rho + 1e-9),
        },
      })
    } else {
      const tool = endMill(6)
      out.push({
        tool,
        tp: generateProfile(profileInput(TEST_STOCK, op, tool)).unwrap(),
        rules: {
          ...mill,
          retractZ: 2,
          targetZ: -T - 0.5,
          contains: (p) => {
            if (p[2] > 1e-9) return true
            const d = insideDistance(op.shape.contour, op.shape.center, [p[0], p[1]])
            return p[2] >= -T - 0.5 - 1e-9 && d <= -3 + 1e-9 && d >= -3 - 1e-9
          },
        },
      })
    }
  }
  return out
}
