/**
 * Spike S6 workloads: clone sources and their positions as geometry input. A clone instance is
 * modelled as a translated copy of its source operations (one face, orientation kept: D30), in
 * the expansion order of features.md § Plan and cut order (source operation A on every position,
 * then B). Throwaway code; report: docs/research/s6-clone-budgets.md.
 */
import type {
  OperationGeometry,
  PartGeometryInput,
  StockGeometry,
  Vec2,
} from '../../src/core/geometry/model'

export interface CloneGroup {
  /** Source operations (instance 1 at offset [0, 0]). */
  readonly source: readonly OperationGeometry[]
  /** Offsets of instances 1…N from the source position (the first is [0, 0]). */
  readonly offsets: readonly Vec2[]
}

export interface Workload {
  readonly name: string
  readonly stock: StockGeometry
  readonly group: CloneGroup
}

export const THICKNESS = 6

/** Grid offsets: `n` positions, `columns` per row, pitch `[du, dv]`. */
export function gridOffsets(n: number, columns: number, pitch: Vec2): Vec2[] {
  const out: Vec2[] = []
  for (let k = 0; k < n; k++)
    out.push([(k % columns) * pitch[0], Math.floor(k / columns) * pitch[1]])
  return out
}

/**
 * An M3 counterbored hole as design-v0.4 expands it: a Ø6 circular pocket 3.3 deep and a Ø3.4
 * drilling on its floor, through; 40 per row at a 10 mm pitch on a 6 mm board.
 */
export function counterbores(n: number): Workload {
  const at: Vec2 = [10, 10]
  return {
    name: `${n} counterbored M3 holes`,
    stock: { length: 420, width: 270, thickness: THICKNESS },
    group: {
      source: [
        {
          kind: 'pocket',
          id: 'hole1_counterbore',
          onZ: 0,
          shape: { center: at, contour: { kind: 'circle', radius: 3 } },
          depth: 3.3,
          floorRadius: 0,
        },
        {
          kind: 'drilling',
          id: 'hole1_drill',
          onZ: -3.3,
          center: at,
          diameter: 3.4,
          bottom: { kind: 'through' },
        },
      ],
      offsets: gridOffsets(n, 40, [10, 10]),
    },
  }
}

/** A 30 × 5 obround through pocket (the lid's vent slot); 25 per row at a 36 × 10 pitch. */
export function slots(n: number): Workload {
  return {
    name: `${n} obround slots 30 × 5`,
    stock: { length: 920, width: 420, thickness: THICKNESS },
    group: {
      source: [
        {
          kind: 'pocket',
          id: 'pocket1',
          onZ: 0,
          shape: {
            center: [20, 10],
            contour: { kind: 'rectangle', length: 30, width: 5, cornerRadius: 2.5 },
          },
          depth: THICKNESS,
          floorRadius: 0,
        },
      ],
      offsets: gridOffsets(n, 25, [36, 10]),
    },
  }
}

/** `op` moved by `d` in its face frame, renamed for instance `n` (`clones1_<n>_<id>`). */
export function translated(op: OperationGeometry, d: Vec2, n: number): OperationGeometry {
  const id = n === 1 ? op.id : `clones1_${n}_${op.id}`
  const add = (p: Vec2): Vec2 => [p[0] + d[0], p[1] + d[1]]
  switch (op.kind) {
    case 'facing':
      return { ...op, id }
    case 'drilling':
      return { ...op, id, center: add(op.center) }
    case 'pocket':
    case 'profile':
      return { ...op, id, shape: { ...op.shape, center: add(op.shape.center) } }
  }
}

/** The expansion as plain operations: every instance an operation of its own (today's path). */
export function expanded(w: Workload): PartGeometryInput {
  const operations: OperationGeometry[] = []
  for (const op of w.group.source)
    w.group.offsets.forEach((d, i) => operations.push(translated(op, d, i + 1)))
  return { stock: w.stock, operations }
}

/**
 * `w` with its source resized by `k` × 0.01 mm (an edit of the source: every instance changes,
 * also under a source-relative cache key).
 */
export function sourceEdited(w: Workload, k: number): Workload {
  const e = 0.01 * k
  const edit = (op: OperationGeometry): OperationGeometry => {
    if (op.kind === 'drilling') return { ...op, diameter: op.diameter + e }
    if (op.kind !== 'pocket') return op
    const c = op.shape.contour
    if (c.kind === 'circle')
      return { ...op, shape: { ...op.shape, contour: { ...c, radius: c.radius + e } } }
    if (c.kind === 'rectangle')
      return { ...op, shape: { ...op.shape, contour: { ...c, length: c.length + e } } }
    return op
  }
  return { ...w, group: { ...w.group, source: w.group.source.map(edit) } }
}
