/**
 * Port to the 3D solid library (mesh booleans). The only implementation is `manifold/`;
 * other modules may test against a fake. Doc: docs/architecture/geometry.md#modules-srccoregeometry
 */
import type { AppResult, Option } from '../../shared/result'
import type { LabelledMesh } from './loft'
import type { Vec3 } from './model'

declare const solidBrand: unique symbol
/** Opaque handle to a library solid; valid only inside the `withSolids` call that made it. */
export interface Solid {
  readonly [solidBrand]: true
}

/** Output mesh copied out of the library: plain typed arrays, per-triangle surface keys. */
export interface SolidMesh {
  /** x, y, z per vertex (float32 – derived data, never read dimensions back). */
  readonly positions: Float32Array
  readonly indices: Uint32Array
  /** Original id of each triangle's source mesh (`reserveOriginalId`). */
  readonly triangleOriginal: Uint32Array
  /** Face label of each triangle within that source mesh. */
  readonly triangleFace: Uint32Array
}

/** Library status of a solid; anything but `NoError` is an evaluation error. */
export type SolidStatus = 'NoError' | (string & {})

/**
 * Every method may fail with `geometry.evaluation` (library exceptions) or `internal.unexpected`
 * (a handle used outside its arena – a bug).
 */
export interface SolidPort {
  /** A fresh original id: triangles made from meshes with this id keep it through booleans. */
  reserveOriginalId(): AppResult<number>
  /** A solid from a closed, labelled mesh; `faces` survive as the triangles' face labels. */
  fromMesh(mesh: LabelledMesh, originalId: number): AppResult<Solid>
  /** Batch union (one call for many solids). */
  union(solids: readonly Solid[]): AppResult<Solid>
  subtract(a: Solid, b: Solid): AppResult<Solid>
  intersect(a: Solid, b: Solid): AppResult<Solid>
  /** Translation in the library (float64). */
  translate(s: Solid, by: Vec3): AppResult<Solid>
  status(s: Solid): AppResult<SolidStatus>
  decompose(s: Solid): AppResult<readonly Solid[]>
  volume(s: Solid): AppResult<number>
  toMesh(s: Solid): AppResult<SolidMesh>
}

/**
 * A loaded solid library. `withSolids` opens an arena for one evaluation: every library object
 * made through the port is freed when `fn` returns (Ok, Err or a thrown bug). Results must be
 * copied out (e.g. `toMesh`) before returning.
 */
export interface SolidKernel {
  withSolids<T>(fn: (solids: SolidPort) => AppResult<T>): AppResult<T>
  /** Library objects not yet freed – 0 between evaluations, or something leaked. */
  liveObjects(): number
  /** Size of the WASM linear memory in bytes, when the host passed the binary in. */
  heapBytes(): Option<number>
}
