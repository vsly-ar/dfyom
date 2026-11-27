// The workholding guard on the moves a dialog shows before they happen (hardening DF133 RW4, Q187):
// Go to, "Move to touch-off spot" and the recovery panel's "Go to last position". `useMoveGuard`
// runs the listed steps through the guard on every render (each field change); a contact is a
// finding under the steps ("Step 3 (down to Z 1.000) hits Toe clamp 2: the collet nut stops 2 mm
// above it at Z 14.200.") with the checkbox "Go anyway (the clamps are not where the plan says)",
// which the dialog resets when the move changes; "Jog past once" armed covers the move instead.
// Guard not on: no finding, the dialog as before.
// Doc: docs/modes/run-workholding.md#go-to-and-the-touch-off-spot, #implementation-rw4
import { useState } from 'react'
import type { GoToStep, Vec3 } from '../../../../core/run/goto'
import { runMessages } from '../../messages/run'
import { Checkbox, Icon } from '../../ui'
import { useRun } from './run-store'
import { guardActive, moveGuard, type MoveFinding } from './run-guard'
import styles from './Run.module.css'

const g = runMessages.guard

export interface MoveGuard {
  /** The first contact of the steps, while the guard is on. */
  readonly finding: MoveFinding | undefined
  /** "Jog past once" is armed: the next move goes unguarded (Q186). */
  readonly pastOnce: boolean
}

/** The steps `to` (MPos) from `from` through the guard, with the store's live guard state. */
export function useMoveGuard(from: Vec3, to: readonly Vec3[]): MoveGuard {
  const status = useRun((s) => s.status)
  const setup = useRun((s) => s.guardSetup)
  const off = useRun((s) => s.guardOff)
  const pastOnce = useRun((s) => s.pastOnceUntil !== undefined)
  const finding =
    to.length > 0 && guardActive(status, setup, off)
      ? moveGuard(status, setup, from, to)
      : undefined
  return { finding, pastOnce }
}

/**
 * "Go anyway" for one move: ticked for the move `key` (the steps' points), so it unticks itself
 * when the target or the path changes.
 */
export function useGoAnyway(key: string): [boolean, (on: boolean) => void] {
  const [ticked, setTicked] = useState<string | undefined>(undefined)
  return [ticked !== undefined && ticked === key, (on) => setTicked(on ? key : undefined)]
}

/** The finding's sentence; `shown(mm, axis)` formats a machine coordinate in the dialog's frame. */
export function findingText(
  f: MoveFinding,
  from: Vec3,
  steps: readonly GoToStep[],
  shown: (mm: number, axis: number) => string,
  gap: (mm: number) => string,
): string {
  const m = runMessages.goTo
  const k = f.hit.step
  const st = steps[k]!
  const start = k === 0 ? from : steps[k - 1]!.to
  const down = st.axis === 'z' && st.to[2] < start[2]
  const text =
    st.axis === 'xy'
      ? m.stepXY(shown(st.to[0], 0), shown(st.to[1], 1))
      : down
        ? m.stepDown(shown(st.to[2], 2))
        : m.stepUp(shown(st.to[2], 2))
  const step = text.charAt(0).toLowerCase() + text.slice(1)
  const part = g.part[f.hit.contact.part]
  if (f.hit.contact.gap === 0) return g.moveDeeper(k + 1, step, f.item, part)
  const stop = f.hit.stop
  const at =
    st.axis === 'z' ? `Z ${shown(stop[2], 2)}` : `X ${shown(stop[0], 0)} Y ${shown(stop[1], 1)}`
  // the gap to 0.1 mm: the stop is the margin less the guard's backoff, "2.01 mm" reads as noise
  const near = Math.round(f.hit.contact.gap * 10) / 10
  return g.moveHit(k + 1, step, f.item, part, gap(near), down ? 'above' : 'from', at)
}

/**
 * The finding under a dialog's steps, with "Go anyway" (or the past-once note); nothing without
 * a finding. `id` is for the action button's `aria-describedby`.
 */
export function MoveGuardFinding({
  id,
  text,
  guard,
  anyway,
  onAnyway,
  disabled = false,
}: {
  id: string
  text: string | undefined
  guard: MoveGuard
  anyway: boolean
  onAnyway: (on: boolean) => void
  disabled?: boolean
}): React.JSX.Element | null {
  if (guard.finding === undefined || text === undefined) return null
  return (
    <div className={styles['notice']} data-tone="danger" data-guard-finding="">
      <Icon name="warning" />
      <div>
        <p id={id} className={styles['why']}>
          {text}
          {guard.pastOnce ? ` ${g.anywayPastOnce}` : ''}
        </p>
        {guard.pastOnce ? null : (
          <Checkbox
            label={g.anyway}
            checked={anyway}
            disabled={disabled}
            onCheckedChange={(c) => onAnyway(c === true)}
          />
        )}
      </div>
    </div>
  )
}

/** Whether the move may go: no finding, "Go anyway" ticked, or "Jog past once" armed. */
export const mayGo = (guard: MoveGuard, anyway: boolean): boolean =>
  guard.finding === undefined || anyway || guard.pastOnce
