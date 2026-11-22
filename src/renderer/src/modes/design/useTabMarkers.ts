// The tab markers of the selected profile (task U2): each tab a bar across the slot at its centre
// along the loop, the loop's start point with its direction, and the drag. A drag moves one tab
// along the loop (the pointer's closest point on it), kept a tab width off its neighbours
// (`clampTab`); it is one gesture of `design.profile.update { tabs: { positions } }` steps at most
// every 100 ms and on release, so it is one undo step. Count-spaced tabs become entered positions
// with the first step. Escape cancels (`history.undo { gesture }`). Arrow keys on a focused
// marker move it along the loop; a run of keys (ended 500 ms after the last) is one gesture. A
// position typed in the Tabs fields ends the run first (`tab-key-run.ts`), so its last step cannot
// overwrite the typed value.
// Task U3: a drag snaps to the loop's corners and side middles, else to the grid along the loop
// (`snapAlong`); Alt or the "Snap" toggle off drags freely.
// Doc: docs/conventions/ui.md#tab-markers, docs/modes/design-v0.3.md#tabs-on-shapes
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OperationDTO } from '../../../../core/design/part.dto'
import { unapplyPlacement } from '../../../../core/geometry/model'
import { toPartFrame } from '../../../../core/geometry/face'
import { designMessages } from '../../messages/design'
import { lengthSource } from '../../messages/dfm'
import { lengthText } from '../../messages/shape'
import { useCancelGesture } from '../../shell/hooks'
import { useRegion2d, useSettings, useUi } from '../../shell/ShellContext'
import type { TabDragPhase, TabMarkerView, TabOverlay } from '../../viewport'
import type { TabDragInfo } from '../../viewport/TabMarkers'
import { snapGridMm, type SnapKind } from '../../viewport/snap'
import type { Vec3 } from '../../viewport/mesh'
import type { DesignPart } from './model'
import { operationFace } from './outline'
import { clampTab, pointAlong, profileTabs, snapAlong, type ProfileTabs } from './tabs-model'
import { registerTabKeyRun } from './tab-key-run'
import { SHAPE_COMMIT_MS } from './useShapeDrag'
import { useCommand } from './useDesign'

const tt = designMessages.inspector.tabs
/** A run of arrow keys ends this long after the last key (one gesture per run, as handles). */
const KEY_RUN_MS = 500

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
  /** The positions of the last step applied (sources). */
  lastSources: readonly string[] | undefined
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
  const [snapped, setSnapped] = useState<{ at: [number, number]; kind: SnapKind } | null>(null)
  const snapOn = useUi((s) => s.snapOn)
  const gridSetting = useSettings((s) => s.settings.snapGrid)
  const gesture = useRef<Gesture | null>(null)
  const keyRun = useRef<{ g: Gesture; at: number; timer: ReturnType<typeof setTimeout> } | null>(
    null,
  )

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
        if (r.ok) {
          g.sent = true
          g.lastSources = sources
        }
      })
    },
    [call, part, op],
  )

  const begin = useCallback(
    (index: number): Gesture | undefined => {
      if (tabs === undefined || part === undefined) return undefined
      const entered =
        op?.kind === 'profile' && op.tabs.positions !== undefined
          ? op.tabs.positions.map((q) => q.source)
          : tabs.centres.map((c) => lengthSource(c, part.units))
      return {
        id: newGestureId(),
        index,
        base: tabs.centres,
        sources: entered,
        pending: null,
        lastSent: 0,
        sent: false,
        lastSources: undefined,
        timer: undefined,
        chain: Promise.resolve(),
      }
    },
    [tabs, part, op],
  )

  const schedule = useCallback(
    (g: Gesture) => {
      const wait = SHAPE_COMMIT_MS - (performance.now() - g.lastSent)
      if (wait <= 0) flush(g)
      else g.timer ??= setTimeout(() => flush(g), wait)
    },
    [flush],
  )

  const endKeyRun = useCallback(() => {
    const run = keyRun.current
    if (run === null) return
    clearTimeout(run.timer)
    keyRun.current = null
    flush(run.g)
    void run.g.chain.then(() => setPreview(null))
  }, [flush])

  // a typed position ends the run first: its pending step goes out now and the typed edit waits
  // for the run's replies, building on the positions it left
  const settleKeyRun = useCallback(async (): Promise<readonly string[] | undefined> => {
    const run = keyRun.current
    if (run === null) return undefined
    clearTimeout(run.timer)
    keyRun.current = null
    flush(run.g)
    await run.g.chain
    setPreview(null)
    return run.g.lastSources
  }, [flush])

  const onNudge = useCallback(
    (index: number, delta: number) => {
      if (tabs === undefined) return
      let run = keyRun.current
      if (run !== null && run.g.index !== index) {
        endKeyRun()
        run = null
      }
      if (run === null) {
        const g = begin(index)
        if (g === undefined) return
        run = { g, at: g.base[index] ?? 0, timer: setTimeout(endKeyRun, KEY_RUN_MS) }
        keyRun.current = run
      }
      clearTimeout(run.timer)
      run.timer = setTimeout(endKeyRun, KEY_RUN_MS)
      const at = clampTab(run.g.base, index, run.at + delta, tabs.width, tabs.length)
      run.at = at
      const centres = [...run.g.base]
      centres[index] = at
      setPreview({ index, centres })
      run.g.pending = at
      schedule(run.g)
    },
    [tabs, begin, endKeyRun, schedule],
  )

  const onDrag = useCallback(
    (phase: TabDragPhase, index: number, point: Vec3, info?: TabDragInfo) => {
      if (tabs === undefined || face === undefined || part === undefined) return
      if (phase === 'start') {
        gesture.current = begin(index) ?? null
        return
      }
      const g = gesture.current
      if (g === null || g.index !== index) return
      if (phase === 'move') {
        const local = unapplyPlacement(face.frame, point)
        const free = !snapOn || info === undefined || info.alt
        const r = snapAlong(tabs, [local[0], local[1]], {
          pxPerMm: info?.pxPerMm ?? 1,
          grid: free ? null : snapGridMm(gridSetting, part.units),
          ...(free ? { tolerancePx: 0 } : {}),
        })
        setSnapped(r.snap === null ? null : { at: [r.snap.at[0], r.snap.at[1]], kind: r.snap.kind })
        const at = clampTab(g.base, index, r.s, tabs.width, tabs.length)
        const centres = [...g.base]
        centres[index] = at
        setPreview({ index, centres })
        g.pending = at
        schedule(g)
        return
      }
      gesture.current = null
      setSnapped(null)
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
    [tabs, face, part, begin, schedule, flush, cancelGesture, snapOn, gridSetting],
  )

  // a drag still open when the selection goes away is sent as it stands. Only on unmount: `flush`
  // changes with every reply of the gesture's own steps (the profile changed), and ending the
  // gesture then dropped the rest of a drag or key run (X2)
  const latest = useRef({ flush, endKeyRun, settleKeyRun })
  useEffect(() => {
    latest.current = { flush, endKeyRun, settleKeyRun }
  }, [flush, endKeyRun, settleKeyRun])
  const profileId = op?.kind === 'profile' ? op.id : undefined
  useEffect(
    () =>
      profileId === undefined
        ? undefined
        : registerTabKeyRun(profileId, () => latest.current.settleKeyRun()),
    [profileId],
  )
  useEffect(
    () => () => {
      const g = gesture.current
      if (g !== null) latest.current.flush(g)
      gesture.current = null
      latest.current.endKeyRun()
    },
    [],
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
      // the dragged marker only (a key run keeps its focus ring instead)
      dragging: gesture.current !== null ? (preview?.index ?? null) : null,
      locked: !tabs.allowed,
      snap: snapped === null ? null : { at: at(snapped.at), kind: snapped.kind },
      onDrag,
      onNudge,
    }
  }, [tabs, face, part, preview, onDrag, onNudge, snapped])
}
