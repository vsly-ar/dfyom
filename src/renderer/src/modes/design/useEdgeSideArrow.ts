// The side arrow of a selected one-sided chamfer (DF147 SL4 follow-up): its geometry from
// `edge-side.ts`, the side names as the inspector shows them, and a pick that keeps the clicked
// side (`design.chamfer.update` `{ edgeSide }`, one undo step). A Clones instance is locked.
// Doc: docs/conventions/ui.md#chamfer-inspector
import { useMemo } from 'react'
import type { OperationDTO } from '../../../../core/design/part.dto'
import { chamferMessages } from '../../messages/chamfer'
import { useRegion2d } from '../../shell/ShellContext'
import type { EdgeSideArrowView } from '../../viewport/EdgeSideArrow'
import { edgeSideNames } from './chamfer-view'
import { edgeSideGeometry } from './edge-side'
import type { DesignPart } from './model'
import { useCommand } from './useDesign'

const t = chamferMessages

export function useEdgeSideArrow(
  part: DesignPart | undefined,
  op: OperationDTO | undefined,
): EdgeSideArrowView | null {
  const port = useRegion2d()
  const call = useCommand()
  return useMemo(() => {
    if (part === undefined || op?.kind !== 'chamfer' || op.edgeSide === undefined) return null
    const edge = part.dto.operations.find((o) => o.id === op.edgeOf)
    const g = edge === undefined ? undefined : edgeSideGeometry(part, op.id, port)
    if (g === undefined || edge === undefined) return null
    const names = edgeSideNames(part.dto, edge) === 'loop' ? t.edgeSidesLoop : t.edgeSides
    return {
      kept: g.kept,
      arrows: g.arrows,
      strips: g.strips,
      labels: { left: t.edgeSideStays(names.left), right: t.edgeSideStays(names.right) },
      locked: op.featureId !== undefined,
      onPick: (side) =>
        void call('design.chamfer.update', {
          partId: part.dto.id,
          operationId: op.id,
          edgeSide: side,
        }),
    }
  }, [part, op, port, call])
}
