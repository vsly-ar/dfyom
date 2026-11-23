// The shell's viewport region (task 3.6): the one `Viewport` canvas, kept mounted across modes (no
// WebGL context churn); the mode decides the scene (`useModeScene`). Replaces the 3.3b
// placeholder `ViewportSlot`. In design mode a selected shape lays its flat view over the canvas
// (Shape Editor, task U1); in plan mode without a plan, the "Plan the part" card (DF29). Doc: docs/conventions/ui.md#app-shell, #viewport-task-35, #shape-editor
import type { AppMode } from '../../../core/modes'
import { ShapeEditorLayer } from '../modes/design/ShapeEditorView'
import { PlanStartOverlay } from '../modes/plan'
import { useModeScene } from '../modes/ModePanels'
import { Viewport } from '../viewport'
import styles from './AppShell.module.css'
import { useReplica, useUi } from './ShellContext'

export function ShellViewport({
  mode,
  insetRight = 0,
}: {
  mode: AppMode
  /** Px covered by the narrow-window inspector overlay (the view cube moves beside it). */
  insetRight?: number
}): React.JSX.Element {
  const scene = useModeScene(mode)
  const replica = useReplica()
  const doc = replica.status === 'open' ? replica.doc : undefined
  // the main toolbar's Measure (DF19) and the viewport share the tool's on state
  const measuring = useUi((s) => s.measuring)
  const setMeasuring = useUi((s) => s.setMeasuring)
  return (
    <>
      <Viewport
        {...scene}
        measuring={measuring && mode !== 'run'}
        onMeasuringChange={setMeasuring}
        insetRight={insetRight}
        className={styles['viewportCanvas']}
      />
      {mode === 'design' ? <ShapeEditorLayer insetRight={insetRight} /> : null}
      {mode === 'plan' && doc !== undefined ? (
        <PlanStartOverlay doc={doc} insetRight={insetRight} />
      ) : null}
    </>
  )
}
