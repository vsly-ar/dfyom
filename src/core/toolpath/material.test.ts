// Passes over the material earlier cuts left (hardening DF61): levels start at the material's
// top, levels wholly below its bottom are skipped, the floor stays the operation's.
// Spec: docs/modes/plan-v0.2.md#material-left-for-later-cuts-df61
import { describe, expect, it } from 'vitest'
import { rect } from '../geometry/2d/testing/fixtures'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { cutLevels, levels } from './common'
import { generateDrilling } from './drilling'
import { generateFacing } from './facing'
import type { Toolpath } from './model'
import { generatePocket } from './pocket'
import { generateProfile } from './profile'
import { generateRegionPocket } from './region-pocket'
import {
  cutting,
  drill,
  drillingInput,
  endMill,
  facingInput,
  HEIGHTS,
  pocketInput,
  profileInput,
  RATES,
} from './testing/fixtures'
import { cuttingLevels } from './testing/rules'

const port = nodeRegion2d()
const stock = { length: 60, width: 40, thickness: 10 }

describe('cutLevels', () => {
  it('without a band: the plain levels', () => {
    expect(cutLevels(0, -4, 1)).toEqual(levels(0, -4, 1))
  })

  it('starts at the material top in equal steps; the floor stays', () => {
    expect(cutLevels(0, -4, 1, { top: -2 })).toEqual([-3, -4])
    expect(cutLevels(0, -4, 1.5, { top: -1 })).toEqual([-2.5, -4])
    // a top above the start level changes nothing
    expect(cutLevels(-1, -4, 1, { top: 0 })).toEqual(levels(-1, -4, 1))
  })

  it('skips levels whose slab lies wholly below the material bottom', () => {
    // material from 0 to −2.5: the levels −1, −2, −3 cut it (−3's slab −2…−3 reaches −2.5)
    expect(cutLevels(0, -6, 1, { bottom: -2.5 })).toEqual([-1, -2, -3])
    // exactly on a level: the next slab is all air
    expect(cutLevels(0, -6, 1, { bottom: -2 })).toEqual([-1, -2])
  })

  it('keeps one level when the whole cut lies in air', () => {
    expect(cutLevels(0, -4, 1, { top: -5 })).toEqual([-4])
    expect(cutLevels(0, -4, 1, { bottom: 1 })).toEqual([-1])
  })
})

describe('generators over a material band', () => {
  const tool = endMill(6)

  it('facing: the second facing below an earlier one starts at its floor', () => {
    const base = facingInput(stock, tool, {
      operation: { kind: 'facing', id: 'facing2', depth: 3 },
      cutting: cutting(tool, { stepover: 4.5, stepdown: 1 }),
    })
    expect(cuttingLevels(generateFacing(base).unwrap())).toEqual([-1, -2, -3])
    const after = generateFacing({ ...base, material: { top: -1.5 } }).unwrap()
    expect(cuttingLevels(after)).toEqual([-2.25, -3])
    expect(after.stats.estimatedSeconds).toBeLessThan(
      generateFacing(base).unwrap().stats.estimatedSeconds,
    )
  })

  it('v0.1 pocket: rough and finish levels from the material top, same floor', () => {
    const op = {
      kind: 'pocket' as const,
      id: 'pocket1',
      onZ: 0,
      shape: {
        center: [30, 20] as [number, number],
        contour: { kind: 'rectangle' as const, length: 30, width: 20, cornerRadius: 4 },
      },
      depth: 4,
      floorRadius: 0,
    }
    const input = pocketInput(stock, op, tool, { cutting: cutting(tool, { stepdown: 1 }) })
    const tp = generatePocket({ ...input, material: { top: -2 } }).unwrap()
    expect(cuttingLevels(tp, 'rough')).toEqual([-3, -4])
    // the helix starts at the material top, not at the stock face
    const zs = tp.passes.flatMap((p) => p.moves.map((m) => (m.kind === 'drill' ? 0 : m.to[2])))
    expect(zs.filter((z) => z < 0).every((z) => z <= -2 + 1e-9)).toBe(true)
    expect(Math.min(...zs)).toBeCloseTo(-4, 9)
  })

  it('region pocket: levels from the material top', () => {
    const tp = generateRegionPocket(
      {
        planOperationId: 'op-p',
        tool,
        cutting: cutting(tool, { stepdown: 1 }),
        heights: HEIGHTS,
        stock,
        operation: {
          region: { pieces: [{ outer: rect(10, 10, 30, 20), holes: [] }] },
          onZ: 0,
          depth: 4,
        },
        strategy: {
          entry: 'helix',
          helixDiameter: 4,
          rampAngle: 3,
          finishAllowance: 0,
          finishStepdown: 4,
          direction: 'climb',
        },
        maxFeedRate: RATES,
        material: { top: -2.5 },
      },
      port,
    ).unwrap()
    expect(cuttingLevels(tp, 'rough')).toEqual([-3.25, -4])
  })

  it('v0.1 profile: a through cut under an earlier facing starts below it', () => {
    const op = {
      kind: 'profile' as const,
      id: 'profile1',
      shape: {
        center: [30, 20] as [number, number],
        contour: { kind: 'rectangle' as const, length: 30, width: 20, cornerRadius: 3 },
      },
      side: 'outside' as const,
      slotWidth: 6,
      tabs: { count: 0, width: 6, thickness: 2 },
    }
    const input = profileInput(stock, op, tool, { cutting: cutting(tool, { stepdown: 3 }) })
    const plain = cuttingLevels(generateProfile(input).unwrap(), 'rough')
    expect(plain).toHaveLength(4)
    const tp = generateProfile({ ...input, material: { top: -1.5 } }).unwrap()
    expect(cuttingLevels(tp, 'rough')).toEqual([-4.5, -7.5, -10.5])
  })

  it('drilling: a hole below a cleared level pecks from the material, the retract follows', () => {
    const op = {
      kind: 'drilling' as const,
      id: 'drill1',
      onZ: 0,
      center: [30, 20] as [number, number],
      diameter: 3,
      bottom: { kind: 'drillPoint' as const, depth: 6, pointAngle: 118 },
    }
    const input = drillingInput(stock, op, drill(3), {
      cycle: 'peck',
      breakthrough: 0,
      peckDepth: 1,
    })
    const cycle = (tp: Toolpath) =>
      tp.passes.flatMap((p) => p.moves).find((m) => m.kind === 'drill')
    const plain = cycle(generateDrilling(input).unwrap())
    const over = cycle(generateDrilling({ ...input, material: { top: -4 } }).unwrap())
    if (plain?.kind !== 'drill' || over?.kind !== 'drill') throw new Error('no drill cycle')
    expect(over).toEqual({ ...plain, top: -4, retract: plain.retract - 4 })
  })
})
