// The tab markers of the selected profile (task U2): each tab a bar across the slot at its centre
// along the loop, the loop's start point with its direction, and the drag. A drag moves one tab
// along the loop (the pointer's closest point on it), kept a tab width off its neighbours
// (`clampTab`); it is one gesture of `design.profile.update { tabs: { positions } }` steps at most
// every 100 ms and on release, so it is one undo step. Count-spaced tabs become entered positions
// with the first step. Escape cancels (`history.undo { gesture }`).
// Doc: docs/conventions/ui.md#tab-markers, docs/modes/design-v0.3.md#tabs-on-shapes
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OperationDTO } from '../../../../core/design/part.dto'
import { unapplyPlacement } from '../../../../core/geometry/model'
import { toPartFrame } from '../../../../core/geometry/face'
import { designMessages } from '../../messages/design'
import { lengthSource } from '../../messages/dfm'
import { lengthText } from '../../messages/shape'
import { useCancelGesture } from '../../shell/hooks'
import { useRegion2d } from '../../shell/ShellContext'
import type { TabDragPhase, TabMarkerView, TabOverlay } from '../../viewport'
import type { Vec3 } from '../../viewport/mesh'
import type { DesignPart } from './model'
import { operationFace } from './outline'
import { clampTab, distanceAlong, pointAlong, profileTabs, type ProfileTabs } from './tabs-model'
import { SHAPE_COMMIT_MS } from './useShapeDrag'
import { useCommand } from './useDesign'

const tt = designMessages.inspector.tabs

let counter = 0
const newGestureId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `tab-gesture-${++counter}`

/** The slot's extent across the loop (outward normal positive) for a cut side. */
export function slotAcross(side: ProfileTabs['side'], slotWidth: number): [number, number] {
  if (side === 'outside') return [0, slotWidth]
  if (side === 'inside') return [-slotWidth, 0]
  return [-slotWidth / 2, slotWidth / 2]
}

/** One tab's quad in the face frame `[u, v]`, counter-clockwise; undefined off the loop. */
export function tabQuad(
  t: ProfileTabs,
  s: number,
): [[number, number], [number, number], [number, number], [number, number]] | undefined {
  const at = pointAlong(t, s)
  if (at === undefined) return undefined
  const [px, py] = at.point
  const [tx, ty] = at.tangent
  // the loop runs counter-clockwise: outward is the tangent turned clockwise
  const nx = ty
  const ny = -tx
  const [a0, a1] = slotAcross(t.side, t.slotWidth)
  // a little past the slot on both sides so the bar reads across the cut
  const pad = Math.max(0.3, t.slotWidth * 0.15)
  const a = a0 - pad
  const b = a1 + pad
  const h = t.width / 2
  const pt = (along: number, across: number): [number, number] => [
    px + tx * along + nx * across,
    py + ty * along + ny * across,
  ]
  return [pt(-h, a), pt(h, a), pt(h, b), pt(-h, b)]
}

interface Gesture {
  readonly id: string
  readonly index: number
  /** Centres at the drag's start (mm). */
  readonly base: readonly number[]
  /** Sources at the drag's start (the entered ones, or the count rule's in project units). */
  readonly sources: readonly string[]
  pending: number | null
  lastSent: number
  sent: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  chain: Promise<void>
}

export function useTabMarkers(
  part: DesignPart | undefined,
  op: OperationDTO | undefined,
): TabOverlay | null {
  const port = useRegion2d()
  const call = useCommand()
  const cancelGesture = useCancelGesture()
  const [preview, setPreview] = useState<{ index: number; centres: number[] } | null>(null)
  const gesture = useRef<Gesture | null>(null)

  const loadedOp =
    op?.kind === 'profile' ? part?.loaded?.part.operations.find((o) => o.id === op.id) : undefined
  const tabs =
    part !== undefined && op?.kind === 'profile' ? profileTabs(part, op.id, port) : undefined
  const face = useMemo(
    () =>
      loadedOp !== undefined && part?.loaded !== undefined && part.table !== undefined
        ? operationFace(loadedOp, part.loaded.stock, part.table)
        : undefined,
    [loadedOp, part],
  )

  const flush = useCallback(
    (g: Gesture) => {
      clearTimeout(g.timer)
      g.timer = undefined
      if (g.pending === null || part === undefined || op === undefined) return
      const s = g.pending
      g.pending = null
      g.lastSent = performance.now()
      const sources = [...g.sources]
      sources[g.index] = lengthSource(s, part.units)
      g.chain = g.chain.then(async () => {
        const r = await call(
          'design.profile.update',
          { partId: part.dto.id, operationId: op.id, tabs: { positions: sources } },
          { gesture: g.id },
        )
        if (r.ok) g.sent = true
      })
    },
    [call, part, op],
  )

  const onDrag = useCallback(
    (phase: TabDragPhase, index: number, point: Vec3) => {
      if (tabs === undefined || face === undefined || part === undefined) return
      if (phase === 'start') {
        const entered =
          op?.kind === 'profile' && op.tabs.positions !== undefined
            ? op.tabs.positions.map((q) => q.source)
            : tabs.centres.map((c) => lengthSource(c, part.units))
        gesture.current = {
          id: newGestureId(),
          index,
          base: tabs.centres,
          sources: entered,
          pending: null,
          lastSent: 0,
          sent: false,
          timer: undefined,
          chain: Promise.resolve(),
        }
        return
      }
      const g = gesture.current
      if (g === null || g.index !== index) return
      if (phase === 'move') {
        const local = unapplyPlacement(face.frame, point)
        const s = distanceAlong(tabs.chain, [local[0], local[1]])
        const at = clampTab(g.base, index, s, tabs.width, tabs.length)
        const centres = [...g.base]
        centres[index] = at
        setPreview({ index, centres })
        g.pending = at
        const wait = SHAPE_COMMIT_MS - (performance.now() - g.lastSent)
        if (wait <= 0) flush(g)
        else g.timer ??= setTimeout(() => flush(g), wait)
        return
      }
      gesture.current = null
      if (phase === 'end') {
        flush(g)
        void g.chain.then(() => setPreview(null))
        return
      }
      clearTimeout(g.timer)
      g.pending = null
      setPreview(null)
      void g.chain.then(() => (g.sent ? cancelGesture(g.id) : undefined))
    },
    [tabs, face, part, op, flush, cancelGesture],
  )

  // a drag still open when the selection goes away is sent as it stands
  useEffect(
    () => () => {
      const g = gesture.current
      if (g !== null) flush(g)
      gesture.current = null
    },
    [flush],
  )

  return useMemo(() => {
    if (tabs === undefined || face === undefined || part === undefined) return null
    if (tabs.chain.elements.length === 0) return null
    const w = face.w
    const at = (p: readonly [number, number]): Vec3 => toPartFrame(face.frame, [p[0], p[1], w])
    const centres = preview?.centres ?? tabs.centres
    const markers: TabMarkerView[] = tabs.allowed
      ? centres.flatMap((c, i) => {
          const q = tabQuad(tabs, c)
          return q === undefined
            ? []
            : [
                {
                  corners: [at(q[0]), at(q[1]), at(q[2]), at(q[3])] as const,
                  label: tt.at(i + 1, lengthText(c, part.units)),
                },
              ]
        })
      : []
    const start = pointAlong(tabs, 0)
    const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
    const origin = at([0, 0])
    return {
      markers,
      start:
        start === undefined
          ? null
          : {
              at: at(start.point),
              along: sub(at([start.tangent[0], start.tangent[1]]), origin),
              radius: Math.max(0.8, Math.min(3, tabs.slotWidth * 0.6)),
            },
      plane: { origin: at([0, 0]), normal: face.frame.n, u: face.frame.u },
      dragging: preview?.index ?? null,
      locked: !tabs.allowed,
      onDrag,
    }
  }, [tabs, face, part, preview, onDrag])
}
