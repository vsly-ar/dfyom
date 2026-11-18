/**
 * The geometry stress case (docs/architecture/geometry.md#performance-budgets-v01): many
 * filleted pockets with drills in their floors. Used by the geometry and worker perf budgets.
 */
import type { OperationGeometry, PartGeometryInput } from '../model'

/** 30 filleted pockets (6 × 5 grid on 300 × 200 × 20), 4 flat drills in each floor. */
export function pocketGrid(): PartGeometryInput {
  const operations: OperationGeometry[] = []
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < 5; j++) {
      const [x, y] = [25 + 50 * i, 20 + 40 * j]
      const n = operations.length / 5
      operations.push({
        kind: 'pocket',
        id: `pocket${n + 1}`,
        onZ: 0,
        shape: {
          center: [x, y],
          contour: { kind: 'rectangle', length: 40, width: 30, cornerRadius: 4 },
        },
        depth: 8,
        floorRadius: 2,
      })
      for (const [dx, dy] of [
        [-10, -7],
        [10, -7],
        [10, 7],
        [-10, 7],
      ] as const)
        operations.push({
          kind: 'drilling',
          id: `drill${operations.length}`,
          onZ: -8,
          center: [x + dx, y + dy],
          diameter: 4,
          bottom: { kind: 'flat', depth: 4 },
        })
    }
  return { stock: { length: 300, width: 200, thickness: 20 }, operations }
}
