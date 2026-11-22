// The design scene of the shared viewport (task 3.6): the part's last good mesh and the stock,
// the evaluation status (outdated tint after 300 ms), the selection (synced with navigator and
// inspector), the live outline of the selected operation while pending (in its face frame), the
// error marker at the failing operation, pick mode for the inspector's fields (normal glyphs on
// every eligible face), and for the selected operation its face-frame axes (task F1) and anchor
// marker (task F2), and the visible references as ghosts (task R3).
// Doc: docs/conventions/ui.md#selection-and-picking, #evaluation-status-pending-outdated-failed,
// #design-and-plan-controls-v02, #reference-ghost-v02
import { useMemo } from 'react'
import { placedBox } from '../../../../core/design/reference'
import { useUi } from '../../shell/ShellContext'
import { designMessages } from '../../messages/design'
import { referenceMessages } from '../../messages/reference'
import type { ViewportProps } from '../../viewport'
import { failingOperation, surfaceLabel } from './model'
import { anchorPoint, frameAxes, markerPoint, operationFace, operationOutline } from './outline'
import { ghostMatrix, referencePlacement } from './reference-view'
import {
  useDesignEvaluation,
  useDesignPart,
  useDesignReferences,
  useDesignSelection,
  useDesignWarnings,
} from './useDesign'

export type SceneProps = Omit<ViewportProps, 'className' | 'mousePreset'>

export function useDesignScene(): SceneProps {
  const part = useDesignPart()
  const evaluation = useDesignEvaluation(part)
  const { warnings } = useDesignWarnings(part)
  const [selected, select] = useDesignSelection()
  const pick = useUi((s) => s.pick)
  const setPick = useUi((s) => s.setPick)
  const status = evaluation?.status ?? 'pending'
  const references = useDesignReferences(part)

  const ghosts = useMemo(
    () =>
      references.flatMap(({ ref, visible, mesh }) => {
        const p = referencePlacement(ref)
        if (!visible || mesh?.status !== 'done' || p === undefined) return []
        const matrix = ghostMatrix(ref.asset.bounds, p)
        const box = placedBox(ref.asset.bounds, p)
        return [
          {
            id: ref.id,
            positions: mesh.positions,
            matrix,
            box: {
              min: [box.min.x, box.min.y, box.min.z] as const,
              max: [box.max.x, box.max.y, box.max.z] as const,
            },
          },
        ]
      }),
    [references],
  )
  const referenceSummary = references
    .filter((r) => r.visible)
    .map((r) =>
      referenceMessages.viewport(
        r.ref.name,
        r.mesh?.status === 'done' ? 'done' : r.mesh?.status === 'failed' ? 'failed' : 'loading',
      ),
    )

  const stock = useMemo(() => {
    const s = part?.loaded?.stock
    return s === undefined
      ? null
      : {
          min: [0, 0, -s.thickness.canonical] as const,
          max: [s.length.canonical, s.width.canonical, 0] as const,
        }
  }, [part])

  const ops = part?.loaded?.part.operations
  const selectedOp = ops?.find((o) => o.id === selected)
  const overlays = useMemo(() => {
    if (selectedOp === undefined || part?.loaded === undefined || part.table === undefined)
      return null
    const s = part.loaded.stock
    const table = part.table
    const axes = frameAxes(selectedOp, s, table)
    const face = operationFace(selectedOp, s, table)
    return {
      outline: operationOutline(selectedOp, s, table),
      frame: { ...axes, labels: designMessages.inspector.frameAxes },
      anchor: anchorPoint(selectedOp, s, table),
      describe: designMessages.selectionSummary({
        name: selectedOp.name,
        on: surfaceLabel(part.dto, selectedOp.on),
        anchor:
          selectedOp.kind === 'pocket' || selectedOp.kind === 'profile'
            ? designMessages.anchorPoint(face.direction, selectedOp.shape.anchor)
            : undefined,
      }),
    }
  }, [selectedOp, part])

  const marker = useMemo(() => {
    if (status !== 'failed' || ops === undefined || part?.loaded === undefined || !part.table)
      return null
    const ids = ops.map((o) => o.id)
    const at =
      (evaluation?.error && failingOperation(evaluation.error, ids)) ?? selected ?? ids.at(-1)
    const op = ops.find((o) => o.id === at)
    return op === undefined ? null : markerPoint(op, part.loaded.stock, part.table)
  }, [status, ops, part, evaluation, selected])

  return {
    mesh: evaluation?.mesh ?? null,
    stock,
    status,
    selectedOperation: selected,
    outline: overlays?.outline ?? null,
    marker,
    frame: overlays?.frame ?? null,
    anchor: overlays?.anchor ?? null,
    ghosts,
    ...(part === undefined
      ? {}
      : {
          summary: [
            designMessages.viewportSummary({
              operations: part.dto.operations.length,
              warnings: warnings.length,
              status,
            }),
            overlays?.describe,
            ...referenceSummary,
          ]
            .filter(Boolean)
            .join(' '),
        }),
    onSelect: (target) =>
      select(target === null || target.operation === 'stock' ? null : target.operation),
    pick: pick === null ? null : { eligible: pick.eligible, field: pick.field },
    onPick: (target) => {
      pick?.onPick(target.surface)
      setPick(null)
    },
    onPickCancel: () => setPick(null),
  }
}
