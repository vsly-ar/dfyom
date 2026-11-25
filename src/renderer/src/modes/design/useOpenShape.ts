// Opening a shape in the Shape Editor (DF94): from a project window it opens (or focuses) the
// project's Shape Editor window on the shape; inside that window it switches the edited shape.
// Every entry point (a Shapes dialog row, Add shape, the import report's "Edit shape", the
// operation inspector's "Edit shape" and "New shape…") goes through it.
// Doc: docs/conventions/ui.md#shape-editor-window-df94
import { useCallback } from 'react'
import { useShell } from '../../shell/ShellContext'

/** Opens `shapeId` of part `partId` in the Shape Editor (its first item selected). */
export function useOpenShape(): (partId: string, shapeId: string) => void {
  const { bridge, ui } = useShell()
  return useCallback(
    (partId: string, shapeId: string) => {
      if (bridge.windowKind !== 'shapes') {
        void bridge.shapeEditor.open({ partId, shapeId })
        return
      }
      const s = ui.getState()
      if (s.designPart !== partId) s.setDesignPart(partId)
      s.selectShapeItem(shapeId, 0)
      s.select('design', shapeId)
    },
    [bridge, ui],
  )
}
