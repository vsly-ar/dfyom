/**
 * The pieces every operation builder shares: the surface table under construction and the meshes
 * of an operation in its face frame, before `operations.ts` places them into the part frame.
 * Doc: docs/architecture/geometry.md#surface-ids-in-meshes, docs/architecture/shapes.md#implementation-g1
 */
import type { LabelledMesh } from './loft'
import type { Vec3 } from './model'

/**
 * Surface roles of one operation (or the stock); a mesh's face label is the index here.
 * Index 0 is `air` (never survives); `offcut` (profiles) may survive but is not referenceable.
 * Several indices may share one role: the tiles of a planar face (`top`, `floor`).
 */
export type SurfaceTable = readonly string[]

export const AIR = 0

/** Surface table under construction: role → index. */
export class Table {
  private readonly roles: string[] = ['air']
  add(role: string): number {
    this.roles.push(role)
    return this.roles.length - 1
  }
  get surfaces(): SurfaceTable {
    return this.roles
  }
}

/** A mesh built around `at` in its operation's face frame (placed later by that frame). */
export interface LocalMesh {
  readonly mesh: LabelledMesh
  readonly at: Vec3
}

/**
 * A retained region at its nominal size, before placement: a tab across exactly the slot, or a
 * floor fillet's zone (`minusRemoval`); see `NominalRegion` in operations.ts.
 */
export interface LocalNominal<S> {
  readonly region: string
  readonly parameter: string
  readonly mesh: LocalMesh
  readonly minusRemoval: boolean
  readonly clearInside?: S
}

/** An operation built in its face frame, before placement. */
export interface LocalSolids<S = never> {
  readonly id: string
  readonly surfaces: SurfaceTable
  readonly removal: readonly LocalMesh[]
  readonly cut: readonly LocalMesh[]
  readonly retained: readonly LocalMesh[]
  readonly nominal: readonly LocalNominal<S>[]
}

export const localSolids = <S = never>(
  id: string,
  table: Table,
  parts: {
    removal: LocalMesh[]
    cut?: LocalMesh[]
    retained?: LocalMesh[]
    nominal?: LocalNominal<S>[]
  },
): LocalSolids<S> => ({
  id,
  surfaces: table.surfaces,
  removal: parts.removal,
  cut: parts.cut ?? [],
  retained: parts.retained ?? [],
  nominal: parts.nominal ?? [],
})
