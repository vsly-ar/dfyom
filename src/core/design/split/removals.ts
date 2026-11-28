/**
 * The removal prisms of a split source's ±z operations in the part frame (the outline excluded)
 * and point membership in the 2.5D model: the samples of the split's DFM (glue faces) and the
 * dowels' clear region. Pure. Doc: docs/modes/split-parts.md#dfm-near-a-split,
 * docs/modes/split-parts.md#implementation-4b
 */
import type { Region } from '../../geometry/2d/model'
import { regionContains } from '../../geometry/2d/measure'
import type { OperationGeometry } from '../../geometry/model'
import type { LoadedPart } from '../load'
import { SurfaceTable } from '../surfaces'
import { operationTools } from '../tool-choice'
import { EPS, regionBounds, shapeRegion } from './layout'

export interface Removal {
  readonly id: string
  readonly name: string
  readonly dir: '+z' | '-z'
  readonly zlo: number
  readonly zhi: number
  /** Face-frame region (a −z one is tested at (x, W − y)); undefined = the whole face. */
  readonly region: Region | undefined
  /** `out`: removes everything outside `region` (an outside step). */
  readonly mode: 'in' | 'out' | 'all'
  readonly bounds: { min: readonly [number, number]; max: readonly [number, number] } | undefined
  readonly tool: number
}

/** The removals of the part's ±z operations (the outline excluded), part-frame z ranges. */
export function removals(
  loaded: LoadedPart,
  geometry: readonly OperationGeometry[],
  outline: number | undefined,
): Removal[] {
  const T = loaded.stock.thickness.canonical
  const table = SurfaceTable.build(loaded.part.operations, loaded.stock, loaded.part.shapes)
  const tools = operationTools(loaded.part.operations, loaded.snapshots ?? {})
  const out: Removal[] = []
  loaded.part.operations.forEach((op, i) => {
    const g = geometry[i]
    if (g === undefined || i === outline) return
    const dir = g.direction ?? '+z'
    if (dir !== '+z' && dir !== '-z') return
    const e = table.get(op.on)
    if (e.isNone()) return
    const faceZ = e.unwrap().faceZ.toNumber()
    const zOn = dir === '+z' ? faceZ : -T - faceZ
    let depth = 0
    let through = false
    let region: Region | undefined
    let mode: Removal['mode'] = 'in'
    switch (g.kind) {
      case 'facing':
        depth = g.depth
        // DF145: a region facing removes its region only
        if (g.region === undefined) mode = 'all'
        else region = shapeRegion(g.region)
        break
      case 'pocket':
        depth = g.depth
        region = shapeRegion(g.shape)
        break
      case 'drilling':
        if (g.bottom.kind === 'through') through = true
        else depth = g.bottom.depth
        region = shapeRegion({
          center: g.center,
          contour: { kind: 'circle', radius: g.diameter / 2 },
        })
        break
      case 'profile':
        if (g.depth === undefined) through = true
        else depth = g.depth
        region = shapeRegion(g.shape)
        if (region === undefined) return
        if (g.side === 'outside') mode = 'out'
        break
      case 'chamfer':
        return
    }
    if (mode !== 'all' && region === undefined) return
    const tool =
      tools[op.id]?.tool.diameter ??
      (g.kind === 'profile' ? g.slotWidth : g.kind === 'drilling' ? g.diameter : 6)
    out.push({
      id: op.id,
      name: op.name,
      dir,
      zlo: dir === '+z' ? (through ? -T : zOn - depth) : zOn,
      zhi: dir === '+z' ? zOn : through ? 0 : zOn + depth,
      region,
      mode,
      bounds: region === undefined ? undefined : regionBounds(region),
      tool,
    })
  })
  return out
}

/** Material at a part-frame point: inside the footprint and in no removal. */
export function materialAt(
  footprint: Region,
  rs: readonly Removal[],
  W: number,
  x: number,
  y: number,
  z: number,
): boolean {
  if (!regionContains(footprint, [x, y])) return false
  for (const r of rs) {
    if (z <= r.zlo + EPS || z >= r.zhi - EPS) continue
    if (r.mode === 'all') return false
    const p: [number, number] = r.dir === '+z' ? [x, y] : [x, W - y]
    const b = r.bounds!
    const inB = p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1]
    const inside = inB && regionContains(r.region!, p)
    if (r.mode === 'in' ? inside : !inside) return false
  }
  return true
}
