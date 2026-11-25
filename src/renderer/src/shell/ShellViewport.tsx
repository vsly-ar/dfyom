// The shell's viewport region (task 3.6): the one `Viewport` canvas, kept mounted across modes (no
// WebGL context churn); the mode decides the scene (`useModeScene`). Replaces the 3.3b
// placeholder `ViewportSlot`. Shapes are edited in their own window (DF94), so the canvas keeps the
// 3D view while they change; in plan mode without a plan, the "Plan the part" card (DF29); in run
// mode the gCode panel at the bottom, the canvas shortened above it (DF84). Toasts
// show here, bottom-centre over the view, never over the side panels (DF45). Doc: docs/conventions/ui.md#app-shell, #viewport-task-35, #shape-editor-window-df94
import type { AppMode } from '../../../core/modes'
import { CompareLegend } from '../modes/design/ReferenceCompare'
import { PlanStartOverlay } from '../modes/plan'
import { GcodePanel } from '../modes/run/GcodePanel'
import { useModeScene } from '../modes/ModePanels'
import { ToastAnchor } from '../ui'
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
      {mode === 'design' ? <CompareLegend /> : null}
      {mode === 'plan' && doc !== undefined ? (
        <PlanStartOverlay doc={doc} insetRight={insetRight} />
      ) : null}
      {mode === 'run' ? <GcodePanel insetRight={insetRight} /> : null}
      <ToastAnchor insetRight={insetRight} />
    </>
  )
}
