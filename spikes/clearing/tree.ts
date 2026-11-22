// Spike S4 (docs/research/s4-offset-clearing.md): the ring tree of offset clearing. Each node is
// one component of an inward offset (outer ring + island rings); its children are the components
// of its own offset by the step (so a neck splits a node into several children).

import type { Candidate } from '../2d/candidates.ts'
import { FillRule, areaD, differenceD, type PathsD } from 'clipper2-ts'
import { flatten, type Loop } from '../2d/geom.ts'
import { components, loopsOf, minConvexCorner, type Component } from './loops.ts'

export interface RingNode {
  readonly comp: Component
  /** Offset from the region boundary (mm). */
  readonly depth: number
  readonly children: RingNode[]
  /**
   * Gap rings (polygons, lines only), cut after this node's own rings: the boundaries of the
   * pieces of offset(node, R) that neither this node's rings nor its children's rings reach.
   */
  readonly gaps: Loop[]
}

/**
 * Step cap:
 * - `none`: the requested stepover;
 * - `R`: min(stepover, R): every point between a ring and its child is within R of the ring;
 * - `sqrt2`: min(stepover, √2·R), the v0.1 rectangle cap the draft applies to general regions;
 * - `corner`: min(stepover, R·(1 + sin(θ/2))) with θ the node's smallest convex corner: the
 *   largest step that leaves no cusp between two rings at a sharp corner of angle θ.
 */
export type StepCap = 'none' | 'R' | 'sqrt2' | 'corner'

export interface TreeOptions {
  readonly toolRadius: number
  readonly stepover: number
  readonly cap: StepCap
  /** Add gap rings where the step leaves material (only possible when step > R). */
  readonly gapFill: boolean
}

export function stepFor(o: TreeOptions, comp: Component): number {
  const R = o.toolRadius
  if (o.cap === 'none') return o.stepover
  if (o.cap === 'R') return Math.min(o.stepover, R)
  if (o.cap === 'sqrt2') return Math.min(o.stepover, Math.SQRT2 * R)
  const theta = minConvexCorner(loopsOf(comp))
  return Math.min(o.stepover, R * (1 + Math.sin(theta / 2)))
}

const offsetComp = (cc: Candidate, c: Component, d: number): Component[] =>
  components(cc.offset(loopsOf(c), d))

/** Roots: the tool-centre region (region offset by R + allowance), one root per component. */
export function buildTree(
  cc: Candidate,
  region: readonly Loop[],
  o: TreeOptions,
  allowance = 0,
): RingNode[] {
  const first = o.toolRadius + allowance
  return components(cc.offset(region, first)).map((c) => grow(cc, c, first, o))
}

const GAP_TOL = 0.002 // flattening of the gap computation (mm)
const GAP_MIN_AREA = 1e-3 // smaller gap pieces are below the 0.01 mm tolerance in every direction

const toPaths = (loops: readonly Loop[]): PathsD => loops.map((l) => flatten(l, GAP_TOL))

function grow(cc: Candidate, comp: Component, depth: number, o: TreeOptions): RingNode {
  const R = o.toolRadius
  const s = stepFor(o, comp)
  const kids = offsetComp(cc, comp, s)
  const children = kids.map((k) => grow(cc, k, depth + s, o))
  const gaps: Loop[] = []
  if (o.gapFill && s > R) {
    // Material this ring leaves (deeper than R inside it) minus what the children's rings reach
    // (their rings dilated by R). Each piece is thinner than 2·(s − R) ≤ 2·R, so a ring along its
    // boundary clears it; the piece lies inside offset(node, R), so that ring cannot gouge.
    const deep = cc.offset(loopsOf(comp), R * (1 - 1e-6))
    const reach = cc.offset(kids.flatMap(loopsOf), -R)
    const pieces = differenceD(toPaths(deep), toPaths(reach), FillRule.NonZero, 6)
    for (const p of pieces)
      if (Math.abs(areaD(p)) > GAP_MIN_AREA) {
        const ccw = areaD(p) > 0 ? p : [...p].reverse()
        gaps.push({ closed: true, verts: ccw.map((q) => [q.x, q.y, 0] as const) })
      }
  }
  return { comp, depth, children, gaps }
}

export function* walk(n: RingNode): Generator<RingNode> {
  yield n
  for (const c of n.children) yield* walk(c)
}

export function treeStats(roots: readonly RingNode[]) {
  let nodes = 0
  let leaves = 0
  let rings = 0
  let gaps = 0
  let maxLevel = 0
  const visit = (n: RingNode, level: number) => {
    nodes++
    rings += 1 + n.comp.holes.length
    gaps += n.gaps.length
    if (n.children.length === 0) leaves++
    maxLevel = Math.max(maxLevel, level)
    for (const c of n.children) visit(c, level + 1)
  }
  for (const r of roots) visit(r, 1)
  return { nodes, leaves, rings, gaps, levels: maxLevel }
}
