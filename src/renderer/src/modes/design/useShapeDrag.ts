// One handle gesture of the Shape Editor (task U1): the dragged item is previewed every frame
// (ui store) and checked with the renderer's 2D port; valid states go out as
// `design.shape.item.update` steps of one gesture at most every 100 ms and on release, so the
// drag is one undo step. An invalid state keeps the last valid outline and marks its issue; it is
// never sent. Escape cancels (`history.undo { gesture }`). Without a port every step is sent and
// the command checks it.
// Doc: docs/conventions/ui.md#shapes-v03 (one drag is one gesture),
// docs/architecture/commands.md#gestures-live-edits
import { useCallback, useEffect, useRef } from 'react'
import { resolveShape } from '../../../../core/design/shape'
import type { ShapeDTO } from '../../../../core/design/shape.dto'
import type { Region2dPort } from '../../../../core/geometry/2d/port'
import { useCancelGesture } from '../../shell/hooks'
import { useShell } from '../../shell/ShellContext'
import type { ShapeDragEvent } from '../../viewport/ShapeView'
import { definitionNumbers, dragUpdate, type ItemNumbers } from './shape-model'
import { useCommand } from './useDesign'

/** Gesture steps go out at most this often (ui.md § Shapes). */
export const SHAPE_COMMIT_MS = 100

interface Gesture {
  readonly id: string
  readonly index: number
  readonly before: ItemNumbers
  readonly dto: ShapeDTO
  /** The latest valid state not yet sent. */
  pending: ItemNumbers | null
  stepMm: number
  lastSent: number
  sent: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  chain: Promise<void>
}

let gestureCounter = 0
const newGestureId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `shape-gesture-${++gestureCounter}`

export function useShapeDrag(
  partId: string,
  shape: ShapeDTO | undefined,
  port: Region2dPort | undefined,
): (e: ShapeDragEvent) => void {
  const call = useCommand()
  const cancelGesture = useCancelGesture()
  const { ui } = useShell()
  const current = useRef<Gesture | null>(null)
  const shapeRef = useRef(shape)
  shapeRef.current = shape

  const flush = useCallback(
    (g: Gesture) => {
      clearTimeout(g.timer)
      g.timer = undefined
      const item = g.pending
      if (item === null) return
      g.pending = null
      g.lastSent = performance.now()
      const dtoItem = g.dto.items[g.index]
      if (dtoItem === undefined) return
      const fields = dragUpdate(dtoItem, g.before, item, g.stepMm)
      if (Object.keys(fields).length === 0) return
      g.chain = g.chain.then(async () => {
        const r = await call(
          'design.shape.item.update',
          { partId, shapeId: g.dto.id, index: g.index, ...fields },
          { gesture: g.id },
        )
        if (r.ok) g.sent = true
        else ui.getState().setShapeIssues({ shapeId: g.dto.id, issues: r.error.issues })
      })
    },
    [call, partId, ui],
  )

  // a gesture still open when the editor goes away is sent as it stands
  useEffect(
    () => () => {
      const g = current.current
      if (g !== null) flush(g)
      current.current = null
      ui.getState().setShapePreview(null)
    },
    [flush, ui],
  )

  return useCallback(
    (e: ShapeDragEvent) => {
      const s = ui.getState()
      const dto = shapeRef.current
      if (dto === undefined) return
      if (e.phase === 'start') {
        current.current = {
          id: newGestureId(),
          index: e.index,
          before: e.item,
          dto,
          pending: null,
          stepMm: e.stepMm,
          lastSent: 0,
          sent: false,
          timer: undefined,
          chain: Promise.resolve(),
        }
        s.setShapeIssues(null)
        return
      }
      const g = current.current
      if (g === null || g.index !== e.index) return
      if (e.phase === 'move') {
        g.stepMm = e.stepMm
        s.setShapePreview({ shapeId: g.dto.id, index: g.index, item: e.item })
        if (port !== undefined) {
          const def = definitionNumbers(g.dto.items)
          if (def !== undefined) {
            def[g.index] = e.item
            const r = resolveShape(port, def)
            if (r.isErr()) {
              s.setShapeIssues({ shapeId: g.dto.id, issues: r.unwrapErr().issues })
              g.pending = null
              clearTimeout(g.timer)
              g.timer = undefined
              return
            }
          }
        }
        if (s.shapeIssues !== null) s.setShapeIssues(null)
        g.pending = e.item
        const wait = SHAPE_COMMIT_MS - (performance.now() - g.lastSent)
        if (wait <= 0) flush(g)
        else g.timer ??= setTimeout(() => flush(g), wait)
        return
      }
      current.current = null
      if (e.phase === 'end') {
        flush(g)
        // an invalid end state is dropped: the drag stops at its last valid step
        void g.chain.then(() => {
          const now = ui.getState()
          now.setShapePreview(null)
          if (now.shapeIssues?.shapeId === g.dto.id && port !== undefined) now.setShapeIssues(null)
        })
        return
      }
      // cancel: nothing more goes out; what went out is reverted as one
      clearTimeout(g.timer)
      g.pending = null
      s.setShapePreview(null)
      s.setShapeIssues(null)
      void g.chain.then(() => (g.sent ? cancelGesture(g.id) : undefined))
    },
    [port, flush, cancelGesture, ui],
  )
}
