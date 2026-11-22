// The shell's viewport region (task 3.6): the one `Viewport` canvas, kept mounted across modes (no
// WebGL context churn); the mode decides the scene (`useModeScene`). Replaces the 3.3b
// placeholder `ViewportSlot`. Doc: docs/conventions/ui.md#app-shell, #viewport-task-35
import type { AppMode } from '../../../core/modes'
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
  return <Viewport {...scene} insetRight={insetRight} className={styles['viewportCanvas']} />
}
