// Placeholder for the 3D viewport in the shell's centre region until task 3.5 lands
// (src/renderer/src/viewport/, `Viewport`). Swap it in AppShell with one line:
// `<ViewportSlot mode={mode} />` → `<Viewport />`. Doc: docs/conventions/ui.md#app-shell
import type { AppMode } from '../../../core/modes'
import { shellMessages as m } from '../messages/shell'
import styles from './AppShell.module.css'

export function ViewportSlot({ mode }: { mode: AppMode }): React.JSX.Element {
  return (
    <div className={styles['viewportSlot']} data-mode={mode}>
      <span className={styles['viewportLabel']}>{m.viewport.placeholder}</span>
      <span className={styles['viewportNote']}>{m.viewport.placeholderNote}</span>
    </div>
  )
}
