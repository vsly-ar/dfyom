// Plan's part of the status bar (task 3.7): "Generating toolpaths…" while this window's job runs
// (after `--delay-indicator`), and the count of the plan's errors and warnings, which opens the
// list (a subject selects its plan operation). Doc: docs/conventions/ui.md#plan-mode-task-37,
// #warnings-and-dfm, #jobs-and-progress
import { CircleAlert, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import { planMessages } from '../../messages/plan'
import { Popover, StatusChip, WarningList } from '../../ui'
import { DELAY_INDICATOR_MS } from '../../viewport'
import { isError } from './model'
import { usePlanData, usePlanState } from './plan-store'
import { planWarningLabels, planWarningView } from './PlanInspector'
import styles from './Plan.module.css'
import { useChosenPlan, usePlanSelection } from './usePlan'

function useLate(on: boolean): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!on) return
    const t = setTimeout(() => setLate(true), DELAY_INDICATOR_MS)
    return () => {
      clearTimeout(t)
      setLate(false)
    }
  }, [on])
  return on && late
}

export function PlanStatus({ doc }: { doc: ProjectDoc }): React.JSX.Element | null {
  const [plan] = useChosenPlan(doc)
  const data = usePlanData(plan?.id)
  const [, select] = usePlanSelection()
  const generating = useLate(usePlanState((s) => s.generating) !== undefined)
  const [open, setOpen] = useState(false)
  if (plan === undefined) return null
  const warnings = data?.warnings ?? []
  const errors = warnings.filter(isError).length
  const n = warnings.length
  return (
    <>
      <span className={styles['statusSlot']} aria-live="polite">
        {generating ? (
          <StatusChip tone="busy">{planMessages.toolpaths.generating}</StatusChip>
        ) : null}
      </span>
      <Popover
        label={planMessages.warnings.title}
        title={planMessages.warnings.title}
        side="top"
        open={open}
        onOpenChange={setOpen}
        content={
          <div className={styles['statusWarnings']}>
            <WarningList
              labels={planWarningLabels}
              items={warnings.map((w, i) =>
                planWarningView(
                  w,
                  plan,
                  (id) => {
                    select(id)
                    setOpen(false)
                  },
                  i,
                ),
              )}
              empty={planMessages.warnings.none}
            />
          </div>
        }
      >
        <button type="button" className={styles['statusChipButton']}>
          {errors > 0 ? (
            <CircleAlert aria-hidden="true" className={styles['statusIcon']} data-error="" />
          ) : (
            <TriangleAlert
              aria-hidden="true"
              className={styles['statusIcon']}
              data-on={n > 0 || undefined}
            />
          )}
          {planMessages.warnings.count(errors, n - errors)}
        </button>
      </Popover>
    </>
  )
}
