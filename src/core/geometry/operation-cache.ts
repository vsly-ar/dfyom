/**
 * Built operation solids kept across evaluations (v0.3 G1 perf): an edit changes one operation,
 * so the next evaluation rebuilds only that one – the 2D offsets, flattening and cap
 * triangulation of the others are reused. Plain meshes only (no library objects: each
 * evaluation's arena still makes and frees its own solids).
 * Doc: docs/architecture/shapes.md#implementation-g1
 */
import { Ok, type AppResult } from '../../shared/result'
import type { OperationGeometry, StockGeometry } from './model'
import type { OperationSolids, PlacedMesh } from './operations'

/** Numbers held by the cache at most (positions, triangles, faces): ≈ 32 MB. */
export const OPERATION_CACHE_NUMBERS = 2 ** 22

const sizeOf = (s: OperationSolids): number =>
  [...s.removal, ...s.cut, ...s.retained, ...s.nominal.map((r) => r.mesh)].reduce(
    (n, { mesh }: PlacedMesh) => n + mesh.positions.length + 2 * mesh.triangles.length,
    0,
  )

/**
 * The key of an operation's build: its input and the stock's as JSON (the worker parses each
 * input afresh, so identity cannot be the key). It also keys the operation's solid kept by the
 * kernel (`SolidPort.kept`).
 */
export const operationKey = (op: OperationGeometry | 'stock', stock: StockGeometry): string =>
  JSON.stringify([op, stock])

/**
 * Least recently used, by `operationKey`; only successful builds are kept. Entries are shared
 * between evaluations and never mutated.
 */
export class OperationCache {
  private readonly entries = new Map<string, { solids: OperationSolids; size: number }>()
  private numbers = 0

  constructor(private readonly capacity = OPERATION_CACHE_NUMBERS) {}

  /** The cached solids for `key` (`operationKey`), else `build()`'s result (kept when `Ok`). */
  solids(key: string, build: () => AppResult<OperationSolids>): AppResult<OperationSolids> {
    const hit = this.entries.get(key)
    if (hit !== undefined) {
      // most recently used last
      this.entries.delete(key)
      this.entries.set(key, hit)
      return Ok(hit.solids)
    }
    const built = build()
    if (built.isOk()) this.keep(key, built.unwrap())
    return built
  }

  /** Entries held (for tests). */
  get size(): number {
    return this.entries.size
  }

  private keep(key: string, solids: OperationSolids): void {
    const size = sizeOf(solids)
    if (size > this.capacity) return
    this.entries.set(key, { solids, size })
    this.numbers += size
    for (const [k, e] of this.entries) {
      if (this.numbers <= this.capacity) break
      this.entries.delete(k)
      this.numbers -= e.size
    }
  }
}
