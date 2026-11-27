// The live clearance chip under the Position table (hardening DF133 RW5, Q192): "Clear: 14 mm to
// Toe clamp 2 (collet nut)", the nearest item to the tool and holder at the current position,
// neutral, amber under 2 × margin, red at or within the margin ("Within the margin: …"); updated
// with each status report. The chip itself is not live: a visually hidden polite status says the
// item and its colour only, so a screen reader hears a change of item or colour, not every report.
// Absent while the guard cannot vouch for the items (the status line above says why).
// Doc: docs/modes/run-workholding.md#live-clearance, #implementation-rw5
import type { UnitSystem } from '../../../../core/project/document'
import { lengthSource } from '../../messages/dfm'
import { runMessages } from '../../messages/run'
import { useLiveClearance } from './useLiveClearance'
import styles from './Run.module.css'

const g = runMessages.guard

export function ClearanceChip({ units }: { units: UnitSystem }): React.JSX.Element | null {
  const live = useLiveClearance()
  if (live === undefined) return null
  const n = live.clearance.nearest
  // to 0.1 mm: the status reports 0.001 mm, the chip is a glance
  const gap = lengthSource(Math.round(n.gap * 10) / 10, units)
  const part = g.part[n.part]
  return (
    <>
      <p className={styles['clearance']} data-clearance={n.tone} data-item={n.itemId}>
        {n.tone === 'inside'
          ? g.clearanceInside(gap, n.item, part)
          : g.clearance(gap, n.item, part)}
      </p>
      <p className={styles['srOnly']} role="status">
        {g.clearanceSays[n.tone](n.item)}
      </p>
    </>
  )
}
