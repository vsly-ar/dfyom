// The shell's viewport region (task 3.6): the one `Viewport` canvas, kept mounted across modes (no
// WebGL context churn); the mode decides the scene (`useModeScene`). Replaces the 3.3b
// placeholder `ViewportSlot`. In design mode a selected shape lays its flat view over the canvas
// (Shape Editor, task U1). Doc: docs/conventions/ui.md#app-shell, #viewport-task-35, #shape-editor
import type { AppMode } from '../../../core/modes'
import { ShapeEditorLayer } from '../modes/design/ShapeEditorView'
import { useModeScene } from '../modes/ModePanels'
import { Viewport } from '../viewport'
import styles from './AppShell.module.css'

export function ShellViewport({
  mode,
  insetRight = 0,
}: {
  mode: AppMode
  /** Px covered by the narrow-window inspector overlay (the view cube moves beside it). */
  insetRight?: number
}): React.JSX.Element {
  const scene = useModeScene(mode)
  return (
    <>
      <Viewport {...scene} insetRight={insetRight} className={styles['viewportCanvas']} />
      {mode === 'design' ? <ShapeEditorLayer insetRight={insetRight} /> : null}
    </>
  )
}
