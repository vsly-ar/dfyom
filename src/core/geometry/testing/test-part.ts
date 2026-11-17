/**
 * The geometry test part (docs/architecture/geometry.md#testing): fixes the spike's invalid part
 * (its stock margin was smaller than the slot, so the tabs held nothing).
 */
import type { OperationGeometry, PartGeometryInput } from '../model'
import { drillVolume, pocketVolume } from './analytic'
import { roundedRectArea } from './mesh-oracles'

export const TEST_STOCK = { length: 100, width: 60, thickness: 20 } as const
const FACED = -0.5

export interface TestPartOptions {
  readonly cornerRadius?: number
  readonly floorRadius?: number
}

/**
 * Stock 100 × 60 × 20; facing 0.5; pocket 40 × 25 × 8 centered (R4, floor fillet R2);
 * 4 drills Ø6 on a centered 70 × 30 pattern (through, flat, 2 × drillPoint 118°, depth 12);
 * profile outside 84 × 44 R5 centered, slot 6, 4 tabs 8 × 3 (stock margin 8 ≥ slot width).
 */
export function testPart(options: TestPartOptions = {}): PartGeometryInput {
  const cornerRadius = options.cornerRadius ?? 4
  const floorRadius = options.floorRadius ?? 2
  const drill = (
    id: string,
    x: number,
    y: number,
    bottom: Extract<OperationGeometry, { kind: 'drilling' }>['bottom'],
  ): OperationGeometry => ({
    kind: 'drilling',
    id,
    onZ: FACED,
    center: [x, y],
    diameter: 6,
    bottom,
  })
  return {
    stock: TEST_STOCK,
    operations: [
      { kind: 'facing', id: 'facing1', depth: 0.5 },
      {
        kind: 'pocket',
        id: 'pocket1',
        onZ: FACED,
        shape: {
          center: [50, 30],
          contour: { kind: 'rectangle', length: 40, width: 25, cornerRadius },
        },
        depth: 8,
        floorRadius,
      },
      drill('drill1', 15, 15, { kind: 'through' }),
      drill('drill2', 85, 15, { kind: 'flat', depth: 12 }),
      drill('drill3', 15, 45, { kind: 'drillPoint', depth: 12, pointAngle: 118 }),
      drill('drill4', 85, 45, { kind: 'drillPoint', depth: 12, pointAngle: 118 }),
      {
        kind: 'profile',
        id: 'profile1',
        shape: {
          center: [50, 30],
          contour: { kind: 'rectangle', length: 84, width: 44, cornerRadius: 5 },
        },
        side: 'outside',
        slotWidth: 6,
        tabs: { count: 4, width: 8, thickness: 3 },
      },
    ],
  }
}

/** Closed-form volume of `testPart(options)` (mm³), from the analytic oracles only. */
export function testPartVolume(options: TestPartOptions = {}): number {
  const cornerRadius = options.cornerRadius ?? 4
  const floorRadius = options.floorRadius ?? 2
  const { length: L, width: W, thickness: T } = TEST_STOCK
  const below = T + FACED // material height below the faced top
  const slotArea = roundedRectArea(96, 56, 11) - roundedRectArea(84, 44, 5)
  const tabs = 4 * 8 * 6 * 3 // tabs on straight walls: width × slot × thickness
  return (
    L * W * below -
    pocketVolume(40, 25, cornerRadius, 8, floorRadius) -
    drillVolume(6, below) -
    drillVolume(6, 12) -
    2 * drillVolume(6, 12, 118) -
    (slotArea * below - tabs)
  )
}

/** Every design.md surface id of the test part that must have triangles (stock.top is faced away). */
export const TEST_PART_SURFACES: readonly string[] = [
  'stock.bottom',
  'stock.side[0]',
  'stock.side[1]',
  'stock.side[2]',
  'stock.side[3]',
  'facing1.floor',
  'pocket1.floor',
  ...[0, 1, 2, 3].flatMap((i) => [`pocket1.wall[${i}]`, `pocket1.corner[${i}]`]),
  'pocket1.floorFillet',
  ...[1, 2, 3, 4].map((i) => `drill${i}.wall`),
  ...[2, 3, 4].map((i) => `drill${i}.bottom`),
  ...[0, 1, 2, 3].flatMap((i) => [`profile1.wall[${i}]`, `profile1.corner[${i}]`]),
  ...[0, 1, 2, 3].flatMap((i) => [
    `profile1.tab[${i}].top`,
    `profile1.tab[${i}].end[0]`,
    `profile1.tab[${i}].end[1]`,
  ]),
]
