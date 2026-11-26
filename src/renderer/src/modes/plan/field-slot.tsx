// A plan inspector field's place for a finding's target and its reveal (inspector-layout.md S5):
// `Slot` marks a field (`data-plan-field`, no box of its own), `revealPlanField` selects its tab,
// opens its accordion or More row and focuses it; `severityOf` is a tab's or accordion's problem.
// Doc: docs/conventions/inspector-layout.md#s5-implementation-notes
import type { ReactNode } from 'react'
import type { PlanWarning } from '../../../../core/plan/checks'
import { revealInInspector, type GroupSeverity } from '../../ui'
import styles from './Plan.module.css'

/** The worst of `findings` as a tab dot or a closed accordion's icon (notes do not count). */
export function severityOf(findings: readonly PlanWarning[]): GroupSeverity | undefined {
  if (findings.some((w) => w.severity === 'error')) return 'error'
  if (findings.some((w) => w.severity === 'warning')) return 'warning'
  return undefined
}

/**
 * A field's place for a finding's target (`tool`, `feedRate`, `strategy.helixDiameter`): no box
 * of its own (`display: contents`), so the inspector's field rhythm is unchanged.
 */
export function Slot({
  field,
  children,
}: {
  field: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div data-plan-field={field} className={styles['slot']}>
      {children}
    </div>
  )
}

/**
 * Reveals field `field` of the inspector under `root` – selects its tab, opens its accordion or
 * More row (`revealInInspector`, inspector-layout.md § Accordions) – and focuses its control.
 * False when the inspector has no such field (yet).
 */
export function revealPlanField(root: HTMLElement | null, field: string): boolean {
  const slot = root?.querySelector<HTMLElement>(`[data-plan-field="${field}"]`)
  const control = slot?.querySelector<HTMLElement>(
    'input, [role="combobox"], [role="radio"][data-state="checked"], button',
  )
  if (slot == null || control == null) return false
  revealInInspector(slot)
  const show = () => {
    control.focus()
    control.scrollIntoView?.({ block: 'nearest' })
  }
  show()
  // the tab or accordion opens on React's next commit: a hidden control can't take focus yet
  if (document.activeElement !== control) requestAnimationFrame(show)
  return true
}
