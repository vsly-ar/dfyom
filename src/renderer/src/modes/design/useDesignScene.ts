// The design scene of the shared viewport (task 3.6): the part's last good mesh and the stock,
// the evaluation status (outdated tint after 300 ms), the selection (synced with navigator and
// inspector), the live outline of the selected operation while pending, the error marker at the
// failing operation, and pick mode for the inspector's fields.
// Doc: docs/conventions/ui.md#selection-and-picking, #evaluation-status-pending-outdated-failed
import { useMemo } from 'react'
import { useUi } from '../../shell/ShellContext'
import { designMessages } from '../../messages/design'
import type { ViewportProps } from '../../viewport'
import { failingOperation } from './model'
import { operationAnchor, operationOutline } from './outline'
import {
  useDesignEvaluation,
  useDesignPart,
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
  const outline = useMemo(() => {
    const op = ops?.find((o) => o.id === selected)
    if (op === undefined || part?.loaded === undefined || part.table === undefined) return null
    return operationOutline(op, part.loaded.stock, part.table)
  }, [ops, selected, part])

  const marker = useMemo(() => {
    if (status !== 'failed' || ops === undefined || part?.loaded === undefined || !part.table)
      return null
    const ids = ops.map((o) => o.id)
    const at =
      (evaluation?.error && failingOperation(evaluation.error, ids)) ?? selected ?? ids.at(-1)
    const op = ops.find((o) => o.id === at)
    return op === undefined ? null : operationAnchor(op, part.loaded.stock, part.table)
  }, [status, ops, part, evaluation, selected])

  return {
    mesh: evaluation?.mesh ?? null,
    stock,
    status,
    selectedOperation: selected,
    outline,
    marker,
    ...(part === undefined
      ? {}
      : {
          summary: designMessages.viewportSummary({
            operations: part.dto.operations.length,
            warnings: warnings.length,
            status,
          }),
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
