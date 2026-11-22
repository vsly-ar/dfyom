// Shape hooks over the shell (task U1): the part's shapes as `design.shape.list` gives them and the
// selected shape as `design.shape.get` gives it (definition, users, resolved loops or issues),
// both re-read after every revision; the selected shape id. The renderer loads and shows shapes
// through these queries; the inspector's field values come from the replica (same revision).
// Doc: docs/modes/design-v0.3.md#commands-and-queries-v03, docs/conventions/ui.md#shape-editor
import { useEffect, useState } from 'react'
import type { ShapeDTO } from '../../../../core/design/shape.dto'
import type { ShapeSummary } from '../../../../core/design/shape'
import type { Issue } from '../../../../shared/errors/app-error'
import { useReplica, useShell } from '../../shell/ShellContext'
import type { DesignPart } from './model'

export interface ShapeRow {
  readonly id: string
  readonly name: string
  readonly items: number
  readonly usedBy: readonly string[]
  /** Absent: the shape does not resolve. */
  readonly kind?: 'region' | 'path'
  readonly area?: number
  readonly bounds?: { readonly min: readonly [number, number]; readonly max: readonly [number, number] }
}

export interface ShapeInfo {
  readonly shape: ShapeDTO
  readonly usedBy: readonly string[]
  readonly resolved?: ShapeSummary
  readonly issues?: readonly Issue[]
}

const SHAPE_ID = /^shape[1-9][0-9]*$/

/** Whether a design selection is a shape. */
export const isShapeId = (id: string | null | undefined): id is string =>
  id != null && SHAPE_ID.test(id)

/** One query result, re-read when `tag` changes; the previous value stays until the next arrives. */
function useQuery<T>(name: string, args: object | undefined, tag: string): T | undefined {
  const { bridge } = useShell()
  const [value, setValue] = useState<{ tag: string; value: T } | undefined>(undefined)
  const key = args === undefined ? undefined : `${tag}:${JSON.stringify(args)}`
  useEffect(() => {
    if (key === undefined || args === undefined) return
    let live = true
    void bridge.call(name, args).then((r) => {
      if (live) setValue(r.ok ? { tag: key, value: r.value as T } : undefined)
    })
    return () => {
      live = false
    }
    // `key` covers `args`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, name, key])
  return key === undefined ? undefined : value?.value
}

function useRevisionTag(): string {
  const replica = useReplica()
  return replica.status === 'open' ? `${replica.key}:${replica.revision}` : ''
}

/** The part's shapes (`design.shape.list`): rows of the navigator's Shapes group. */
export function useShapeList(part: DesignPart | undefined): readonly ShapeRow[] {
  const tag = useRevisionTag()
  const hasShapes = (part?.dto.shapes?.length ?? 0) > 0
  const r = useQuery<{ shapes: ShapeRow[] }>(
    'design.shape.list',
    part === undefined || !hasShapes ? undefined : { partId: part.dto.id },
    tag,
  )
  return hasShapes ? (r?.shapes ?? []) : []
}

/** The selected shape (`design.shape.get`), or undefined until it arrives. */
export function useShapeInfo(part: DesignPart | undefined, shapeId: string | null): ShapeInfo | undefined {
  const tag = useRevisionTag()
  const exists = part?.dto.shapes?.some((s) => s.id === shapeId) ?? false
  const info = useQuery<ShapeInfo>(
    'design.shape.get',
    part === undefined || !exists || shapeId === null ? undefined : { partId: part.dto.id, shapeId },
    tag,
  )
  return info?.shape.id === shapeId ? info : undefined
}
