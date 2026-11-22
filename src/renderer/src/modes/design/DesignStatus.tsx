// Design's part of the status bar (task 3.6): the evaluation status ("Updating…" only after
// `--delay-indicator`, an error chip that selects the failing operation) and the warning count,
// which opens the warning list. Doc: docs/conventions/ui.md#evaluation-status-pending-outdated-failed,
// #warnings-and-dfm, #app-shell
import { useEffect, useState } from 'react'
import { designMessages } from '../../messages/design'
import { dfmMessages } from '../../messages/dfm'
import { Icon, Popover, StatusChip, WarningList } from '../../ui'
import { DELAY_INDICATOR_MS } from '../../viewport'
import { warningLabels, warningView } from './DesignInspector'
import { pendingApply } from './model'
import styles from './Design.module.css'
import { failingOperation } from './model'
import {
  useCommand,
  useDesignEvaluation,
  useDesignPart,
  useDesignSelection,
  useDesignWarnings,
} from './useDesign'
import { updateArgs } from './model'

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

export function DesignStatus(): React.JSX.Element | null {
  const part = useDesignPart()
  const evaluation = useDesignEvaluation(part)
  const warnings = useDesignWarnings(part)
  const [, select] = useDesignSelection()
  const call = useCommand()
  const [open, setOpen] = useState(false)
  const updating = useLate(evaluation?.status === 'pending')
  if (part === undefined) return null
  const status = evaluation?.status
  const ids = part.dto.operations.map((o) => o.id)
  const failedAt =
    status === 'failed' && evaluation?.error ? failingOperation(evaluation.error, ids) : undefined
  const failedName = part.dto.operations.find((o) => o.id === failedAt)?.name
  // warnings Apply may change are not counted until applied (apply.md#stale-derived-results)
  const n = warnings.warnings.filter((w) => !pendingApply(w)).length

  return (
    <>
      <span className={styles['statusSlot']} aria-live="polite">
        {status === 'failed' ? (
          <button
            type="button"
            className={styles['statusChipButton']}
            onClick={() => {
              if (failedAt !== undefined) select(failedAt)
            }}
          >
            <StatusChip tone="danger">
              {failedName === undefined
                ? designMessages.evaluation.failed
                : designMessages.evaluation.failedAt(failedName)}
            </StatusChip>
          </button>
        ) : updating ? (
          <StatusChip tone="busy">{designMessages.evaluation.updating}</StatusChip>
        ) : status === 'done' ? (
          <span className={styles['srOnly']}>{designMessages.evaluation.done}</span>
        ) : null}
      </span>
      <Popover
        label={dfmMessages.listTitle}
        title={dfmMessages.listTitle}
        side="top"
        open={open}
        onOpenChange={setOpen}
        content={
          <div className={styles['statusWarnings']}>
            <WarningList
              labels={warningLabels}
              items={warnings.warnings.map((w) =>
                warningView(
                  w,
                  part,
                  (warning, source) => {
                    const op = part.dto.operations.find((o) => o.id === warning.operation)
                    if (op === undefined || warning.parameter === undefined) return
                    void call(`design.${op.kind}.update`, {
                      partId: part.dto.id,
                      operationId: op.id,
                      ...updateArgs(op, warning.parameter, source),
                    })
                  },
                  (id) => {
                    select(id)
                    setOpen(false)
                  },
                ),
              )}
              empty={dfmMessages.none}
              {...(warnings.evaluation === 'pending' ? { note: dfmMessages.checksPending } : {})}
            />
          </div>
        }
      >
        <button type="button" className={styles['statusChipButton']}>
          <Icon name="warning" className={styles['statusIcon']} data-on={n > 0 || undefined} />
          {dfmMessages.count(n)}
        </button>
      </Popover>
    </>
  )
}
